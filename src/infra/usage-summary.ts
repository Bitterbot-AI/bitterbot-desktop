/**
 * PLAN-50: aggregate ledger rows into the summary the gateway, CLI and UI share.
 * One pass over the rows in range serves every pivot (model, provider, feature, kind, agent,
 * task, day), plus the Phase 5 sections: cache health, burn rate / rolling 5-hour window,
 * reported-vs-computed cost and pricing status.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { UsageLedger } from "./usage-ledger.js";
import type {
  CacheTtlLabel,
  PricingSource,
  UsageBuckets,
  UsageCacheHealth,
  UsageDailyPoint,
  UsageEventRow,
  UsageGroupSummary,
  UsageKind,
  UsageLedgerSummary,
  UsageLiveStats,
  UsageModelSummary,
  UsageRateWindow,
  UsageTaskSummary,
  UsageTotalsRow,
} from "./usage-ledger.types.js";
import { getLivePricingStatus } from "./model-pricing-live.js";
import { evaluateUsageBudgets } from "./usage-budgets.js";
import { describeUsageFeature } from "./usage-features.js";
import { resolveUsageRetentionDays } from "./usage-ledger.js";
import { cacheHitRate, emptyUsageTotals, formatUsageDay } from "./usage-ledger.types.js";

const HOUR_MS = 60 * 60_000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const CACHE_CAPABLE_PROVIDERS = new Set(["anthropic", "openai"]);

function addBuckets(target: UsageBuckets, row: UsageEventRow): void {
  // Text-to-speech rows store characters in `input`; they are billed, not tokens.
  if (row.kind === "tts") {
    return;
  }
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
  if (row.costComputed !== null) {
    target.costComputed += row.costComputed;
    target.computedCalls += 1;
    target.costReportedOnComputed += row.cost.total;
  }
  if (row.costSource === "provider") {
    target.reportedCalls += 1;
  }
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
  keyOf: (row: UsageEventRow) => string | null,
  labelOf: (key: string) => string,
): UsageGroupSummary[] {
  const map = new Map<string, UsageGroupSummary>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) {
      continue;
    }
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

function ttlMs(ttl: CacheTtlLabel | null): number {
  if (ttl === "none") {
    return 0;
  }
  return ttl === "1h" ? HOUR_MS : 5 * 60_000;
}

export function buildCacheHealth(rows: UsageEventRow[], nowMs: number): UsageCacheHealth {
  const chat = rows.filter(
    (r) => r.kind === "chat" && r.provider !== null && CACHE_CAPABLE_PROVIDERS.has(r.provider),
  );
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  let busts = 0;
  let wastedUsd = 0;
  const reasons = new Map<string, number>();
  const perModel = new Map<
    string,
    {
      provider: string | null;
      model: string | null;
      requests: number;
      usage: UsageBuckets;
      busts: number;
      wastedUsd: number;
    }
  >();
  let lastChat: UsageEventRow | null = null;
  for (const row of chat) {
    addBuckets(totals, row);
    if (!lastChat || row.ts > lastChat.ts) {
      lastChat = row;
    }
    const key = modelKey(row);
    let m = perModel.get(key);
    if (!m) {
      m = {
        provider: row.provider,
        model: row.model,
        requests: 0,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
        busts: 0,
        wastedUsd: 0,
      };
      perModel.set(key, m);
    }
    m.requests += 1;
    addBuckets(m.usage, row);
    if (row.cacheBustReason) {
      reasons.set(row.cacheBustReason, (reasons.get(row.cacheBustReason) ?? 0) + 1);
    }
    const isBust =
      row.cacheBustReason !== null &&
      !row.cacheBustReason.startsWith("cold start") &&
      !row.cacheBustReason.startsWith("context grew");
    if (isBust) {
      busts += 1;
      m.busts += 1;
      wastedUsd += row.cost.cacheWrite;
      m.wastedUsd += row.cost.cacheWrite;
    }
  }
  const ttl = lastChat?.cacheTtl ?? (lastChat ? "5m" : null);
  return {
    requests: chat.length,
    hitRate: cacheHitRate(totals),
    busts,
    wastedUsd,
    warm: lastChat !== null && nowMs - lastChat.ts < ttlMs(ttl),
    ttl,
    lastChatTs: lastChat?.ts ?? null,
    reasons: Array.from(reasons.entries())
      .map(([reason, count]) => ({ reason, count }))
      .toSorted((a, b) => b.count - a.count),
    byModel: Array.from(perModel.values())
      .map((m) => ({
        provider: m.provider,
        model: m.model,
        requests: m.requests,
        hitRate: cacheHitRate(m.usage),
        busts: m.busts,
        wastedUsd: m.wastedUsd,
      }))
      .toSorted((a, b) => b.requests - a.requests),
  };
}

function tokensOf(row: UsageEventRow): number {
  return row.kind === "tts" ? 0 : row.usage.total;
}

/**
 * Rate over a fixed window `[startMs, endMs]`, measured up to `nowMs`. Projection extends the
 * last hour's pace to the end of the window (a ccusage-style block estimate).
 */
