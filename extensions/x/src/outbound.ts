/**
 * X outbound adapter. Every send goes: kill switch -> account enabled ->
 * target parse -> policy gate (ledger-backed) -> X API -> ledger append.
 *
 * Targets: "timeline" | "me" | "self" | "" | "@<own handle>" post to the
 * bot's own timeline; "reply:<postId>" replies (only if policy.allowReplies).
 */

import { withFileLock } from "bitterbot/plugin-sdk";
import fs from "node:fs/promises";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  OutboundDeliveryResult,
  XPostTarget,
} from "./types.js";
import { createPost } from "./api.js";
import { DEFAULT_ACCOUNT_ID, getAccountConfig, normalizeHandle, resolvePolicy } from "./config.js";
import { appendLedger, ledgerWindowStart, readLedger } from "./ledger.js";
import { resolveKillSwitchPath, resolveLedgerPath, resolveTokenFilePath } from "./paths.js";
import { evaluatePolicy } from "./policy.js";
import { X_MAX_WEIGHTED_LENGTH } from "./text.js";
import { readTokenRecord } from "./token-store.js";

export const X_TARGET_HINT =
  'use target "timeline" for an original post, or "reply:<postId>" (replies are off by default)';

export function parseXTarget(
  raw: string | undefined | null,
  selfHandle?: string,
): XPostTarget | null {
  const trimmed = (raw ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === "timeline" || lower === "me" || lower === "self" || lower === "x") {
    return { kind: "timeline" };
  }
  if (selfHandle && lower.replace(/^@/, "") === selfHandle) {
    return { kind: "timeline" };
  }
  const reply = /^reply:\s*(\d{5,25})$/i.exec(trimmed);
  if (reply) {
    return { kind: "reply", postId: reply[1] };
  }
  return null;
}

export async function isKillSwitchOn(env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await fs.access(resolveKillSwitchPath(env));
    return true;
  } catch {
    return false;
  }
}

export const xOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: X_MAX_WEIGHTED_LENGTH,
  /** Never split a post into a thread; over-length posts are rejected by the gate. */
  chunker: (text: string) => [text],
  chunkerMode: "text",

  resolveTarget: ({ cfg, to, accountId, mode }) => {
    // X has no inbound side, so there is never an implicit "last route" to
    // reply to, and heartbeat acks must never become public posts.
    if (mode === "heartbeat" || mode === "implicit") {
      return {
        ok: false,
        error: new Error(`X only accepts explicit targets (${mode} delivery is not allowed)`),
      };
    }
    const account = cfg ? getAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID) : null;
    const target = parseXTarget(to, normalizeHandle(account?.handle));
    if (!target) {
      return {
        ok: false,
        error: new Error(`Unsupported X target "${to ?? ""}": ${X_TARGET_HINT}`),
      };
    }
    return { ok: true, to: target.kind === "reply" ? `reply:${target.postId}` : "timeline" };
  },

  sendText: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    const { cfg, to, text } = params;
    const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
    const signal = (params as { signal?: AbortSignal }).signal;
    if (signal?.aborted) {
      throw new Error("Outbound delivery aborted");
    }
    if (await isKillSwitchOn()) {
      throw new Error(
        "X posting is halted by the kill switch (run `bitterbot x resume` to lift it)",
      );
    }
    const account = getAccountConfig(cfg, accountId);
    if (!account) {
      throw new Error(
        `X account not configured: ${accountId}. Add channels.x.clientId and run \`bitterbot x login\`.`,
      );
    }
    if (account.enabled === false) {
      throw new Error("X channel is disabled (channels.x.enabled=false)");
    }
    const tokenFile = resolveTokenFilePath({ accountId, override: account.tokenFile });
    const record = await readTokenRecord(tokenFile);
    const selfHandle = normalizeHandle(account.handle) ?? normalizeHandle(record?.username);

    const target = parseXTarget(to, selfHandle);
    if (!target) {
      throw new Error(`Unsupported X target "${to}": ${X_TARGET_HINT}`);
    }
    const replyToId = params.replyToId
      ? String(params.replyToId)
      : target.kind === "reply"
        ? target.postId
        : undefined;

    const policy = resolvePolicy(account);
    const ledgerPath = resolveLedgerPath({ accountId });
    // Gate + post + append run under the ledger lock so a CLI post and an
    // agent post cannot both pass the daily cap at the same instant.
    return withFileLock(
      ledgerPath,
      { retries: { retries: 40, factor: 1.5, minTimeout: 50, maxTimeout: 1000 }, stale: 60_000 },
      async () => {
        const history = await readLedger({
          accountId,
          sinceMs: ledgerWindowStart(policy.dedupeWindowDays),
          ledgerPath,
        });
        const verdict = evaluatePolicy({ text, replyToId, policy, history, selfHandle });
        if (!verdict.ok) {
          throw new Error(`X post blocked by policy: ${verdict.reason}`);
        }

        const result = await createPost(
          { account, accountId },
          { text: text.trim(), replyToId, username: record?.username ?? selfHandle },
        );
        await appendLedger(
          {
            ts: Date.now(),
            id: result.id,
            kind: replyToId ? "reply" : "post",
            text: text.trim(),
            replyToId,
            url: result.url,
            accountId,
          },
          ledgerPath,
        );
        return {
          channel: "x",
          messageId: result.id,
          timestamp: Date.now(),
          meta: { url: result.url, weightedLength: verdict.weightedLength },
        };
      },
    );
  },

  /** X media upload is not implemented; media is refused rather than silently dropped. */
  sendMedia: async (params: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    if (params.mediaUrl) {
      throw new Error("X channel does not support media attachments yet; post text only");
    }
    if (!xOutbound.sendText) {
      throw new Error("sendText not implemented");
    }
    return xOutbound.sendText(params);
  },
};
