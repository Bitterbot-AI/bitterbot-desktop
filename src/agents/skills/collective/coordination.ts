import type { BitterbotConfig } from "../../../config/config.js";
import { loadConfig } from "../../../config/config.js";
import { ReceiptSchema, learningHash, lineageId } from "./contracts.js";
import { proposeFromEvidence } from "./evidence.js";
import { releaseLocalPackage } from "./local.js";
import { createPackageProposalHost } from "./proposal-host.js";
import type { CollectiveRuntime } from "./runtime.js";
import { collectiveIdentity, packageTransport, queuePackageOperation } from "./service.js";
import { validateRelease } from "./signatures.js";

export function ensureCoordinationSchema(runtime: CollectiveRuntime): void {
  runtime.store.db.exec(
    "CREATE TABLE IF NOT EXISTS collective_exports(id TEXT PRIMARY KEY, body TEXT NOT NULL, release_id TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS collective_withdrawal_outbox(id TEXT PRIMARY KEY, body TEXT NOT NULL, release_body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)",
  );
}

/** One bounded unit of work per pass; permissions are reread immediately before transmission. */
export async function coordinateCollective(
  config: BitterbotConfig,
  runtime: CollectiveRuntime,
  signal: AbortSignal,
): Promise<void> {
  ensureCoordinationSchema(runtime);
  const withdrawal = runtime.store.db
    .prepare("SELECT * FROM collective_withdrawal_outbox WHERE delivered=0 LIMIT 1")
    .get() as { id: string; body: string; release_body: string } | undefined;
  if (withdrawal) {
    const transport = await packageTransport(
      config,
      validateRelease(JSON.parse(withdrawal.release_body)),
    );
    if (!transport.withdraw) throw new Error("Peer transport lacks withdrawals");
    await transport.withdraw(JSON.parse(withdrawal.body));
    runtime.store.db
      .prepare("UPDATE collective_withdrawal_outbox SET delivered=1 WHERE id=?")
      .run(withdrawal.id);
    return;
  }
  const releases = (
    runtime.store.db
      .prepare(
        "SELECT id,body FROM collective_releases WHERE withdrawn=0 ORDER BY version DESC LIMIT 100",
      )
      .all() as { id: string; body: string }[]
  ).map((r) => ({ id: r.id, release: validateRelease(JSON.parse(r.body)) }));
  for (const { id, release } of releases) {
    if (release.scope.kind === "private" || !runtime.store.get(release.packageHash)) continue;
    for (const policy of runtime.policies.list()) {
      if (
        !policy.enabled ||
        policy.expiresAt <= runtime.store.now() ||
        !policy.publishers.includes(release.publisher) ||
        !policy.skillIds.includes(release.skillId) ||
        learningHash(policy.scope) !== learningHash(release.scope)
      )
        continue;
      for (const agent of policy.agents) {
        if (policy.operations.includes("evidence")) {
          runtime.policies.authorize(agent, release, "evidence", "execution-summary");
          const receiptRows = runtime.store.db
            .prepare("SELECT id,body FROM collective_receipts WHERE hash=? ORDER BY id LIMIT 500")
            .all(release.packageHash) as { id: string; body: string }[];
          for (const row of receiptRows) {
            const exportId = learningHash({ receipt: row.id, scope: release.scope });
            const sent = runtime.store.db
              .prepare("SELECT state FROM collective_exports WHERE id=?")
              .get(exportId) as { state: string } | undefined;
            if (sent?.state === "delivered") continue;
            const receipt = ReceiptSchema.parse(JSON.parse(row.body));
            if (!["selection", "acquisition"].includes(receipt.partition)) continue;
            const old = runtime.store.db
              .prepare("SELECT body FROM collective_exports WHERE id=?")
              .get(exportId) as { body: string } | undefined;
            const summary = old
              ? JSON.parse(old.body)
              : runtime.evidence.export(
                  agent,
                  release,
                  row.id,
                  runtime.policies,
                  collectiveIdentity(),
                  {
                    failure:
                      receipt.outcome === "task-failure"
                        ? "host-task-check-failed"
                        : receipt.outcome,
                    conditions: { family: receipt.family },
                  },
                );
            runtime.store.db
              .prepare("INSERT OR IGNORE INTO collective_exports VALUES (?,?,?,'pending')")
              .run(exportId, JSON.stringify(summary), id);
            const transport = await packageTransport(config, release);
            if (!transport.evidence) throw new Error("Peer transport lacks evidence exchange");
            runtime.policies.authorize(agent, release, "evidence", "execution-summary");
            await transport.evidence(summary);
            runtime.store.db
              .prepare("UPDATE collective_exports SET state='delivered' WHERE id=?")
              .run(exportId);
            runtime.evidence.import(summary);
            return;
          }
        }
        const mode = loadConfig().skills?.collective?.synthesis;
        if (mode !== "shadow" && mode !== "active") continue;
        if (!policy.operations.includes("evaluate")) continue;
        runtime.policies.authorize(agent, release, "evaluate", "skill-package");
        const selected = runtime.evidence.select(release);
        if (
          new Set(selected.map((s) => s.evidence.origin)).size < 2 &&
          !selected.some(
            (s) =>
              s.evidence.origin === `ed25519:${collectiveIdentity().publicKeyHex}` &&
              s.evidence.outcome === "task-failure",
          )
        )
          continue;
        if (
          runtime.store.db
            .prepare("SELECT 1 FROM collective_proposals WHERE lineage=? AND day=?")
            .get(lineageId(release), Math.floor(runtime.store.now() / 86400000))
        )
          continue;
        const global = config.skills?.collective?.budget ?? {
          providerUsd: 0,
          toolCalls: 0,
          wallMs: 0,
        };
        const budget = {
          providerUsd: Math.min(global.providerUsd, policy.budget.providerUsd),
          toolCalls: Math.min(global.toolCalls, policy.budget.toolCalls),
          wallMs: Math.min(global.wallMs, policy.budget.wallMs),
        };
        const host = await createPackageProposalHost(config, agent, {
          publicContract: runtime.hosts.get(agent)?.publicContract,
        });
        const hash = await proposeFromEvidence(
          runtime.store,
          release,
          runtime.evidence,
          {
            ...host,
            propose: async (...args) => {
              runtime.policies.authorize(agent, release, "evaluate", "skill-package");
              if (loadConfig().skills?.collective?.synthesis !== mode)
                throw new Error("Synthesis policy changed");
              return host.propose(...args);
            },
          },
          budget,
          signal,
        );
        const candidateId = releaseLocalPackage(
          runtime.store,
          hash,
          `${release.skillId.slice(0, 160)}-local`,
        );
        runtime.store.db
          .prepare("INSERT OR REPLACE INTO collective_proposal_authority VALUES (?,?,?)")
          .run(hash, id, mode);
        runtime.store.audit("peer-informed-proposal", hash, {
          sourceRelease: id,
          parents: [release.packageHash],
          evidence: selected.map((s) => s.id),
          mode,
        });
        if (mode === "active") queuePackageOperation(runtime, agent, candidateId, "validate");
        return;
      }
    }
  }
}