function rateWindow(
  rows: UsageEventRow[],
  startMs: number,
  endMs: number,
  nowMs: number,
  paceRows?: UsageEventRow[],
): UsageRateWindow {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  for (const row of rows) {
    if (row.ts >= startMs && row.ts <= endMs) {
      calls += 1;
      tokens += tokensOf(row);
      cost += row.cost.total;
    }
  }
  const measuredEnd = Math.min(nowMs, endMs);
  const elapsedMin = Math.max(1, (measuredEnd - startMs) / 60_000);
  const remainingMin = Math.max(0, (endMs - measuredEnd) / 60_000);
  let paceCostPerMin = cost / elapsedMin;
  if (paceRows) {
    let paceCost = 0;
    for (const row of paceRows) {
      if (row.ts >= nowMs - HOUR_MS && row.ts <= nowMs) {
        paceCost += row.cost.total;
      }
    }
    paceCostPerMin = paceCost / 60;
  }
  return {
    startMs,
    endMs,
    calls,
    tokens,
    cost,
    tokensPerMinute: tokens / elapsedMin,
    costPerHour: (cost / elapsedMin) * 60,
    projectedCost: cost + paceCostPerMin * remainingMin,
  };
}

/**
 * Current 5-hour block (ccusage semantics: starts at the hour of the first call after the
 * previous block ended, lasts exactly five hours), the trailing hour, and the busiest completed
 * 5-hour block in the range as the bar's ceiling.
 */
