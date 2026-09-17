/**
 * PLAN-50: aggregate ledger rows into the summary the gateway, CLI and UI share.
 *
 * Phase 6: every pivot is a SQL GROUP BY (see UsageLedger.aggregate & friends) so the gateway
 * event loop never materializes a window's rows. Sections: totals, byModel/provider/feature/
 * kind/agent/task/session, daily stacked series, cache health (busts with causes plus
 * never-read cache writes), burn rate / 5-hour blocks, cost per verified outcome, energy
 * estimate, runaway runs, pricing status, budgets, ledger health and the cost-coach flags.
 */

import type { BitterbotConfig } from "../config/config.js";
import type { UsageAggregateRow, UsageLedger } from "./usage-ledger.js";
import type {
  CacheTtlLabel,
  PricingSource,
  UsageCacheHealth,
  UsageDailyPoint,
  UsageEnergyEstimate,
  UsageGroupSummary,
  UsageKind,
  UsageLedgerSummary,
  UsageLiveStats,
  UsageModelSummary,
  UsageOutcomes,
  UsageRateWindow,
  UsageRunawayRun,
  UsageSessionSummary,
  UsageTaskSummary,
  UsageTotalsRow,
} from "./usage-ledger.types.js";
import { CACHE_BUST_REASONS } from "../agents/prompt-cache-monitor.js";
import { getLivePricingStatus } from "./model-pricing-live.js";
import { evaluateUsageBudgets } from "./usage-budgets.js";
import { describeUsageFeature } from "./usage-features.js";
import { resolveUsageRetentionDays } from "./usage-ledger.js";
import { cacheHitRate, emptyUsageTotals, formatUsageDay } from "./usage-ledger.types.js";

const HOUR_MS = 60 * 60_000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
/** Separator for composite GROUP BY keys (SQL `char(1)`). */
const SEP = String.fromCharCode(1);

/**
 * Energy per token. Google's 2025 fleet paper puts a median Gemini text prompt at 0.24 Wh
 * (arxiv 2508.15734); Mistral's lifecycle report gives 1.14 gCO2e per 400-token answer; EcoLogits
 * decode-phase estimates differ from these by ~3x. We use 0.0006 Wh per token (input+output)
 * with a 0.33x-3x band and a world-average 0.43 kgCO2e/kWh grid factor. Order of magnitude only.
 */
const WH_PER_PREFILL_TOKEN = 0.0003;
const WH_PER_CACHED_TOKEN = 0.00003;
const WH_PER_OUTPUT_TOKEN = 0.001;
const GCO2E_PER_WH = 0.43;

export type TaskOutcomeResolver = (
  taskId: string,
) => { status: string; goal?: string; updatedAt?: number } | undefined;

export type SessionLabelResolver = (
  sessionKey: string,
) => { label?: string; channel?: string; agentId?: string } | undefined;

type HourBucket = { hour: number; cost: number; tokens: number; calls: number };
type Filters = Parameters<UsageLedger["aggregate"]>[0];

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function totalsFromRow(row: UsageAggregateRow): UsageTotalsRow {
  const t: UsageTotalsRow = {
    calls: num(row.calls),
    errors: num(row.errors),
    usage: {
      input: num(row.input),
      cacheRead: num(row.cache_read),
      cacheWrite: num(row.cache_write),
      output: num(row.output),
      reasoning: num(row.reasoning),
      total: num(row.total),
    },
    cost: {
      input: num(row.cost_input),
      cacheRead: num(row.cost_cache_read),
      cacheWrite: num(row.cost_cache_write),
      output: num(row.cost_output),
      total: num(row.cost_total),
    },
    costComputed: num(row.cost_computed),
    computedCalls: num(row.computed_calls),
    costReportedOnComputed: num(row.cost_reported_on_computed),
    reportedCalls: num(row.reported_calls),
    cacheHitRate: 0,
    unpricedCalls: num(row.unpriced_calls),
    estimatedCalls: num(row.estimated_calls),
  };
  t.cacheHitRate = cacheHitRate(t.usage);
  return t;
}

function byCostThenTokens(a: UsageTotalsRow, b: UsageTotalsRow): number {
  const diff = b.cost.total - a.cost.total;
  if (diff !== 0) {
    return diff;
  }
  return b.usage.total - a.usage.total;
}

