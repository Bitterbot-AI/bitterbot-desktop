/**
 * PLAN-57 §4.6: what the compute embedding ledger says about the last week.
 * Reads `<state>/compute/deliveries.sqlite` only; no coordinator call.
 *
 * Findings: a policy violation row (content offered to a pool its class
 * forbids) is an error even though the content never shipped, because it
 * means the router and the guard disagreed. A high fallback share is a
 * warning: the pool is costing time, not saving it. Mismatch cooldowns name
 * the worker whose model drifted.
 */

import fsSync from "node:fs";
import { ComputeDeliveryStore, resolveComputeDbPath } from "../compute/awareness/index.js";
import type { ComputeLedgerSummary } from "../compute/awareness/ledger.js";
import type { BitterbotConfig } from "../config/config.js";
import {
  type CheckResult,
  error,
  info,
  ok,
  renderSectionQuietIfAllInfo,
  warn,
} from "./doctor-check.js";

const SECTION = "Compute embeddings";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function runComputeEmbeddingChecks(cfg: BitterbotConfig): Promise<void> {
  renderSectionQuietIfAllInfo(SECTION, collectComputeEmbeddingResults(cfg));
}

export function collectComputeEmbeddingResults(
  cfg: BitterbotConfig,
  opts?: { dbPath?: string; now?: number },
): CheckResult[] {
  if (cfg.compute?.enabled === false) {
    return [info("Compute is disabled (compute.enabled: false).")];
  }
  if (cfg.compute?.embeddings?.provider === "local") {
    return [info("Embedding routing is local only (compute.embeddings.provider: local).")];
  }
  const dbPath = opts?.dbPath ?? resolveComputeDbPath();
  if (dbPath !== ":memory:" && !fsSync.existsSync(dbPath)) {
    return [info("No compute ledger yet: no pool has been registered on this node.")];
  }
  let summary: ComputeLedgerSummary;
  try {
    const store = ComputeDeliveryStore.open(dbPath);
    try {
      summary = store.ledger().summary((opts?.now ?? Date.now()) - WEEK_MS);
    } finally {
      store.close();
    }
  } catch (err) {
    return [
      warn(`Compute ledger could not be read: ${err instanceof Error ? err.message : String(err)}`),
    ];
  }
  return summarise(summary);
}

export function summarise(s: ComputeLedgerSummary): CheckResult[] {
  if (s.batches === 0) {
    return [info("No embedding batches routed in the last 7 days.")];
  }
  const results: CheckResult[] = [];
  const pool = s.byRoute.pool;
  const fb = s.byRoute.fallback;
  const attempts = pool.batches + fb.batches;
  results.push(
    ok(
      `Last 7 days: ${s.batches} batches, ${s.items} items. Pool ${pool.batches} (${pool.items} items), local ${s.byRoute.local.batches}, fallback ${fb.batches}.` +
        (s.poolItemsPerSecond && s.localItemsPerSecond
          ? ` Throughput pool ${s.poolItemsPerSecond}/s vs local ${s.localItemsPerSecond}/s.`
          : ""),
    ),
  );
  if (s.policyViolations > 0) {
    results.push(
      error(
        `${s.policyViolations} policy violation(s) recorded: content was routed to a pool its governance class forbids. The guard ran the batch locally and nothing shipped, but the router disagreed with the policy. Report this.`,
      ),
    );
  }
  const mismatches = [
    "digest_mismatch",
    "dimension_mismatch",
    "processing_mismatch",
    "count_mismatch",
  ]
    .map((k) => [k, s.fallbacksByReason[k] ?? 0] as const)
    .filter(([, n]) => n > 0);
  for (const [reason, n] of mismatches) {
    results.push(
      warn(
        `${n} batch(es) came back with a ${reason.replace("_", " ")} and were re-run locally; the worker is in cooldown. A pool worker's pinned model must equal the local embedding profile (same digest, dimensions, no truncation).`,
      ),
    );
  }
  const timeouts = s.fallbacksByReason.timeout ?? 0;
  const errors = s.fallbacksByReason.error ?? 0;
  if (attempts > 0 && fb.batches / attempts > 0.25) {
    results.push(
      warn(
        `${fb.batches} of ${attempts} pool attempts fell back to local (${timeouts} timeouts, ${errors} errors). The pool is slower than it looks; raise compute.embeddings.marginMs or check the workers.`,
      ),
    );
  } else if (fb.batches > 0) {
    results.push(
      info(
        `${fb.batches} fallback(s): ${Object.entries(s.fallbacksByReason)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}.`,
      ),
    );
  }
  const egress = Object.entries(s.poolByClassTrust);
  if (egress.length > 0) {
    results.push(
      info(`Pool batches by class and trust: ${egress.map(([k, v]) => `${k} ${v}`).join(", ")}.`),
    );
  }
  return results;
}
