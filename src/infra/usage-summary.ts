/**
 * PLAN-50: aggregate ledger rows into the summary the gateway, CLI and UI share.
 * One pass over the rows in range serves every pivot (model, provider, feature, kind, agent, day).
 */

import type { BitterbotConfig } from "../config/config.js";
import type { UsageLedger } from "./usage-ledger.js";
import type {
  PricingSource,
  UsageBuckets,
  UsageDailyPoint,
  UsageEventRow,
  UsageGroupSummary,
  UsageKind,
  UsageLedgerSummary,
  UsageModelSummary,
  UsageTotalsRow,
} from "./usage-ledger.types.js";
import { evaluateUsageBudgets } from "./usage-budgets.js";
import { describeUsageFeature } from "./usage-features.js";
import { resolveUsageRetentionDays } from "./usage-ledger.js";
import { cacheHitRate, emptyUsageTotals, formatUsageDay } from "./usage-ledger.types.js";

function addBuckets(target: UsageBuckets, row: UsageEventRow): void {
  target.input += row.usage.input;
  target.cacheRead += row.usage.cacheRead;
  target.cacheWrite += row.usage.cacheWrite;
  target.output += row.usage.output;
  target.reasoning += row.usage.reasoning;
  target.total += row.usage.total;
}

function addTotals(target: UsageTotalsRow, row: UsageEventRow): void {
  target.calls += 1;
  if (row.status === "error") {
    target.errors += 1;
  }
  addBuckets(target.usage, row);
  target.cost.input += row.cost.input;
  target.cost.cacheRead += row.cost.cacheRead;
  target.cost.cacheWrite += row.cost.cacheWrite;
  target.cost.output += row.cost.output;
  target.cost.total += row.cost.total;
  if (row.costSource === "unpriced") {
    target.unpricedCalls += 1;
  }
  if (row.costSource === "estimated") {
    target.estimatedCalls += 1;
  }
}

function finalize<T extends UsageTotalsRow>(row: T): T {
  row.cacheHitRate = cacheHitRate(row.usage);
  return row;
}

function byCostThenTokens(a: UsageTotalsRow, b: UsageTotalsRow): number {
  const diff = b.cost.total - a.cost.total;
  if (diff !== 0) {
    return diff;
  }
  return b.usage.total - a.usage.total;
}

function groupRows(
  rows: UsageEventRow[],
  keyOf: (row: UsageEventRow) => string,
  labelOf: (key: string) => string,
): UsageGroupSummary[] {
  const map = new Map<string, UsageGroupSummary>();
  for (const row of rows) {
    const key = keyOf(row);
    let group = map.get(key);
    if (!group) {
      group = { key, label: labelOf(key), ...emptyUsageTotals() };
      map.set(key, group);
    }
    addTotals(group, row);
  }
  return Array.from(map.values()).map(finalize).toSorted(byCostThenTokens);
}

function modelKey(row: UsageEventRow): string {
  return `${row.provider ?? "unknown"}/${row.model ?? "unknown"}`;
}