function groups(
  ledger: UsageLedger,
  filters: Filters,
  groupExpr: string,
  labelOf: (key: string) => string,
): UsageGroupSummary[] {
  return ledger
    .aggregate(filters, groupExpr)
    .map((row) => {
      const key = String(row.group_key ?? "unknown");
      return { key, label: labelOf(key), ...totalsFromRow(row) };
    })
    .toSorted(byCostThenTokens);
}

function ttlMs(ttl: CacheTtlLabel | null): number {
  if (ttl === "none") {
    return 0;
  }
  return ttl === "1h" ? HOUR_MS : 5 * 60_000;
}

export function isBustReason(reason: string | null): boolean {
  return (
    reason !== null &&
    reason !== CACHE_BUST_REASONS.coldStart &&
    reason !== CACHE_BUST_REASONS.prefixGrew &&
    reason !== CACHE_BUST_REASONS.writeNeverRead
  );
}

export function buildCacheHealth(
  ledger: UsageLedger,
  filters: Filters,
  nowMs: number,
): UsageCacheHealth {
  const facets = ledger.cacheFacets(filters);
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  let requests = 0;
  let busts = 0;
  let wastedUsd = 0;
  const reasons = new Map<string, number>();
  type ModelAcc = {
    provider: string | null;
    model: string | null;
    requests: number;
    usage: typeof totals;
    busts: number;
    wastedUsd: number;
    unreadWriteUsd: number;
  };
  type LaneAcc = {
    provider: string | null;
    model: string | null;
    feature: string;
    requests: number;
    cacheRead: number;
    cacheWrite: number;
    writeCost: number;
  };
  const perModel = new Map<string, ModelAcc>();
  const perLane = new Map<string, LaneAcc>();
  let lastTs: number | null = null;
  let lastTtl: CacheTtlLabel | null = null;
  for (const f of facets) {
    requests += f.calls;
    totals.input += f.input;
    totals.cacheRead += f.cache_read;
    totals.cacheWrite += f.cache_write;
    if (f.last_ts !== null && (lastTs === null || f.last_ts > lastTs)) {
      lastTs = f.last_ts;
      lastTtl = (f.last_ttl as CacheTtlLabel | null) ?? null;
    }
    const key = `${f.provider ?? "unknown"}/${f.model ?? "unknown"}`;
    let m = perModel.get(key);
    if (!m) {
      m = {
        provider: f.provider,
        model: f.model,
        requests: 0,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
        busts: 0,
        wastedUsd: 0,
        unreadWriteUsd: 0,
      };
      perModel.set(key, m);
    }
    m.requests += f.calls;
    m.usage.input += f.input;
    m.usage.cacheRead += f.cache_read;
    m.usage.cacheWrite += f.cache_write;
    const laneKey = `${key}${SEP}${f.feature}`;
    let lane = perLane.get(laneKey);
    if (!lane) {
      lane = {
        provider: f.provider,
        model: f.model,
        feature: f.feature,
        requests: 0,
        cacheRead: 0,
        cacheWrite: 0,
        writeCost: 0,
      };
      perLane.set(laneKey, lane);
    }
    lane.requests += f.calls;
    lane.cacheRead += f.cache_read;
    lane.cacheWrite += f.cache_write;
    lane.writeCost += f.cost_cache_write;
    if (f.cache_bust_reason) {
      reasons.set(f.cache_bust_reason, (reasons.get(f.cache_bust_reason) ?? 0) + f.calls);
    }
    if (isBustReason(f.cache_bust_reason)) {
      busts += f.calls;
      m.busts += f.calls;
      wastedUsd += f.cost_cache_write;
      m.wastedUsd += f.cost_cache_write;
    }
  }
  // Never-read cache writes, judged per model AND lane: a heartbeat lane that re-caches the
  // prompt every 30 minutes shows near-zero reads even when the same model's chat turns read
  // the cache fine. Reads under a tenth of writes over at least three calls counts the lane's
  // whole write cost as what a warm cache would have avoided.
  let unreadWriteUsd = 0;
  let unreadWriteTokens = 0;
  const unreadByFeature = new Map<string, { requests: number; usd: number }>();
  for (const lane of perLane.values()) {
    if (lane.cacheWrite > 0 && lane.requests >= 3 && lane.cacheRead / lane.cacheWrite < 0.1) {
      unreadWriteUsd += lane.writeCost;
      unreadWriteTokens += lane.cacheWrite;
      const m = perModel.get(`${lane.provider ?? "unknown"}/${lane.model ?? "unknown"}`);
      if (m) {
        m.unreadWriteUsd += lane.writeCost;
      }
      const acc = unreadByFeature.get(lane.feature) ?? { requests: 0, usd: 0 };
      acc.requests += lane.requests;
      acc.usd += lane.writeCost;
      unreadByFeature.set(lane.feature, acc);
    }
  }
  const ttl = lastTtl ?? (lastTs !== null ? "5m" : null);
  return {
    requests,
    hitRate: cacheHitRate(totals),
    busts,
    wastedUsd,
    unreadWriteUsd,
    unreadWriteTokens,
    unreadByFeature: Array.from(unreadByFeature.entries())
      .map(([feature, acc]) => ({
        feature,
        label: describeUsageFeature(feature),
        requests: acc.requests,
        usd: acc.usd,
      }))
      .toSorted((a, b) => b.usd - a.usd),
    warm: lastTs !== null && nowMs - lastTs < ttlMs(ttl),
    ttl,
    lastChatTs: lastTs,
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
        unreadWriteUsd: m.unreadWriteUsd,
      }))
      .toSorted((a, b) => b.requests - a.requests),
  };
}

