/**
 * PLAN-50 Phase 6: cost intelligence on top of the ledger.
 *
 * - What-if replay: re-price a window's chat-like rows under another model's price table.
 *   Nobody ships this; the ledger's exclusive buckets make it a pure function.
 * - Explain: compare a window with the window before it and name the drivers (feature, model,
 *   session, day) in plain language, for `/usage why` and the Usage tab.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { UsageLedger } from "./usage-ledger.js";
import type { UsageExplanation, UsageWhatIf } from "./usage-ledger.types.js";
import { priceUsage, resolveModelPricing } from "./model-pricing.js";
import { describeUsageFeature } from "./usage-features.js";
import { formatUsageDay } from "./usage-ledger.types.js";

const REPLAYABLE_KINDS = new Set(["chat", "vision", "search"]);

export async function buildUsageWhatIf(params: {
  ledger: UsageLedger;
  cfg: BitterbotConfig | undefined;
  startMs: number;
  endMs: number;
  targetProvider: string;
  targetModel: string;
  agentId?: string;
  feature?: string;
}): Promise<UsageWhatIf> {
  const target = await resolveModelPricing({
    provider: params.targetProvider,
    model: params.targetModel,
    kind: "chat",
    cfg: params.cfg,
  });
  const buckets = params.ledger.replayBuckets({
    startMs: params.startMs,
    endMs: params.endMs,
    agentId: params.agentId,
    feature: params.feature,
  });
  const byModel = new Map<
    string,
    {
      provider: string | null;
      model: string | null;
      calls: number;
      actualCost: number;
      projectedCost: number;
    }
  >();
  let calls = 0;
  let actualCost = 0;
  let projectedCost = 0;
  for (const b of buckets) {
    if (!REPLAYABLE_KINDS.has(b.kind)) {
      continue;
    }
    const projected = priceUsage(
      target.price,
      {
        input: b.input,
        cacheRead: b.cache_read,
        cacheWrite: b.cache_write,
        output: b.output,
        reasoning: 0,
        total: b.input + b.cache_read + b.cache_write + b.output,
      },
      { batch: b.batch === 1, provider: params.targetProvider, source: target.source },
    ).total;
    calls += b.calls;
    actualCost += b.cost;
    projectedCost += projected;
    const key = `${b.provider ?? "?"}/${b.model ?? "?"}`;
    const entry = byModel.get(key) ?? {
      provider: b.provider,
      model: b.model,
      calls: 0,
      actualCost: 0,
      projectedCost: 0,
    };
    entry.calls += b.calls;
    entry.actualCost += b.cost;
    entry.projectedCost += projected;
    byModel.set(key, entry);
  }
  const savingsUsd = actualCost - projectedCost;
  return {
    startDate: formatUsageDay(params.startMs),
    endDate: formatUsageDay(params.endMs),
    target: { provider: params.targetProvider, model: params.targetModel, source: target.source },
    calls,
    actualCost,
    projectedCost,
    savingsUsd,
    savingsPct: actualCost > 0 ? savingsUsd / actualCost : 0,
    byModel: Array.from(byModel.values()).toSorted((a, b) => b.actualCost - a.actualCost),
    caveat:
      target.source === "unpriced"
        ? `No known price for ${params.targetProvider}/${params.targetModel}; projection is $0.`
        : "Same token counts re-priced; a different model would also change output length, cache behavior and quality.",
  };
}

function pct(a: number, b: number): number | null {
  if (b <= 0) {
    return a > 0 ? null : 0;
  }
  return (a - b) / b;
}

function money(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function buildUsageExplanation(params: {
  ledger: UsageLedger;
  startMs: number;
  endMs: number;
  agentId?: string;
  sessionInfo?: (sessionKey: string) => { label?: string } | undefined;
}): UsageExplanation {
  const { ledger } = params;
  const span = params.endMs - params.startMs + 1;
  const priorStart = params.startMs - span;
  const priorEnd = params.startMs - 1;
  const cur = { startMs: params.startMs, endMs: params.endMs, agentId: params.agentId };
  const prior = { startMs: priorStart, endMs: priorEnd, agentId: params.agentId };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const cost = n(ledger.aggregate(cur)[0]?.cost_total);
  const priorCost = n(ledger.aggregate(prior)[0]?.cost_total);
  const drivers: UsageExplanation["drivers"] = [];

  const compare = (
    kind: UsageExplanation["drivers"][number]["kind"],
    groupExpr: string,
    labelOf: (key: string) => string,
  ) => {
    const now = new Map<string, number>();
    for (const row of ledger.aggregate(cur, groupExpr)) {
      now.set(String(row.group_key ?? "unknown"), n(row.cost_total));
    }
    const before = new Map<string, number>();
    for (const row of ledger.aggregate(prior, groupExpr)) {
      before.set(String(row.group_key ?? "unknown"), n(row.cost_total));
    }
    const keys = new Set([...now.keys(), ...before.keys()]);
    for (const key of keys) {
      const c = now.get(key) ?? 0;
      const p = before.get(key) ?? 0;
      drivers.push({ kind, key, label: labelOf(key), cost: c, priorCost: p, delta: c - p });
    }
  };
  compare("feature", "feature", describeUsageFeature);
  compare("model", "COALESCE(provider, '?') || '/' || COALESCE(model, '?')", (k) => k);
  compare(
    "session",
    "COALESCE(session_key, '(no session)')",
    (k) => params.sessionInfo?.(k)?.label ?? k,
  );
  // Days only within the current window (no prior comparison).
  for (const row of ledger.aggregate(cur, "day")) {
    drivers.push({
      kind: "day",
      key: String(row.group_key),
      label: String(row.group_key),
      cost: n(row.cost_total),
      priorCost: 0,
      delta: n(row.cost_total),
    });
  }
  drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const lines: string[] = [];
  const change = pct(cost, priorCost);
  const startDate = formatUsageDay(params.startMs);
  const endDate = formatUsageDay(params.endMs);
  if (priorCost > 0 && change !== null) {
    const dir = change >= 0 ? "up" : "down";
    lines.push(
      `${startDate} to ${endDate}: ${money(cost)}, ${dir} ${Math.abs(change * 100).toFixed(0)}% from ${money(priorCost)} the period before.`,
    );
  } else {
    lines.push(`${startDate} to ${endDate}: ${money(cost)} (no spend in the period before).`);
  }
  const topFeatures = drivers
    .filter((d) => d.kind === "feature" && Math.abs(d.delta) > 0.005)
    .slice(0, 3);
  for (const d of topFeatures) {
    const dir = d.delta >= 0 ? "+" : "-";
    lines.push(
      `${d.label}: ${money(d.cost)} (${dir}${money(Math.abs(d.delta))} vs prior${d.priorCost > 0 ? `, was ${money(d.priorCost)}` : ""}).`,
    );
  }
  const topModel = drivers.find((d) => d.kind === "model" && d.cost > 0);
  if (topModel) {
    lines.push(
      `Largest model line: ${topModel.label} at ${money(topModel.cost)}${cost > 0 ? ` (${((topModel.cost / cost) * 100).toFixed(0)}% of the window)` : ""}.`,
    );
  }
  const topSession = drivers.find(
    (d) => d.kind === "session" && d.cost > 0 && d.key !== "(no session)",
  );
  if (topSession) {
    lines.push(`Most expensive session: ${topSession.label} at ${money(topSession.cost)}.`);
  }
  const days = drivers
    .filter((d) => d.kind === "day" && d.cost > 0)
    .toSorted((a, b) => b.cost - a.cost);
  if (days.length > 1) {
    lines.push(`Peak day: ${days[0]!.label} at ${money(days[0]!.cost)}.`);
  }
  return {
    startDate,
    endDate,
    cost,
    priorCost,
    changePct: change,
    lines,
    drivers: drivers.slice(0, 40),
  };
}
