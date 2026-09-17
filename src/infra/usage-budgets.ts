/**
 * PLAN-50: spend budgets and the alert ladder.
 *
 * Budgets are UTC calendar windows (daily / weekly starting Monday / monthly), the convention
 * LiteLLM (`budget_duration`), Portkey (weekly/monthly resets) and Anthropic's Console (monthly,
 * 00:00 UTC on the 1st) converge on. Alerts fire once per window at 50/80/95/100% (Helicone's
 * ladder plus the hard line). `mode: "enforce"` pauses background lanes only — dream, extraction,
 * skill evolution, batch indexing — and never blocks a user's chat turn.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { UsageLedger } from "./usage-ledger.js";
import type {
  UsageBudgetStatus,
  UsageBudgetWindow,
  UsageBudgetsSummary,
} from "./usage-ledger.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { BACKGROUND_USAGE_FEATURES } from "./usage-features.js";
import { USAGE_ALERT_LADDER } from "./usage-ledger.types.js";

const log = createSubsystemLogger("usage-budgets");

export type UsageBudgetLimit = { usd: number };

export type UsageBudgetsConfig = {
  /** "warn" (default) alerts only; "enforce" also pauses background lanes when a budget is exceeded. */
  mode?: "warn" | "enforce";
  daily?: UsageBudgetLimit;
  weekly?: UsageBudgetLimit;
  monthly?: UsageBudgetLimit;
  /** Keyed "provider/model"; monthly window. */
  perModel?: Record<string, UsageBudgetLimit>;
  /** Keyed by feature id (e.g. "memory/dream"); monthly window. */
  perFeature?: Record<string, UsageBudgetLimit>;
};

export type UsageBudgetAlert = {
  type: "usage.budget";
  ts: number;
  status: UsageBudgetStatus;
  previousLevel: number;
};

const alertListeners = new Set<(alert: UsageBudgetAlert) => void>();

export function onUsageBudgetAlert(listener: (alert: UsageBudgetAlert) => void): () => void {
  alertListeners.add(listener);
  return () => alertListeners.delete(listener);
}

export function resolveUsageBudgetsConfig(cfg: BitterbotConfig | undefined): UsageBudgetsConfig {
  const raw = (cfg as { usage?: { budgets?: UsageBudgetsConfig } } | undefined)?.usage?.budgets;
  return raw ?? {};
}

export function budgetWindowBounds(
  window: UsageBudgetWindow,
  nowMs: number,
): { startMs: number; endMs: number } {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (window === "daily") {
    const start = Date.UTC(y, m, day);
    return { startMs: start, endMs: start + 24 * 60 * 60_000 };
  }
  if (window === "weekly") {
    const dow = d.getUTCDay(); // 0 = Sunday
    const sinceMonday = (dow + 6) % 7;
    const start = Date.UTC(y, m, day - sinceMonday);
    return { startMs: start, endMs: start + 7 * 24 * 60 * 60_000 };
  }
  const start = Date.UTC(y, m, 1);
  return { startMs: start, endMs: Date.UTC(y, m + 1, 1) };
}

function levelFor(ratio: number): UsageBudgetStatus["level"] {
  let level: UsageBudgetStatus["level"] = 0;
  for (const rung of USAGE_ALERT_LADDER) {
    if (ratio * 100 >= rung) {
      level = rung;
    }
  }
  return level;
}

function buildStatus(params: {
  id: string;
  scope: UsageBudgetStatus["scope"];
  window: UsageBudgetWindow;
  target?: string;
  limitUsd: number;
  spentUsd: number;
  nowMs: number;
}): UsageBudgetStatus {
  const { startMs, endMs } = budgetWindowBounds(params.window, params.nowMs);
  const ratio = params.limitUsd > 0 ? params.spentUsd / params.limitUsd : 0;
  const elapsed = Math.max(1e-6, (params.nowMs - startMs) / (endMs - startMs));
  return {
    id: params.id,
    scope: params.scope,
    window: params.window,
    target: params.target,
    limitUsd: params.limitUsd,
    spentUsd: params.spentUsd,
    ratio,
    level: levelFor(ratio),
    exceeded: ratio >= 1,
    windowStartMs: startMs,
    resetsAtMs: endMs,
    projectedUsd: params.spentUsd / elapsed,
  };
}