export function buildLiveStats(
  recentRows: UsageEventRow[],
  rangeRows: UsageEventRow[],
  nowMs: number,
): UsageLiveStats {
  const recentSorted = [...recentRows].toSorted((a, b) => a.ts - b.ts);
  // Walk the recent activity into 5-hour blocks (a block starts at the top of the hour of the
  // first call after the previous block ended) and keep the block holding the latest call.
  let blockStart = nowMs - FIVE_HOURS_MS;
  let blockEnd = nowMs;
  let anchored = false;
  for (const row of recentSorted) {
    if (row.ts <= nowMs - FIVE_HOURS_MS || row.ts > nowMs) {
      continue;
    }
    if (!anchored || row.ts >= blockEnd) {
      blockStart = Math.floor(row.ts / HOUR_MS) * HOUR_MS;
      blockEnd = blockStart + FIVE_HOURS_MS;
      anchored = true;
    }
  }
  const window5h = rateWindow(recentRows, blockStart, blockEnd, nowMs, recentRows);
  const lastHour = rateWindow(recentRows, nowMs - HOUR_MS, nowMs, nowMs);
  // Peak completed 5-hour block over the range: sliding window on rows before the current block.
  const sorted = rangeRows.filter((r) => r.ts < blockStart).toSorted((a, b) => a.ts - b.ts);
  let peak: UsageLiveStats["peak5h"] = null;
  let lo = 0;
  let cost = 0;
  let tokens = 0;
  for (let hi = 0; hi < sorted.length; hi += 1) {
    cost += sorted[hi]!.cost.total;
    tokens += tokensOf(sorted[hi]!);
    while (sorted[hi]!.ts - sorted[lo]!.ts > FIVE_HOURS_MS) {
      cost -= sorted[lo]!.cost.total;
      tokens -= tokensOf(sorted[lo]!);
      lo += 1;
    }
    if (!peak || cost > peak.cost) {
      peak = { startMs: sorted[lo]!.ts, cost, tokens };
    }
  }
  return { window5h, lastHour, peak5h: peak };
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
  const health = summary.cacheHealth;
  if (health.requests >= 10 && health.busts > 0 && health.wastedUsd >= 0.5) {
    const top = health.reasons.find(
      (r) => !r.reason.startsWith("cold start") && !r.reason.startsWith("context grew"),
    );
    flags.push({
      id: "cache-busts",
      level: "warn",
      message:
        `${health.busts} cache bust(s) cost about $${health.wastedUsd.toFixed(2)} in re-written prompt cache` +
        (top ? `; most often: ${top.reason}` : ""),
      tip: top?.reason.startsWith("cache expired")
        ? 'Turns are spaced longer than the cache TTL; batch work closer together or set cacheRetention: "long" (1h) on Anthropic.'
        : "Keep the system prompt and tool list stable within a session; a changed prefix invalidates the whole cache.",
    });
  } else {
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
  const live = summary.live;
  if (
    live.peak5h &&
    live.window5h.cost > 1 &&
    live.window5h.projectedCost > live.peak5h.cost * 1.2
  ) {
    flags.push({
      id: "burn-rate",
      level: "info",
      message: `Current 5-hour pace ($${live.window5h.costPerHour.toFixed(2)}/h) projects past your busiest previous 5-hour block ($${live.peak5h.cost.toFixed(2)})`,
    });
  }
  const reportedVsComputed =
    totals.costComputed > 0 && totals.costReportedOnComputed > 0
      ? totals.costReportedOnComputed / totals.costComputed
      : 1;
  if (totals.computedCalls > 20 && (reportedVsComputed > 1.15 || reportedVsComputed < 0.85)) {
    flags.push({
      id: "cost-mode-drift",
      level: "info",
      message: `Reported cost differs from our price table by ${((reportedVsComputed - 1) * 100).toFixed(0)}%; toggle "computed" in the Models tab to compare`,
      tip: "A large gap usually means a stale price entry in models.providers[..].models[].cost.",
    });
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
  /** Optional resolver for task labels (task id -> goal); the gateway passes the task store. */
  taskLabel?: (taskId: string) => string | undefined;
}): UsageLedgerSummary {
  const nowMs = params.nowMs ?? Date.now();
  const filters = { agentId: params.agentId, feature: params.feature, kind: params.kind };
  const rows = params.ledger.rows({ startMs: params.startMs, endMs: params.endMs, ...filters });
  // Rolling windows are relative to now and may fall outside the requested range.
  const recentRows =
    params.startMs <= nowMs - FIVE_HOURS_MS && params.endMs >= nowMs
      ? rows
      : params.ledger.rows({ startMs: nowMs - FIVE_HOURS_MS, endMs: nowMs, ...filters });

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
  const taskMap = new Map<string, UsageTaskSummary & { runSet: Set<string> }>();

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

    if (row.taskId) {
      let t = taskMap.get(row.taskId);
      if (!t) {
        t = {
          key: row.taskId,
          taskId: row.taskId,
          label: params.taskLabel?.(row.taskId) ?? row.taskId,
          runs: 0,
          runSet: new Set(),
          ...emptyUsageTotals(),
        };
        taskMap.set(row.taskId, t);
      }
      addTotals(t, row);
      if (row.runId) {
        t.runSet.add(row.runId);
      }
    }
  }

  // Fill every day in range so charts have a stable axis.
  const startDay = new Date(params.startMs);
  for (
    let t = Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate());
    t <= params.endMs;
    t += DAY_MS
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

  const byTask = Array.from(taskMap.values())
    .map((t) => {
      const { runSet, ...rest } = t;
      rest.runs = runSet.size;
      return finalize(rest);
    })
    .toSorted(byCostThenTokens);

  const unpricedModels = byModel
    .filter((m) => m.pricingSources.includes("unpriced"))
    .map((m) => ({
      provider: m.provider,
      model: m.model,
      calls: m.unpricedCalls,
      tokens: m.usage.total,
    }));

  const livePricing = getLivePricingStatus();
  const withoutFlags: Omit<UsageLedgerSummary, "flags"> = {
    updatedAt: nowMs,
    startMs: params.startMs,
    endMs: params.endMs,
    startDate: formatUsageDay(params.startMs),
    endDate: formatUsageDay(params.endMs),
    days: Math.max(1, Math.round((params.endMs - params.startMs + 1) / DAY_MS)),
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
    byTask,
    cacheHealth: buildCacheHealth(rows, nowMs),
    live: buildLiveStats(recentRows, rows, nowMs),
    pricing: {
      liveSnapshots: livePricing.snapshots,
      liveNewestAt: livePricing.newestAt,
      liveEntries: livePricing.entries,
      liveError: livePricing.lastError,
    },
    unpricedModels,
    budgets: evaluateUsageBudgets({ ledger: params.ledger, cfg: params.cfg, nowMs }),
    ledger: params.ledger.health(resolveUsageRetentionDays(params.cfg)),
  };
  return { ...withoutFlags, flags: buildUsageFlags(withoutFlags) };
}
