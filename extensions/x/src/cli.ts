/**
 * `bitterbot x ...` operator commands.
 *
 *   login            OAuth 2.0 PKCE authorization (opens a browser)
 *   logout           delete the stored token
 *   status           offline token status (no billed API calls)
 *   whoami           GET /2/users/me (billed) and cache the handle
 *   post <text>      human-triggered post; still goes through the policy gate
 *   delete <id>      delete a post by id
 *   ledger           print recent posts from the local ledger
 *   kill | resume    emergency stop for all posting (file switch)
 *   journal install  create the recurring "anything worth saying?" cron job
 *   journal remove   delete that cron job
 *   journal show     print the prompt the job uses
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotPluginCliContext } from "../../../src/plugins/types.js";
import { deletePost, getMe } from "./api.js";
import { DEFAULT_ACCOUNT_ID, getAccountConfig, normalizeHandle, resolvePolicy } from "./config.js";
import { buildJournalCronParams, buildJournalPrompt, X_JOURNAL_JOB_NAME } from "./journal.js";
import { ledgerWindowStart, readLedger } from "./ledger.js";
import { loginWithBrowser } from "./oauth.js";
import { isKillSwitchOn, xOutbound } from "./outbound.js";
import { resolveKillSwitchPath, resolveTokenFilePath } from "./paths.js";
import { evaluatePolicy } from "./policy.js";
import { probeX } from "./status.js";
import { deleteTokenRecord, readTokenRecord, writeTokenRecord } from "./token-store.js";

type Out = {
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
};

async function loadOut(): Promise<Out> {
  const { defaultRuntime } = await import("../../../src/runtime.js");
  return {
    log: (m) => defaultRuntime.log(m),
    error: (m) => defaultRuntime.error(m),
    exit: (code) => defaultRuntime.exit(code),
  };
}

/** Run an action; print a one-line error and exit 1 instead of a stack trace. */
function guarded<A extends unknown[]>(fn: (out: Out, ...args: A) => Promise<void>) {
  return async (...args: A): Promise<void> => {
    const out = await loadOut();
    try {
      await fn(out, ...args);
    } catch (err) {
      out.error(err instanceof Error ? err.message : String(err));
      out.exit(1);
    }
  };
}

function requireAccount(ctx: BitterbotPluginCliContext, accountId: string) {
  const account = getAccountConfig(ctx.config, accountId);
  if (!account) {
    throw new Error(
      `X account "${accountId}" is not configured. Add channels.x.clientId (and clientSecret for a confidential app) to bitterbot.json.`,
    );
  }
  return account;
}

function displayHandle(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^@/, "");
  return trimmed || undefined;
}

type AccountOpts = { account: string };