function rateWindow(
  hours: HourBucket[],
  startMs: number,
  endMs: number,
  nowMs: number,
  paceCostPerMin: number,
): UsageRateWindow {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  const startHour = Math.floor(startMs / HOUR_MS);
  for (const h of hours) {
    // A bucket counts when it starts inside [startMs, endMs); hour-aligned block ends are exclusive.
    if (h.hour >= startHour && h.hour * HOUR_MS < endMs) {
      calls += h.calls;
      tokens += h.tokens;
      cost += h.cost;
    }
  }
  const measuredEnd = Math.min(nowMs, endMs);
  const elapsedMin = Math.max(1, (measuredEnd - startMs) / 60_000);
  const remainingMin = Math.max(0, (endMs - measuredEnd) / 60_000);
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
 * Current 5-hour block (starts at the hour of the first call after the previous block ended),
 * the trailing hour, and the busiest completed block in the range as the bar's ceiling. Works
 * on hourly buckets so no rows are loaded.
 */
export function buildLiveStats(
  rangeHours: HourBucket[],
  recentHours: HourBucket[],
  nowMs: number,
): UsageLiveStats {
  const nowHour = Math.floor(nowMs / HOUR_MS);
  const active = recentHours
    .filter((h) => h.calls > 0 && h.hour > nowHour - 5 && h.hour <= nowHour)
    .toSorted((a, b) => a.hour - b.hour);
  let blockStart = nowMs - FIVE_HOURS_MS;
  let blockEnd = nowMs;
  let anchored = false;
  for (const h of active) {
    const ts = h.hour * HOUR_MS;
    if (!anchored || ts >= blockEnd) {
      blockStart = ts;
      blockEnd = ts + FIVE_HOURS_MS;
      anchored = true;
    }
  }
  // Trailing window from the start of the previous hour bucket to now (60-120 minutes), so the
  // pace is measured over exactly the time the counted buckets span.
  const trailingStart = (nowHour - 1) * HOUR_MS;
  const lastHour = rateWindow(recentHours, trailingStart, nowMs, nowMs, 0);
  const paceCostPerMin = lastHour.cost / Math.max(1, (nowMs - trailingStart) / 60_000);
  const window5h = rateWindow(recentHours, blockStart, blockEnd, nowMs, paceCostPerMin);
  const blockStartHour = Math.floor(blockStart / HOUR_MS);
  const before = rangeHours
    .filter((h) => h.hour < blockStartHour)
    .toSorted((a, b) => a.hour - b.hour);
  let peak: UsageLiveStats["peak5h"] = null;
  for (let i = 0; i < before.length; i += 1) {
    let cost = 0;
    let tokens = 0;
    for (let j = i; j < before.length && before[j]!.hour - before[i]!.hour < 5; j += 1) {
      cost += before[j]!.cost;
      tokens += before[j]!.tokens;
    }
    if (!peak || cost > peak.cost) {
      peak = { startMs: before[i]!.hour * HOUR_MS, cost, tokens };
    }
  }
  return { window5h, lastHour, peak5h: peak };
}

export function buildEnergyEstimate(usage: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}): UsageEnergyEstimate {
  // Prefill dominates for fresh input and cache writes; cached reads skip prefill compute; decode
  // is costlier per token. Weights are relative to the 0.24 Wh median-prompt figure.
  const wh =
    (usage.input + usage.cacheWrite) * WH_PER_PREFILL_TOKEN +
    usage.cacheRead * WH_PER_CACHED_TOKEN +
    usage.output * WH_PER_OUTPUT_TOKEN;
  return {
    wh,
    gco2e: wh * GCO2E_PER_WH,
    bandLow: 1 / 3,
    bandHigh: 3,
    method:
      "prefill 0.0003 Wh/token, cached read 0.00003, output 0.001 (Google 2025 median prompt, Mistral LCA); 0.43 kgCO2e/kWh world grid",
  };
}