export function buildUsageFlags(
  summary: Omit<UsageLedgerSummary, "flags">,
): UsageLedgerSummary["flags"] {
  const flags: UsageLedgerSummary["flags"] = [];
  const totals = summary.totals;
  if (totals.calls === 0) {
    return flags;
  }
  if (summary.unpricedModels.length > 0) {
    const names = summary.unpricedModels
      .slice(0, 3)
      .map((m) => `${m.provider ?? "?"}/${m.model ?? "?"}`)
      .join(", ");
    flags.push({
      id: "unpriced-models",
      level: "warn",
      message: `${summary.unpricedModels.length} model(s) have no known price, so their cost shows as $0: ${names}`,
      tip: "Add models.providers.<provider>.models[].cost (USD per 1M tokens) in config to price them.",
    });
  }
  const chatModels = summary.byModel.filter((m) => m.kinds.includes("chat"));
  for (const m of chatModels) {
    const prompt = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
    const cacheable = m.provider === "anthropic" || m.provider === "openai";
    if (cacheable && m.calls >= 10 && prompt > 200_000 && m.cacheHitRate < 0.3) {
      flags.push({
        id: `cache-miss:${m.provider}/${m.model}`,
        level: "warn",
        message: `${m.provider}/${m.model}: only ${(m.cacheHitRate * 100).toFixed(0)}% of prompt tokens came from cache across ${m.calls} calls`,
        tip: "Cache misses usually mean the system prompt or tool definitions changed between turns, or the cache expired between messages.",
      });
      break;
    }
  }
  const topFeature = summary.byFeature[0];
  if (topFeature && totals.cost.total > 0 && topFeature.key !== "agent/turn") {
    const share = topFeature.cost.total / totals.cost.total;
    if (share >= 0.5) {
      flags.push({
        id: `feature-share:${topFeature.key}`,
        level: "info",
        message: `${topFeature.label} accounts for ${(share * 100).toFixed(0)}% of spend in this window`,
        tip: "Background lanes can be capped with usage.budgets.perFeature.",
      });
    }
  }
  const days = summary.daily.filter((d) => d.calls > 0);
  if (days.length >= 4) {
    const last = days.at(-1)!;
    const prior = days.slice(0, -1);
    const avg = prior.reduce((s, d) => s + d.cost, 0) / prior.length;
    if (avg > 0 && last.cost > 2.5 * avg && last.cost > 1) {
      flags.push({
        id: "spend-spike",
        level: "warn",
        message: `${last.date}: $${last.cost.toFixed(2)} is ${(last.cost / avg).toFixed(1)}x the daily average ($${avg.toFixed(2)})`,
        tip: "Check the Live tab for the feature driving it.",
      });
    }
  }
  const embeddings = summary.byKind.find((k) => k.key === "embedding");
  if (
    embeddings &&
    embeddings.estimatedCalls > 0 &&
    embeddings.estimatedCalls === embeddings.calls
  ) {
    flags.push({
      id: "embeddings-estimated",
      level: "info",
      message:
        "Embedding token counts are estimated (the provider reports none); costs are marked ≈.",
    });
  }
  for (const b of summary.budgets.budgets) {
    if (b.level >= 80) {
      flags.push({
        id: `budget:${b.id}`,
        level: b.exceeded ? "warn" : "info",
        message: `${b.id}: ${(b.ratio * 100).toFixed(0)}% of $${b.limitUsd.toFixed(2)} used; resets ${new Date(b.resetsAtMs).toISOString().slice(0, 10)}`,
        tip:
          b.exceeded && summary.budgets.mode === "enforce"
            ? "Background lanes are paused until the window resets."
            : undefined,
      });
    }
  }
  return flags;
}