export function registerXCli(ctx: BitterbotPluginCliContext): void {
  const x = ctx.program
    .command("x")
    .description("X (Twitter) channel: login, status, posting controls");
  const withAccount = (cmd: ReturnType<typeof x.command>) =>
    cmd.option("--account <id>", "Account id", DEFAULT_ACCOUNT_ID);

  withAccount(
    x
      .command("login")
      .description("Authorize the bot account via OAuth 2.0 PKCE (opens a browser)"),
  )
    .option("--port <port>", "Loopback callback port", (v) => Number.parseInt(v, 10))
    .action(
      guarded(async (out, opts: AccountOpts & { port?: number }) => {
        const account = requireAccount(ctx, opts.account);
        const { openUrl } = await import("../../../src/commands/onboard-helpers.js");
        const record = await loginWithBrowser({ account, port: opts.port, openUrl, log: out.log });
        const tokenFile = resolveTokenFilePath({
          accountId: opts.account,
          override: account.tokenFile,
        });
        await writeTokenRecord(tokenFile, record);
        out.log(`Token stored at ${tokenFile} (scope: ${record.scope ?? "?"}).`);
        try {
          const me = await getMe({ account, accountId: opts.account });
          await writeTokenRecord(tokenFile, { ...record, userId: me.id, username: me.username });
          out.log(`Authorized as @${me.username} (${me.id}).`);
          const expected = normalizeHandle(account.handle);
          if (expected && expected !== me.username.toLowerCase()) {
            out.error(
              `WARNING: config says handle "${expected}" but the authorized account is @${me.username}. Log out of X in the browser and retry if this is wrong.`,
            );
          }
        } catch (err) {
          out.error(
            `Could not read the account profile (${err instanceof Error ? err.message : String(err)}); posting will still work.`,
          );
        }
      }),
    );

  withAccount(x.command("logout").description("Delete the stored OAuth token")).action(
    guarded(async (out, opts: AccountOpts) => {
      const account = requireAccount(ctx, opts.account);
      const tokenFile = resolveTokenFilePath({
        accountId: opts.account,
        override: account.tokenFile,
      });
      const removed = await deleteTokenRecord(tokenFile);
      out.log(removed ? `Removed ${tokenFile}` : `No token at ${tokenFile}`);
    }),
  );

  withAccount(x.command("status").description("Show token status and policy (no API calls)"))
    .option("--json", "Output JSON")
    .action(
      guarded(async (out, opts: AccountOpts & { json?: boolean }) => {
        const account = requireAccount(ctx, opts.account);
        const probe = await probeX(account, opts.account);
        const killed = await isKillSwitchOn();
        const policy = resolvePolicy(account);
        const recent = await readLedger({
          accountId: opts.account,
          sinceMs: Date.now() - 86_400_000,
        });
        const summary = {
          accountId: opts.account,
          enabled: account.enabled !== false,
          killSwitch: killed,
          authorized: probe.authorized,
          username: probe.username,
          expiresAt: probe.expiresAt ? new Date(probe.expiresAt).toISOString() : null,
          hasRefreshToken: probe.hasRefreshToken,
          tokenFile: probe.tokenFile,
          postsLast24h: recent.length,
          policy,
        };
        if (opts.json) {
          out.log(JSON.stringify(summary, null, 2));
          return;
        }
        out.log(`X account: ${opts.account}${probe.username ? ` (@${probe.username})` : ""}`);
        out.log(
          `  enabled: ${summary.enabled}   kill switch: ${killed ? "ON (posting halted)" : "off"}`,
        );
        out.log(
          `  authorized: ${probe.authorized}${probe.error ? ` (${probe.error})` : ""}   refresh token: ${probe.hasRefreshToken}`,
        );
        out.log(`  access token expires: ${summary.expiresAt ?? "-"}`);
        out.log(`  posts in last 24h: ${recent.length}/${policy.maxPostsPerDay}`);
        out.log(`  policy: ${JSON.stringify(policy)}`);
      }),
    );

  withAccount(
    x
      .command("whoami")
      .description("Fetch the authorized profile from X (billed read) and cache the handle"),
  ).action(
    guarded(async (out, opts: AccountOpts) => {
      const account = requireAccount(ctx, opts.account);
      const me = await getMe({ account, accountId: opts.account });
      const tokenFile = resolveTokenFilePath({
        accountId: opts.account,
        override: account.tokenFile,
      });
      const record = await readTokenRecord(tokenFile);
      if (record) {
        await writeTokenRecord(tokenFile, { ...record, userId: me.id, username: me.username });
      }
      out.log(`@${me.username} (${me.id})${me.name ? ` "${me.name}"` : ""}`);
    }),
  );

  withAccount(
    x
      .command("post <text>")
      .description("Post to the timeline (human-triggered; policy gate still applies)"),
  )
    .option("--reply-to <postId>", "Reply to a post id (requires policy.allowReplies)")
    .option("--dry-run", "Evaluate the policy gate without posting")
    .action(
      guarded(
        async (out, text: string, opts: AccountOpts & { replyTo?: string; dryRun?: boolean }) => {
          const account = requireAccount(ctx, opts.account);
          if (opts.dryRun) {
            const policy = resolvePolicy(account);
            const history = await readLedger({
              accountId: opts.account,
              sinceMs: ledgerWindowStart(policy.dedupeWindowDays),
            });
            const verdict = evaluatePolicy({
              text,
              replyToId: opts.replyTo,
              policy,
              history,
              selfHandle: normalizeHandle(account.handle),
            });
            out.log(
              verdict.ok
                ? `OK (${verdict.weightedLength} weighted chars)`
                : `BLOCKED: ${verdict.reason}`,
            );
            return;
          }
          const result = await xOutbound.sendText!({
            cfg: ctx.config,
            to: opts.replyTo ? `reply:${opts.replyTo}` : "timeline",
            text,
            accountId: opts.account,
          });
          const url = (result.meta as { url?: string } | undefined)?.url ?? "";
          out.log(`Posted ${result.messageId}: ${url}`);
        },
      ),
    );

  withAccount(x.command("delete <postId>").description("Delete a post by id")).action(
    guarded(async (out, postId: string, opts: AccountOpts) => {
      const account = requireAccount(ctx, opts.account);
      const deleted = await deletePost({ account, accountId: opts.account }, postId);
      out.log(deleted ? `Deleted ${postId}` : `X did not confirm deletion of ${postId}`);
    }),
  );

  withAccount(x.command("ledger").description("Print recent posts from the local ledger"))
    .option("--days <n>", "Window in days", (v) => Number.parseInt(v, 10), 7)
    .option("--json", "Output JSON")
    .action(
      guarded(async (out, opts: AccountOpts & { days: number; json?: boolean }) => {
        const entries = await readLedger({
          accountId: opts.account,
          sinceMs: Date.now() - opts.days * 86_400_000,
        });
        if (opts.json) {
          out.log(JSON.stringify(entries, null, 2));
          return;
        }
        if (entries.length === 0) {
          out.log(`No posts in the last ${opts.days} day(s).`);
          return;
        }
        for (const e of entries) {
          out.log(
            `${new Date(e.ts).toISOString()}  ${e.kind}  ${e.id}  ${e.text.replace(/\s+/g, " ")}`,
          );
        }
      }),
    );

  x.command("kill")
    .description("Halt ALL X posting immediately (creates the kill-switch file)")
    .action(
      guarded(async (out) => {
        const file = resolveKillSwitchPath();
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
        out.log(`Kill switch ON: ${file}`);
      }),
    );

  x.command("resume")
    .description("Lift the kill switch")
    .action(
      guarded(async (out) => {
        await fs.rm(resolveKillSwitchPath(), { force: true });
        out.log("Kill switch off.");
      }),
    );

  const journal = x
    .command("journal")
    .description("Manage the recurring 'anything worth saying?' agent tick");

  withAccount(
    journal
      .command("install")
      .description("Create the cron job (requires the gateway to be running)"),
  )
    .option("--every <duration>", "Interval between ticks (e.g. 4h)", "4h")
    .option("--agent <agentId>", "Pin the job to an agent")
    .action(
      guarded(async (out, opts: AccountOpts & { every: string; agent?: string }) => {
        const account = requireAccount(ctx, opts.account);
        const tokenFile = resolveTokenFilePath({
          accountId: opts.account,
          override: account.tokenFile,
        });
        const record = await readTokenRecord(tokenFile);
        const handle = displayHandle(account.handle) ?? displayHandle(record?.username);
        const { callGateway } = await import("../../../src/gateway/call.js");
        const params = buildJournalCronParams({ every: opts.every, handle, agentId: opts.agent });
        const job = await callGateway<{ id?: string; jobId?: string }>({
          method: "cron.add",
          params,
          config: ctx.config,
        });
        out.log(
          `Installed cron job ${job.id ?? job.jobId ?? "?"} (${X_JOURNAL_JOB_NAME}, every ${opts.every}).`,
        );
      }),
    );

  journal
    .command("remove")
    .description("Delete the journal cron job(s)")
    .action(
      guarded(async (out) => {
        const { callGateway } = await import("../../../src/gateway/call.js");
        const listed = await callGateway<{
          jobs?: Array<{ id?: string; jobId?: string; name?: string; label?: string }>;
        }>({ method: "cron.list", params: { includeDisabled: true }, config: ctx.config });
        const jobs = (listed.jobs ?? []).filter((j) => (j.name ?? j.label) === X_JOURNAL_JOB_NAME);
        if (jobs.length === 0) {
          out.log("No journal job found.");
          return;
        }
        for (const job of jobs) {
          const id = job.id ?? job.jobId;
          await callGateway({
            method: "cron.remove",
            params: { id, jobId: id },
            config: ctx.config,
          });
          out.log(`Removed ${id}`);
        }
      }),
    );

  withAccount(
    journal.command("show").description("Print the prompt used by the journal tick"),
  ).action(
    guarded(async (out, opts: AccountOpts) => {
      const account = getAccountConfig(ctx.config, opts.account);
      out.log(buildJournalPrompt({ handle: displayHandle(account?.handle) }));
    }),
  );
}