export function buildOutcomes(
  taskGroups: UsageTaskSummary[],
  taskModelRows: UsageAggregateRow[],
  resolve: TaskOutcomeResolver | undefined,
): UsageOutcomes {
  const empty: UsageOutcomes = {
    tasks: 0,
    succeeded: 0,
    failed: 0,
    stopped: 0,
    costTotal: 0,
    costPerSuccess: null,
    costOnFailures: 0,
    byModel: [],
    byFeature: [],
  };
  if (!resolve || taskGroups.length === 0) {
    return empty;
  }
  const statusOf = new Map<string, string>();
  for (const t of taskGroups) {
    const info = resolve(t.taskId);
    if (
      info &&
      (info.status === "completed" || info.status === "failed" || info.status === "stopped")
    ) {
      statusOf.set(t.taskId, info.status);
    }
  }
  if (statusOf.size === 0) {
    return empty;
  }
  const out = { ...empty };
  for (const t of taskGroups) {
    const status = statusOf.get(t.taskId);
    if (!status) {
      continue;
    }
    out.tasks += 1;
    out.costTotal += t.cost.total;
    if (status === "completed") {
      out.succeeded += 1;
    } else {
      if (status === "failed") {
        out.failed += 1;
      } else {
        out.stopped += 1;
      }
      out.costOnFailures += t.cost.total;
    }
  }
  out.costPerSuccess = out.succeeded > 0 ? out.costTotal / out.succeeded : null;
  type ModelAcc = {
    provider: string | null;
    model: string | null;
    tasks: Set<string>;
    succeeded: Set<string>;
    failed: Set<string>;
    cost: number;
  };
  const perModel = new Map<string, ModelAcc>();
  const perFeature = new Map<
    string,
    { tasks: Set<string>; succeeded: Set<string>; cost: number }
  >();
  for (const row of taskModelRows) {
    const [taskId, provider, model, feature] = String(row.group_key ?? "").split(SEP);
    if (!taskId) {
      continue;
    }
    const status = statusOf.get(taskId);
    if (!status) {
      continue;
    }
    const mk = `${provider || "?"}/${model || "?"}`;
    let m = perModel.get(mk);
    if (!m) {
      m = {
        provider: provider || null,
        model: model || null,
        tasks: new Set(),
        succeeded: new Set(),
        failed: new Set(),
        cost: 0,
      };
      perModel.set(mk, m);
    }
    m.tasks.add(taskId);
    (status === "completed" ? m.succeeded : m.failed).add(taskId);
    m.cost += num(row.cost_total);
    const fk = feature || "unknown";
    let f = perFeature.get(fk);
    if (!f) {
      f = { tasks: new Set(), succeeded: new Set(), cost: 0 };
      perFeature.set(fk, f);
    }
    f.tasks.add(taskId);
    if (status === "completed") {
      f.succeeded.add(taskId);
    }
    f.cost += num(row.cost_total);
  }
  out.byModel = Array.from(perModel.values())
    .map((m) => ({
      provider: m.provider,
      model: m.model,
      tasks: m.tasks.size,
      succeeded: m.succeeded.size,
      failed: m.failed.size,
      costTotal: m.cost,
      costPerSuccess: m.succeeded.size > 0 ? m.cost / m.succeeded.size : null,
    }))
    .toSorted((a, b) => b.costTotal - a.costTotal);
  out.byFeature = Array.from(perFeature.entries())
    .map(([feature, f]) => ({
      feature,
      label: describeUsageFeature(feature),
      tasks: f.tasks.size,
      succeeded: f.succeeded.size,
      costTotal: f.cost,
      costPerSuccess: f.succeeded.size > 0 ? f.cost / f.succeeded.size : null,
    }))
    .toSorted((a, b) => b.costTotal - a.costTotal);
  return out;
}

