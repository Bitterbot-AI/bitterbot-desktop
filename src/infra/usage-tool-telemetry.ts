/**
 * Tool-call telemetry and prefix-stability summaries over the usage ledger.
 *
 * - Hot-set proof: how often the agent reached tools directly (the hot set), through the
 *   `use_tool` dispatcher, through native tool search, or by listing; which deferred tools it
 *   keeps reaching indirectly (promotion candidates); how many results spilled to disk.
 * - Prefix stability: sessions whose cached prefix (stable system block or tool list) changed
 *   between turns closer together than the cache TTL, and which tier moved.
 *
 * Pure over the ledger so `bitterbot gateway usage --tools` and doctor share one code path.
 */

import type { UsageLedger } from "./usage-ledger.js";
import type {
  UsagePrefixChange,
  UsagePrefixStability,
  UsageToolTelemetry,
} from "./usage-ledger.types.js";

const DAY_MS = 24 * 60 * 60_000;

/** Indirect calls per 7 days at which a deferred tool should join the hot set. */
export const HOT_SET_PROMOTE_MIN_INDIRECT_PER_WEEK = 5;
/** Turns closer than this are "mid-session" for the prefix-stability check (the 1h TTL). */
export const PREFIX_STABILITY_MAX_GAP_MS = 60 * 60_000;

