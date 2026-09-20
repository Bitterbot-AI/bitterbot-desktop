/**
 * PLAN-50 doctor section: is every token being counted, and priced, and what does the node
 * spend when idle?
 *
 * Coverage lines are warn/info: an unpriced model or a stale ledger is operator-attention
 * state. The unread prompt-cache line is the one exception: at >= $5/day of cache written and
 * never read back it is an `error` (severity is the gate), because that is money burned on
 * nothing and the fix is a config change.
 */

import type { BitterbotConfig } from "../config/config.js";
import { collectUsageDoctorLines } from "../infra/usage-doctor-checks.js";
import {
  getUsageLedger,
  isUsageLedgerConfigEnabled,
  isUsageLedgerEnabled,
} from "../infra/usage-ledger.js";
import { buildUsageLedgerSummary } from "../infra/usage-summary.js";
import { formatUsd } from "../utils/usage-format.js";
import {
  type CheckResult,
  error,
  info,
  ok,
  renderSectionQuietIfAllInfo,
  warn,
} from "./doctor-check.js";

const SECTION = "Usage & Cost (ledger)";
const DAY_MS = 24 * 60 * 60_000;

export function collectUsageChecks(params: {
  config: BitterbotConfig;
  nowMs?: number;
}): CheckResult[] {
  const results: CheckResult[] = [];
  if (!isUsageLedgerEnabled() || !isUsageLedgerConfigEnabled(params.config)) {
    results.push(
      info(
        "usage ledger disabled (BITTERBOT_USAGE_LEDGER=0 or usage.ledger.enabled=false); tokens are not being counted",
      ),
    );
    return results;
  }
  const ledger = getUsageLedger();
  if (!ledger) {
    results.push(warn("usage ledger could not be opened; check the state directory is writable"));
    return results;
  }
  const nowMs = params.nowMs ?? Date.now();
  const summary = buildUsageLedgerSummary({
    ledger,
    cfg: params.config,
    startMs: nowMs - 30 * DAY_MS,
    endMs: nowMs,
    nowMs,
  });
  const health = summary.ledger;
  if (health.events === 0) {
    results.push(
      info(
        "usage ledger is empty; it fills as the agent runs and the gateway backfills session transcripts within minutes of boot",
      ),
    );
    return results;
  }
  results.push(
    ok(
      `${health.events} usage rows${health.newestTs ? `, newest ${Math.round((nowMs - health.newestTs) / 60_000)}m ago` : ""}; last 30d: ${formatUsd(summary.totals.cost.total)} across ${summary.totals.calls} calls`,
    ),
  );
  if (health.lastReconcileAt === null) {
    results.push(
      info("transcript reconcile has not run yet (runs 2s after gateway boot, then every 10m)"),
    );
  } else if (nowMs - health.lastReconcileAt > 60 * 60_000) {
    results.push(
      warn(
        `transcript reconcile last ran ${Math.round((nowMs - health.lastReconcileAt) / 60_000)}m ago; is the gateway running?`,
      ),
    );
  }
  if (summary.unpricedModels.length > 0) {
    const names = summary.unpricedModels
      .map((m) => `${m.provider ?? "?"}/${m.model ?? "?"}`)
      .join(", ");
    results.push(
      warn(
        `${summary.unpricedModels.length} model(s) used in the last 30d have no known price (cost shows $0): ${names}. Set models.providers.<provider>.models[].cost.`,
      ),
    );
  }
  const embeddings = summary.byKind.find((k) => k.key === "embedding");
  if (!embeddings) {
    results.push(
      info(
        "no embedding usage recorded in 30d; memory search/indexing embeddings appear once the memory subsystem embeds",
      ),
    );
  } else if (embeddings.estimatedCalls === embeddings.calls) {
    results.push(
      info("embedding token counts are estimated (provider reports none); costs are approximate"),
    );
  }
  // Idle spend: unread cache writes (7d), heartbeat cost of pass (7d), idle-day floor (14d).
  const byLevel = { ok, info, warn, error } as const;
  for (const line of collectUsageDoctorLines({ ledger, nowMs })) {
    results.push(byLevel[line.level](line.message));
  }
  for (const b of summary.budgets.budgets) {
    if (b.exceeded) {
      results.push(
        warn(
          `budget ${b.id} exceeded: ${formatUsd(b.spentUsd)} of ${formatUsd(b.limitUsd)}${summary.budgets.mode === "enforce" ? " (background lanes paused)" : ""}`,
        ),
      );
    } else if (b.level >= 80) {
      results.push(
        info(
          `budget ${b.id} at ${Math.round(b.ratio * 100)}% (${formatUsd(b.spentUsd)} of ${formatUsd(b.limitUsd)})`,
        ),
      );
    }
  }
  return results;
}

export function runUsageChecks(params: { config: BitterbotConfig }): void {
  try {
    renderSectionQuietIfAllInfo(SECTION, collectUsageChecks(params));
  } catch (err) {
    renderSectionQuietIfAllInfo(SECTION, [
      warn(`usage checks failed: ${err instanceof Error ? err.message : String(err)}`),
    ]);
  }
}