export function buildUsageLedgerSummary(params: {
  ledger: UsageLedger;
  cfg: BitterbotConfig | undefined;
  startMs: number;
  endMs: number;
  agentId?: string;
  feature?: string;
  kind?: UsageKind;
  nowMs?: number;
}): UsageLedgerSummary {
  const nowMs = params.nowMs ?? Date.now();
  const rows = params.ledger.rows({
    startMs: params.startMs,
    endMs: params.endMs,
    agentId: params.agentId,
    feature: params.feature,
    kind: params.kind,
  });

  const totals = emptyUsageTotals();
  const modelMap = new Map<
    string,
    UsageModelSummary & { kindSet: Set<UsageKind>; sourceSet: Set<PricingSource> }
  >();
  const dailyMap = new Map<
    string,
    UsageDailyPoint & {
      modelMap: Map<string, UsageDailyPoint["byModel"][number]>;
      kindMap: Map<UsageKind, UsageDailyPoint["byKind"][number]>;
    }
  >();

  for (const row of rows) {
    addTotals(totals, row);

    const mk = modelKey(row);
    let m = modelMap.get(mk);
    if (!m) {
      m = {
        provider: row.provider,
        model: row.model,
        kinds: [],
        pricingSources: [],
        lastTs: null,
        kindSet: new Set(),
        sourceSet: new Set(),
        ...emptyUsageTotals(),
      };
      modelMap.set(mk, m);
    }
    addTotals(m, row);
    m.kindSet.add(row.kind);
    m.sourceSet.add(row.costSource);
    m.lastTs = Math.max(m.lastTs ?? 0, row.ts);

    let d = dailyMap.get(row.day);
    if (!d) {
      d = {
        date: row.day,
        tokens: 0,
        cost: 0,
        calls: 0,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
        byModel: [],
        byKind: [],
        modelMap: new Map(),
        kindMap: new Map(),
      };
      dailyMap.set(row.day, d);
    }
    d.tokens += row.usage.total;
    d.cost += row.cost.total;
    d.calls += 1;
    addBuckets(d.usage, row);
    let dm = d.modelMap.get(mk);
    if (!dm) {
      dm = { provider: row.provider, model: row.model, tokens: 0, cost: 0, calls: 0 };
      d.modelMap.set(mk, dm);
    }
    dm.tokens += row.usage.total;
    dm.cost += row.cost.total;
    dm.calls += 1;
    let dk = d.kindMap.get(row.kind);
    if (!dk) {
      dk = { kind: row.kind, tokens: 0, cost: 0, calls: 0 };
      d.kindMap.set(row.kind, dk);
    }
    dk.tokens += row.usage.total;
    dk.cost += row.cost.total;
    dk.calls += 1;
  }

  // Fill every day in range so charts have a stable axis.
  const dayMs = 24 * 60 * 60_000;
  for (
    let t = Date.UTC(
      new Date(params.startMs).getUTCFullYear(),
      new Date(params.startMs).getUTCMonth(),
      new Date(params.startMs).getUTCDate(),
    );
    t <= params.endMs;
    t += dayMs
  ) {
    const day = formatUsageDay(t);
    if (!dailyMap.has(day)) {
      dailyMap.set(day, {
        date: day,
        tokens: 0,
        cost: 0,
        calls: 0,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
        byModel: [],
        byKind: [],
        modelMap: new Map(),
        kindMap: new Map(),
      });
    }
  }

  const byModel = Array.from(modelMap.values())
    .map((m) => {
      const { kindSet, sourceSet, ...rest } = m;
      rest.kinds = Array.from(kindSet).toSorted();
      rest.pricingSources = Array.from(sourceSet).toSorted();
      return finalize(rest);
    })
    .toSorted(byCostThenTokens);

  const daily = Array.from(dailyMap.values())
    .map((d) => {
      const { modelMap: mm, kindMap: km, ...rest } = d;
      rest.byModel = Array.from(mm.values()).toSorted(
        (a, b) => b.cost - a.cost || b.tokens - a.tokens,
      );
      rest.byKind = Array.from(km.values()).toSorted(
        (a, b) => b.cost - a.cost || b.tokens - a.tokens,
      );
      return rest;
    })
    .toSorted((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const unpricedModels = byModel
    .filter((m) => m.pricingSources.includes("unpriced"))
    .map((m) => ({
      provider: m.provider,
      model: m.model,
      calls: m.unpricedCalls,
      tokens: m.usage.total,
    }));

  const withoutFlags: Omit<UsageLedgerSummary, "flags"> = {
    updatedAt: nowMs,
    startMs: params.startMs,
    endMs: params.endMs,
    startDate: formatUsageDay(params.startMs),
    endDate: formatUsageDay(params.endMs),
    days: Math.max(1, Math.round((params.endMs - params.startMs + 1) / dayMs)),
    totals: finalize(totals),
    byModel,
    byProvider: groupRows(
      rows,
      (r) => r.provider ?? "unknown",
      (k) => k,
    ),
    byFeature: groupRows(rows, (r) => r.feature, describeUsageFeature),
    byKind: groupRows(
      rows,
      (r) => r.kind,
      (k) => k,
    ),
    byAgent: groupRows(
      rows,
      (r) => r.agentId ?? "unknown",
      (k) => k,
    ),
    daily,
    unpricedModels,
    budgets: evaluateUsageBudgets({ ledger: params.ledger, cfg: params.cfg, nowMs }),
    ledger: params.ledger.health(resolveUsageRetentionDays(params.cfg)),
  };
  return { ...withoutFlags, flags: buildUsageFlags(withoutFlags) };
}