export function buildRunawayRuns(
  runs: Array<{
    run_id: string;
    session_key: string | null;
    feature: string;
    cost: number;
    calls: number;
    first_ts: number;
    last_ts: number;
  }>,
): UsageRunawayRun[] {
  const costs = runs
    .map((r) => r.cost)
    .filter((c) => c > 0)
    .toSorted((a, b) => a - b);
  if (costs.length < 10) {
    return [];
  }
  const median = costs[Math.floor(costs.length / 2)]!;
  if (median <= 0) {
    return [];
  }
  return runs
    .filter((r) => r.cost >= 5 * median && r.cost >= 1)
    .map((r) => ({
      runId: r.run_id,
      sessionKey: r.session_key,
      feature: r.feature,
      cost: r.cost,
      calls: r.calls,
      startedAt: r.first_ts,
      multiple: r.cost / median,
    }))
    .toSorted((a, b) => b.cost - a.cost)
    .slice(0, 10);
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
  if (health.unreadWriteUsd >= 0.5) {
    const lane = health.unreadByFeature[0];
    flags.push({
      id: "cache-never-read",
      level: "warn",
      message:
        `$${health.unreadWriteUsd.toFixed(2)} of prompt cache was written and never read back` +
        (lane ? ` (${lane.label}: ${lane.requests} requests, $${lane.usd.toFixed(2)})` : ""),
      tip: `Turns are spaced past the ${health.ttl ?? "5m"} cache TTL, so every call re-caches the prompt. A heartbeat due within the TTL now fires right after a user turn; also consider a heartbeat interval under the TTL or cacheRetention: "long" (1h) on Anthropic.`,
    });
  } else if (health.requests >= 10 && health.busts > 0 && health.wastedUsd >= 0.5) {
    const top = health.reasons.find((r) => isBustReason(r.reason));
    flags.push({
      id: "cache-busts",
      level: "warn",
      message:
        `${health.busts} cache bust(s) cost about $${health.wastedUsd.toFixed(2)} in re-written prompt cache` +
        (top ? `; most often: ${top.reason}` : ""),
      tip:
        top?.reason === CACHE_BUST_REASONS.expired
          ? 'Turns are spaced longer than the cache TTL; batch work closer together or set cacheRetention: "long" (1h) on Anthropic.'
          : "Keep the system prompt and tool list stable within a session; a changed prefix invalidates the whole cache.",
    });
  } else {
    for (const m of summary.byModel.filter((m) => m.kinds.includes("chat"))) {
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
        tip: "Check the Live tab for the feature driving it, or ask the agent: /usage why",
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
  if (summary.runawayRuns.length > 0) {
    const r = summary.runawayRuns[0]!;
    flags.push({
      id: "runaway-run",
      level: "warn",
      message: `${summary.runawayRuns.length} run(s) cost 5x or more than the median run; the largest was $${r.cost.toFixed(2)} (${r.calls} calls, ${r.feature})`,
      tip: "Long tool loops are the usual cause; the repeat guard and per-feature budgets bound them.",
    });
  }
  const outcomes = summary.outcomes;
  if (
    outcomes.tasks >= 3 &&
    outcomes.costOnFailures > 0 &&
    outcomes.costOnFailures / Math.max(outcomes.costTotal, 1e-9) > 0.4
  ) {
    flags.push({
      id: "failed-task-spend",
      level: "info",
      message: `${((outcomes.costOnFailures / outcomes.costTotal) * 100).toFixed(0)}% of task spend went to tasks that failed or were stopped`,
      tip: "Compare cost per successful task by model in the Features tab; a cheaper model with a lower resolve rate can still cost more per success.",
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

function emptyDay(day: string): UsageDailyPoint {
  return {
    date: day,
    tokens: 0,
    cost: 0,
    calls: 0,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
    byModel: [],
    byKind: [],
  };
}

export function buildUsageLedgerSummary(params: {
  ledger: UsageLedger;
  cfg: BitterbotConfig | undefined;
  startMs: number;
  endMs: number;
  agentId?: string;
  feature?: string;
  kind?: UsageKind;
  sessionKey?: string;
  nowMs?: number;
  /** Task id -> goal/status; the gateway passes the task store. */
  taskInfo?: TaskOutcomeResolver;
  /** Session key -> label/channel; the gateway passes the session store. */
  sessionInfo?: SessionLabelResolver;
}): UsageLedgerSummary {
  const nowMs = params.nowMs ?? Date.now();
  const filters: Filters = {
    startMs: params.startMs,
    endMs: params.endMs,
    agentId: params.agentId,
    feature: params.feature,
    kind: params.kind,
    sessionKey: params.sessionKey,
  };
  const { ledger } = params;

  const totalsRow = ledger.aggregate(filters)[0];
  const totals =
    totalsRow && num(totalsRow.calls) > 0 ? totalsFromRow(totalsRow) : emptyUsageTotals();

  const facetsByModel = new Map<string, { kinds: Set<UsageKind>; sources: Set<PricingSource> }>();
  for (const f of ledger.modelFacets(filters)) {
    const key = `${f.provider ?? "unknown"}/${f.model ?? "unknown"}`;
    let entry = facetsByModel.get(key);
    if (!entry) {
      entry = { kinds: new Set(), sources: new Set() };
      facetsByModel.set(key, entry);
    }
    entry.kinds.add(f.kind as UsageKind);
    entry.sources.add(f.cost_source as PricingSource);
  }
  const byModel: UsageModelSummary[] = ledger
    .aggregate(
      filters,
      "COALESCE(provider, 'unknown') || '/' || COALESCE(model, 'unknown')",
      ", MIN(provider) AS provider_v, MIN(model) AS model_v",
    )
    .map((row) => {
      const key = String(row.group_key ?? "unknown/unknown");
      const facet = facetsByModel.get(key);
      return {
        provider: (row.provider_v as string | null) ?? null,
        model: (row.model_v as string | null) ?? null,
        kinds: Array.from(facet?.kinds ?? []).toSorted(),
        pricingSources: Array.from(facet?.sources ?? []).toSorted(),
        lastTs: row.last_ts ?? null,
        ...totalsFromRow(row),
      };
    })
    .toSorted(byCostThenTokens);

  const dailyMap = new Map<string, UsageDailyPoint>();
  const startDay = new Date(params.startMs);
  for (
    let t = Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate());
    t <= params.endMs;
    t += DAY_MS
  ) {
    const day = formatUsageDay(t);
    dailyMap.set(day, emptyDay(day));
  }
  for (const row of ledger.aggregate(filters, "day")) {
    const day = String(row.group_key ?? "");
    const point = dailyMap.get(day) ?? emptyDay(day);
    const t = totalsFromRow(row);
    point.tokens = t.usage.total;
    point.cost = t.cost.total;
    point.calls = t.calls;
    point.usage = t.usage;
    dailyMap.set(day, point);
  }
  for (const r of ledger.dailyBy(filters, "model")) {
    dailyMap.get(r.day)?.byModel.push({
      provider: r.provider,
      model: r.model,
      tokens: r.tokens,
      cost: r.cost,
      calls: r.calls,
    });
  }
  for (const r of ledger.dailyBy(filters, "kind")) {
    dailyMap.get(r.day)?.byKind.push({
      kind: (r.kind ?? "chat") as UsageKind,
      tokens: r.tokens,
      cost: r.cost,
      calls: r.calls,
    });
  }
  const daily = Array.from(dailyMap.values())
    .map((d) => ({
      ...d,
      byModel: d.byModel.toSorted((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      byKind: d.byKind.toSorted((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    }))
    .toSorted((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const byTask: UsageTaskSummary[] = ledger
    .aggregate(filters, "task_id", ", COUNT(DISTINCT run_id) AS runs")
    .filter((row) => row.group_key)
    .map((row) => {
      const taskId = String(row.group_key);
      return {
        key: taskId,
        taskId,
        label: params.taskInfo?.(taskId)?.goal ?? taskId,
        runs: num(row.runs),
        ...totalsFromRow(row),
      };
    })
    .toSorted(byCostThenTokens);

  const bySession: UsageSessionSummary[] = ledger
    .aggregate(filters, "session_key", ", MIN(agent_id) AS agent_v, MIN(channel) AS channel_v")
    .filter((row) => row.group_key)
    .map((row) => {
      const sessionKey = String(row.group_key);
      const info = params.sessionInfo?.(sessionKey);
      return {
        key: sessionKey,
        sessionKey,
        label: info?.label ?? sessionKey,
        agentId: (row.agent_v as string | null) ?? info?.agentId ?? null,
        channel: (row.channel_v as string | null) ?? info?.channel ?? null,
        lastTs: row.last_ts ?? null,
        models: [],
        ...totalsFromRow(row),
      };
    })
    .toSorted(byCostThenTokens)
    .slice(0, 100);
  if (bySession.length > 0) {
    const perSession = new Map<string, Array<{ model: string; cost: number }>>();
    for (const row of ledger.aggregate(
      filters,
      "COALESCE(session_key, '') || char(1) || COALESCE(provider, '?') || '/' || COALESCE(model, '?')",
    )) {
      const [sk, model] = String(row.group_key ?? "").split(SEP);
      if (!sk) {
        continue;
      }
      const list = perSession.get(sk) ?? [];
      list.push({ model: model ?? "?", cost: num(row.cost_total) });
      perSession.set(sk, list);
    }
    for (const s of bySession) {
      s.models = (perSession.get(s.sessionKey) ?? [])
        .toSorted((a, b) => b.cost - a.cost)
        .map((m) => m.model);
    }
  }

  const unpricedModels = byModel
    .filter((m) => m.pricingSources.includes("unpriced"))
    .map((m) => ({
      provider: m.provider,
      model: m.model,
      calls: m.unpricedCalls,
      tokens: m.usage.total,
    }));

  const rangeHours = ledger.hourly(filters);
  const recentHours =
    params.startMs <= nowMs - FIVE_HOURS_MS && params.endMs >= nowMs
      ? rangeHours
      : ledger.hourly({ ...filters, startMs: nowMs - FIVE_HOURS_MS, endMs: nowMs });

  const taskModelRows = ledger
    .aggregate(
      filters,
      "COALESCE(task_id, '') || char(1) || COALESCE(provider, '') || char(1) || COALESCE(model, '') || char(1) || feature",
    )
    .filter((row) => String(row.group_key ?? "").split(SEP)[0]);

  const livePricing = getLivePricingStatus();
  const withoutFlags: Omit<UsageLedgerSummary, "flags"> = {
    updatedAt: nowMs,
    startMs: params.startMs,
    endMs: params.endMs,
    startDate: formatUsageDay(params.startMs),
    endDate: formatUsageDay(params.endMs),
    days: Math.max(1, Math.round((params.endMs - params.startMs + 1) / DAY_MS)),
    totals,
    byModel,
    byProvider: groups(ledger, filters, "COALESCE(provider, 'unknown')", (k) => k),
    byFeature: groups(ledger, filters, "feature", describeUsageFeature),
    byKind: groups(ledger, filters, "kind", (k) => k),
    byAgent: groups(ledger, filters, "COALESCE(agent_id, 'unknown')", (k) => k),
    daily,
    byTask,
    bySession,
    outcomes: buildOutcomes(byTask, taskModelRows, params.taskInfo),
    energy: buildEnergyEstimate(totals.usage),
    runawayRuns: buildRunawayRuns(ledger.runCosts(filters)),
    cacheHealth: buildCacheHealth(ledger, filters, nowMs),
    live: buildLiveStats(rangeHours, recentHours, nowMs),
    pricing: {
      liveSnapshots: livePricing.snapshots,
      liveNewestAt: livePricing.newestAt,
      liveEntries: livePricing.entries,
      liveError: livePricing.lastError,
    },
    unpricedModels,
    budgets: evaluateUsageBudgets({ ledger, cfg: params.cfg, nowMs }),
    ledger: ledger.health(resolveUsageRetentionDays(params.cfg)),
  };
  return { ...withoutFlags, flags: buildUsageFlags(withoutFlags) };
}