function validLimit(limit: UsageBudgetLimit | undefined): number | null {
  const usd = limit?.usd;
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** Compute the status of every configured budget from ledger spend. */
export function evaluateUsageBudgets(params: {
  ledger: UsageLedger;
  cfg: BitterbotConfig | undefined;
  nowMs?: number;
}): UsageBudgetsSummary {
  const nowMs = params.nowMs ?? Date.now();
  const config = resolveUsageBudgetsConfig(params.cfg);
  const mode = config.mode === "enforce" ? "enforce" : "warn";
  const budgets: UsageBudgetStatus[] = [];

  for (const window of ["daily", "weekly", "monthly"] as const) {
    const limitUsd = validLimit(config[window]);
    if (limitUsd === null) {
      continue;
    }
    const { startMs, endMs } = budgetWindowBounds(window, nowMs);
    const spentUsd = params.ledger.spend({ startMs, endMs });
    budgets.push(
      buildStatus({ id: `global:${window}`, scope: "global", window, limitUsd, spentUsd, nowMs }),
    );
  }
  for (const [target, limit] of Object.entries(config.perModel ?? {})) {
    const limitUsd = validLimit(limit);
    if (limitUsd === null) {
      continue;
    }
    const slash = target.indexOf("/");
    const provider = slash > 0 ? target.slice(0, slash) : undefined;
    const model = slash > 0 ? target.slice(slash + 1) : target;
    const { startMs, endMs } = budgetWindowBounds("monthly", nowMs);
    const spentUsd = params.ledger.spend({ startMs, endMs, provider, model });
    budgets.push(
      buildStatus({
        id: `model:${target}`,
        scope: "model",
        window: "monthly",
        target,
        limitUsd,
        spentUsd,
        nowMs,
      }),
    );
  }
  for (const [target, limit] of Object.entries(config.perFeature ?? {})) {
    const limitUsd = validLimit(limit);
    if (limitUsd === null) {
      continue;
    }
    const { startMs, endMs } = budgetWindowBounds("monthly", nowMs);
    const spentUsd = params.ledger.spend({ startMs, endMs, feature: target });
    budgets.push(
      buildStatus({
        id: `feature:${target}`,
        scope: "feature",
        window: "monthly",
        target,
        limitUsd,
        spentUsd,
        nowMs,
      }),
    );
  }

  const backgroundPaused =
    mode === "enforce" &&
    budgets.some(
      (b) =>
        b.exceeded &&
        (b.scope === "global" ||
          (b.scope === "feature" &&
            b.target !== undefined &&
            BACKGROUND_USAGE_FEATURES.has(b.target))),
    );
  return { mode, budgets, backgroundPaused };
}

/**
 * Compare each budget's level to the last alerted level for its window and emit alerts for new
 * rungs. Persists the alerted level in `usage_meta` so a restart does not re-alert.
 */
export function checkUsageBudgetAlerts(params: {
  ledger: UsageLedger;
  cfg: BitterbotConfig | undefined;
  nowMs?: number;
}): UsageBudgetAlert[] {
  const summary = evaluateUsageBudgets(params);
  const alerts: UsageBudgetAlert[] = [];
  for (const status of summary.budgets) {
    if (status.level === 0) {
      continue;
    }
    const key = `budget:alert:${status.id}:${status.windowStartMs}`;
    const previousLevel = Number(params.ledger.getMeta(key) ?? "0") || 0;
    if (status.level <= previousLevel) {
      continue;
    }
    params.ledger.setMeta(key, String(status.level));
    const alert: UsageBudgetAlert = {
      type: "usage.budget",
      ts: params.nowMs ?? Date.now(),
      status,
      previousLevel,
    };
    alerts.push(alert);
    log.warn(
      `budget ${status.id}: ${(status.ratio * 100).toFixed(0)}% of $${status.limitUsd.toFixed(2)} used ($${status.spentUsd.toFixed(2)})` +
        (status.exceeded ? " — EXCEEDED" : ""),
    );
    for (const listener of alertListeners) {
      try {
        listener(alert);
      } catch {
        // listener failures never affect recording
      }
    }
  }
  return alerts;
}

/**
 * Background lanes call this before spending. True only when `mode: "enforce"` and a budget that
 * covers the lane is exceeded. User-facing turns must never consult this.
 */
export function isBackgroundUsagePaused(params: {
  ledger: UsageLedger | null;
  cfg: BitterbotConfig | undefined;
  feature: string;
  nowMs?: number;
}): boolean {
  if (!params.ledger) {
    return false;
  }
  const config = resolveUsageBudgetsConfig(params.cfg);
  if (config.mode !== "enforce") {
    return false;
  }
  if (!BACKGROUND_USAGE_FEATURES.has(params.feature)) {
    return false;
  }
  const summary = evaluateUsageBudgets({
    ledger: params.ledger,
    cfg: params.cfg,
    nowMs: params.nowMs,
  });
  return summary.budgets.some(
    (b) =>
      b.exceeded &&
      (b.scope === "global" || (b.scope === "feature" && b.target === params.feature)),
  );
}

/**
 * PLAN-50 Phase 6: the "fiscal stress" signal for the endocrine model. 0 when no budget is
 * configured or spend is far from every limit; approaches 1 as the tightest budget fills.
 * Cheap (a few SQL sums) and memoized for a minute so prompt builds do not hammer the ledger.
 */
let pressureMemo: { at: number; value: number; label: string | null } | null = null;
const PRESSURE_MEMO_MS = 60_000;

export function getUsageBudgetPressure(params: {
  ledger: UsageLedger | null;
  cfg: BitterbotConfig | undefined;
  nowMs?: number;
}): { pressure: number; label: string | null } {
  const nowMs = params.nowMs ?? Date.now();
  if (pressureMemo && nowMs - pressureMemo.at < PRESSURE_MEMO_MS) {
    return { pressure: pressureMemo.value, label: pressureMemo.label };
  }
  let value = 0;
  let label: string | null = null;
  if (params.ledger) {
    try {
      const summary = evaluateUsageBudgets({ ledger: params.ledger, cfg: params.cfg, nowMs });
      for (const b of summary.budgets) {
        if (b.ratio > value) {
          value = b.ratio;
          label = b.id;
        }
      }
    } catch {
      value = 0;
    }
  }
  value = Math.min(1.5, Math.max(0, value));
  pressureMemo = { at: nowMs, value, label };
  return { pressure: value, label };
}

export function resetUsageBudgetPressureForTest(): void {
  pressureMemo = null;
}