export function buildToolTelemetry(
  ledger: UsageLedger,
  window: { startMs: number; endMs: number },
): UsageToolTelemetry {
  const days = Math.max(1, (window.endMs - window.startMs) / DAY_MS);
  const facets = ledger.toolCallFacets(window);
  const out: UsageToolTelemetry = {
    startMs: window.startMs,
    endMs: window.endMs,
    days,
    calls: 0,
    direct: 0,
    useTool: 0,
    useToolFailed: 0,
    nativeSearch: 0,
    listTools: 0,
    failed: 0,
    indirect: [],
    promote: [],
    promoteThreshold: HOT_SET_PROMOTE_MIN_INDIRECT_PER_WEEK,
    spilled: { calls: 0, avgChars: 0, byTool: [] },
    errorClasses: [],
  };
  const indirect = new Map<string, { calls: number; failed: number }>();
  const spilledByTool = new Map<string, number>();
  let spilledChars = 0;
  for (const f of facets) {
    const calls = Number(f.calls ?? 0);
    const failed = Number(f.failed ?? 0);
    out.calls += calls;
    out.failed += failed;
    switch (f.via) {
      case "direct":
        out.direct += calls;
        break;
      case "use_tool":
        out.useTool += calls;
        out.useToolFailed += failed;
        break;
      case "native-search":
        out.nativeSearch += calls;
        break;
      case "list_tools":
        out.listTools += calls;
        break;
    }
    if (f.via === "use_tool" || f.via === "native-search") {
      const acc = indirect.get(f.tool) ?? { calls: 0, failed: 0 };
      acc.calls += calls;
      acc.failed += failed;
      indirect.set(f.tool, acc);
    }
    const spilled = Number(f.spilled ?? 0);
    if (spilled > 0) {
      out.spilled.calls += spilled;
      spilledChars += Number(f.spilled_chars ?? 0);
      spilledByTool.set(f.tool, (spilledByTool.get(f.tool) ?? 0) + spilled);
    }
  }
  out.indirect = Array.from(indirect.entries())
    .map(([tool, v]) => ({ tool, ...v }))
    .toSorted((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  // Threshold is per week; scale it to the window so a 30d window does not promote everything.
  const perWindow = (HOT_SET_PROMOTE_MIN_INDIRECT_PER_WEEK * days) / 7;
  out.promote = out.indirect
    .filter((t) => t.calls >= perWindow && !t.tool.startsWith("tool_search_tool"))
    .map((t) => t.tool);
  out.spilled.avgChars = out.spilled.calls > 0 ? Math.round(spilledChars / out.spilled.calls) : 0;
  out.spilled.byTool = Array.from(spilledByTool.entries())
    .map(([tool, calls]) => ({ tool, calls }))
    .toSorted((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  out.errorClasses = ledger
    .toolErrorClasses(window)
    .map((r) => ({ errorClass: r.error_class, calls: Number(r.calls ?? 0) }));
  return out;
}

/**
 * Walk each session's chat rows in time order; a change of the stable-block digest or the
 * tools digest between two turns less than `maxGapMs` apart is a mid-session prefix change
 * (a cache bust the operator can fix). Rows without a digest (older releases, other lanes)
 * are skipped, never counted as changes.
 */
export function buildPrefixStability(
  ledger: UsageLedger,
  window: { startMs: number; endMs: number },
  opts?: { maxGapMs?: number },
): UsagePrefixStability {
  const maxGapMs = opts?.maxGapMs ?? PREFIX_STABILITY_MAX_GAP_MS;
  const rows = ledger.prefixDigestRows(window);
  const sessions = new Map<
    string,
    UsagePrefixChange & {
      prevTs: number;
      prevPrefix: string | null;
      prevTools: string | null;
      tools: number;
      system: number;
    }
  >();
  for (const r of rows) {
    const key = r.session_key;
    const acc = sessions.get(key);
    if (!acc) {
      sessions.set(key, {
        sessionKey: key,
        turns: 1,
        changes: 0,
        tier: "system",
        lastChangeTs: 0,
        prevTs: r.ts,
        prevPrefix: r.prefix_digest,
        prevTools: r.tools_digest,
        tools: 0,
        system: 0,
      });
      continue;
    }
    acc.turns += 1;
    const close = r.ts - acc.prevTs < maxGapMs;
    const prefixMoved =
      close &&
      acc.prevPrefix !== null &&
      r.prefix_digest !== null &&
      r.prefix_digest !== acc.prevPrefix;
    const toolsMoved =
      close &&
      acc.prevTools !== null &&
      r.tools_digest !== null &&
      r.tools_digest !== acc.prevTools;
    if (prefixMoved || toolsMoved) {
      acc.changes += 1;
      acc.lastChangeTs = r.ts;
      if (prefixMoved) {
        acc.system += 1;
      }
      if (toolsMoved) {
        acc.tools += 1;
      }
    }
    acc.prevTs = r.ts;
    acc.prevPrefix = r.prefix_digest ?? acc.prevPrefix;
    acc.prevTools = r.tools_digest ?? acc.prevTools;
  }
  const changed: UsagePrefixChange[] = [];
  for (const acc of sessions.values()) {
    if (acc.changes === 0) {
      continue;
    }
    changed.push({
      sessionKey: acc.sessionKey,
      turns: acc.turns,
      changes: acc.changes,
      tier: acc.tools > 0 && acc.system > 0 ? "both" : acc.tools > 0 ? "tools" : "system",
      lastChangeTs: acc.lastChangeTs,
    });
  }
  changed.sort((a, b) => b.changes - a.changes || b.lastChangeTs - a.lastChangeTs);
  return {
    startMs: window.startMs,
    endMs: window.endMs,
    sessions: sessions.size,
    changed,
    maxGapMs,
  };
}

export const PREFIX_STABILITY_TIP =
  "a prompt section above the cache boundary is changing between turns; run with BITTERBOT_CACHE_TRACE=1 to see which";

export function describeHotSet(t: UsageToolTelemetry, days = Math.round(t.days)): string {
  const top = t.indirect
    .slice(0, 5)
    .map((x) => `${x.tool} (${x.calls}${x.failed > 0 ? `, ${x.failed} failed` : ""})`)
    .join(", ");
  return (
    `hot-set: ${t.direct} direct calls, ${t.useTool} via use_tool (${t.useToolFailed} failed), ` +
    `${t.nativeSearch} via native search in ${days}d; top deferred tools reached indirectly: ${top || "none"}`
  );
}

export function describePromoteTip(t: UsageToolTelemetry): string | undefined {
  if (t.promote.length === 0) {
    return undefined;
  }
  return `Add ${t.promote.join(", ")} to tools.hotSet: reached indirectly ${t.promoteThreshold}+ times a week, so the use_tool detour costs more than the schema would.`;
}

export function describeSpilled(t: UsageToolTelemetry, days = Math.round(t.days)): string {
  if (t.spilled.calls === 0) {
    return `tool results spilled: 0 in ${days}d`;
  }
  const by = t.spilled.byTool
    .slice(0, 4)
    .map((x) => `${x.tool} ${x.calls}`)
    .join(", ");
  return `tool results spilled: ${t.spilled.calls} in ${days}d, avg ${t.spilled.avgChars.toLocaleString("en-US")} chars (${by})`;
}

export function describePrefixStability(p: UsagePrefixStability, days: number): string {
  const n = p.changed.length;
  if (n === 0) {
    return `prefix stability: ${p.sessions} session(s) in ${days}d, none changed their cached prefix mid-session`;
  }
  const detail = p.changed
    .slice(0, 5)
    .map((c) => `${c.sessionKey}, ${c.turns} turns, ${c.changes} change(s), likely tier: ${c.tier}`)
    .join("; ");
  return `prefix stability: ${n} session(s) in ${days}d where the cached prefix changed mid-session (turns < ${Math.round(p.maxGapMs / 60_000)} min apart): ${detail}`;
}

/** CLI lines for `bitterbot gateway usage --tools`. */
export function renderToolTelemetry(params: {
  tools: UsageToolTelemetry;
  prefix: UsagePrefixStability;
  days: number;
}): string[] {
  const { tools: t, prefix: p, days } = params;
  const lines: string[] = [];
  lines.push(`Tool calls, last ${days}d: ${t.calls} (${t.failed} failed)`);
  lines.push(`  ${describeHotSet(t, days)}`);
  const tip = describePromoteTip(t);
  if (tip) {
    lines.push(`  tip: ${tip}`);
  }
  if (t.listTools > 0) {
    lines.push(`  list_tools calls: ${t.listTools}`);
  }
  if (t.indirect.length > 5) {
    lines.push(
      `  other indirect: ${t.indirect
        .slice(5, 15)
        .map((x) => `${x.tool} ${x.calls}`)
        .join(", ")}`,
    );
  }
  lines.push(`  ${describeSpilled(t, days)}`);
  if (t.errorClasses.length > 0) {
    lines.push(
      `  failures by class: ${t.errorClasses.map((e) => `${e.errorClass} ${e.calls}`).join(", ")}`,
    );
  }
  lines.push(`  ${describePrefixStability(p, days)}`);
  if (p.changed.length > 0) {
    lines.push(`  tip: ${PREFIX_STABILITY_TIP}`);
  }
  return lines;
}
