/**
 * PLAN-52A `offload` compaction policy: planning (pure).
 *
 * Two mechanisms, chosen by trigger:
 * - mid-turn (T3): tool-output stubs only, oldest first, until the estimate
 *   is under the mid-turn target. No horizon cut inside a turn.
 * - turn-end / turn-start / manual (T1, T2, T5): heartbeat pairs, then a
 *   horizon cut at a user-turn boundary to the target; if the kept region is
 *   still over target, tool-output stubs inside it.
 * - overflow (T4): stubs first, then a horizon cut if still over.
 *
 * The engine owns persistence, lanes, the working-memory flush and the cheap
 * summary; this module only decides what to elide and drafts the entries.
 */

import type { AgentCompactionOffloadConfig } from "../../../config/types.agent-defaults.js";
import { planHeartbeatStubs, planHorizonCut, planToolOutputStubs, totalTokens } from "./cut.js";
import { estimateTextTokens } from "./estimate.js";
import { lastExchangeOf, renderLedger, selectThreads } from "./ledger.js";
import type {
  CompactionEntryDraft,
  CompactionTrigger,
  ElidedRange,
  OffloadPlan,
  PlannedStub,
  PolicyEntry,
  PreviousOffload,
  PruneRecordDraft,
  StubKind,
} from "./types.js";
import { PRUNE_RECORD_CUSTOM_TYPE } from "./types.js";

export type OffloadPolicySettings = {
  triggerTurnEndFraction: number;
  triggerTurnStartFraction: number;
  triggerMidTurnFraction: number;
  targetFraction: number;
  midTurnTargetFraction: number;
  minKeepUserTurns: number;
  toolOutputStubMinTokens: number;
  spareRecentToolResults: number;
  elideHeartbeats: boolean;
  ledgerBudgetTokens: number;
  /**
   * A horizon cut must elide at least this many tokens (and at least twice
   * the ledger it writes), or it is not worth a prefix rewrite. Overflow and
   * manual triggers ignore it. Default 2000.
   */
  minElidedTokens: number;
};

export const DEFAULT_OFFLOAD_SETTINGS: OffloadPolicySettings = {
  triggerTurnEndFraction: 0.55,
  triggerTurnStartFraction: 0.7,
  triggerMidTurnFraction: 0.8,
  targetFraction: 0.35,
  midTurnTargetFraction: 0.5,
  minKeepUserTurns: 2,
  toolOutputStubMinTokens: 1_000,
  spareRecentToolResults: 2,
  elideHeartbeats: true,
  ledgerBudgetTokens: 1_200,
  minElidedTokens: 2_000,
};

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

/** Config -> settings with defaults and sanity bounds. */
export function resolveOffloadSettings(cfg?: AgentCompactionOffloadConfig): OffloadPolicySettings {
  const d = DEFAULT_OFFLOAD_SETTINGS;
  const s: OffloadPolicySettings = {
    triggerTurnEndFraction: num(cfg?.triggerTurnEndFraction, d.triggerTurnEndFraction, 0.1, 0.95),
    triggerTurnStartFraction: num(
      cfg?.triggerTurnStartFraction,
      d.triggerTurnStartFraction,
      0.1,
      0.98,
    ),
    triggerMidTurnFraction: num(cfg?.triggerMidTurnFraction, d.triggerMidTurnFraction, 0.1, 0.98),
    targetFraction: num(cfg?.targetFraction, d.targetFraction, 0.05, 0.9),
    midTurnTargetFraction: num(cfg?.midTurnTargetFraction, d.midTurnTargetFraction, 0.05, 0.95),
    minKeepUserTurns: Math.floor(num(cfg?.minKeepUserTurns, d.minKeepUserTurns, 1, 50)),
    toolOutputStubMinTokens: Math.floor(
      num(cfg?.toolOutputStubMinTokens, d.toolOutputStubMinTokens, 0, 100_000),
    ),
    spareRecentToolResults: Math.floor(
      num(cfg?.spareRecentToolResults, d.spareRecentToolResults, 0, 20),
    ),
    elideHeartbeats: cfg?.elideHeartbeats ?? d.elideHeartbeats,
    ledgerBudgetTokens: Math.floor(num(cfg?.ledgerBudgetTokens, d.ledgerBudgetTokens, 200, 6_000)),
    minElidedTokens: Math.floor(num(cfg?.minElidedTokens, d.minElidedTokens, 0, 200_000)),
  };
  // A target above its trigger would offload every turn.
  if (s.targetFraction >= s.triggerTurnEndFraction) {
    s.targetFraction = Math.max(0.05, s.triggerTurnEndFraction - 0.1);
  }
  if (s.midTurnTargetFraction >= s.triggerMidTurnFraction) {
    s.midTurnTargetFraction = Math.max(0.05, s.triggerMidTurnFraction - 0.1);
  }
  return s;
}

/** Threshold check. `promptTokens` is the whole prompt (system prompt included). */
export function shouldOffload(params: {
  trigger: CompactionTrigger;
  promptTokens: number;
  contextWindow: number;
  settings: OffloadPolicySettings;
}): boolean {
  const { trigger, promptTokens, contextWindow: w, settings: s } = params;
  switch (trigger) {
    case "overflow":
    case "manual":
      return true;
    case "turn-end":
      return promptTokens > s.triggerTurnEndFraction * w;
    case "turn-start":
      return promptTokens > s.triggerTurnStartFraction * w;
    case "mid-turn":
      return promptTokens > s.triggerMidTurnFraction * w;
    default:
      return false;
  }
}

export type PlanOffloadInput = {
  sessionId: string;
  trigger: CompactionTrigger;
  /** Visible path entries (after any earlier compaction cut). */
  entries: readonly PolicyEntry[];
  /** Stubs already recorded on the path. */
  stubbed: ReadonlyMap<string, StubKind>;
  /** Tokens outside `entries`: system prompt, tool definitions, bootstrap files. */
  fixedTokens: number;
  contextWindow: number;
  settings: OffloadPolicySettings;
  previousCompactionId: string | null;
  previousOffloads: PreviousOffload[];
  openItems: string[];
  workingMemoryFlushed: boolean;
  summary?: {
    text: string;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  };
};

function withStubs(
  base: ReadonlyMap<string, StubKind>,
  stubs: readonly PlannedStub[],
): Map<string, StubKind> {
  const m = new Map(base);
  for (const s of stubs) {
    m.set(s.entryId, s.kind);
  }
  return m;
}

function elidedRange(
  sessionId: string,
  elided: readonly PolicyEntry[],
  stubbed: ReadonlyMap<string, StubKind>,
): ElidedRange {
  const first = elided[0]!;
  const last = elided[elided.length - 1]!;
  let heartbeats = 0;
  let toolCalls = 0;
  let userTurns = 0;
  for (const e of elided) {
    if (e.role === "user") {
      userTurns++;
      if (e.isHeartbeatPrompt) {
        heartbeats++;
      }
    }
    if (e.role === "toolResult") {
      toolCalls++;
    }
  }
  const ts = elided.map((e) => e.timestamp).filter((t): t is number => typeof t === "number");
  return {
    sessionId,
    firstEntryId: first.id,
    lastEntryId: last.id,
    jsonlLineFrom: first.line,
    jsonlLineTo: last.line,
    turnFrom: first.turn,
    turnTo: last.turn,
    messages: elided.length,
    userTurns,
    heartbeats,
    toolCalls,
    estTokens: totalTokens(elided, stubbed),
    firstTs: ts.length ? Math.min(...ts) : undefined,
    lastTs: ts.length ? Math.max(...ts) : undefined,
  };
}

function pruneDraft(
  trigger: CompactionTrigger,
  stubs: readonly PlannedStub[],
): PruneRecordDraft | undefined {
  if (stubs.length === 0) {
    return undefined;
  }
  return {
    customType: PRUNE_RECORD_CUSTOM_TYPE,
    data: {
      version: 1,
      trigger,
      stubs: stubs.map((s) => ({
        entryId: s.entryId,
        kind: s.kind,
        chars: s.chars,
        ...(s.toolName ? { toolName: s.toolName } : {}),
      })),
    },
  };
}

/** Plan one offload at the given trigger. Pure. */
export function planOffload(input: PlanOffloadInput): OffloadPlan {
  const { settings: s, entries, trigger } = input;
  const w = input.contextWindow;
  const notes: string[] = [];
  const before = input.fixedTokens + totalTokens(entries, input.stubbed);

  const historyTarget = (fraction: number) =>
    Math.max(0, Math.floor(fraction * w) - input.fixedTokens);

  // ── mid-turn: stubs only ───────────────────────────────────────────────
  if (trigger === "mid-turn") {
    const target = historyTarget(s.midTurnTargetFraction);
    const stubs = planToolOutputStubs({
      entries,
      stubbed: input.stubbed,
      targetTokens: target,
      spareRecentToolResults: s.spareRecentToolResults,
      minTokens: s.toolOutputStubMinTokens,
    });
    const after = input.fixedTokens + totalTokens(entries, withStubs(input.stubbed, stubs));
    if (stubs.length === 0) {
      notes.push("mid-turn: no stubbable tool outputs (all recent, small, or already stubbed)");
    } else {
      notes.push(
        `mid-turn: ${stubs.length} tool output(s) stubbed, ${before - after} tokens freed`,
      );
    }
    return {
      kind: stubs.length ? "stubs" : "none",
      trigger,
      stubs,
      prune: pruneDraft(trigger, stubs),
      estimates: { before, after, target: Math.floor(s.midTurnTargetFraction * w) },
      notes,
    };
  }

  // ── horizon triggers ───────────────────────────────────────────────────
  const target = historyTarget(s.targetFraction);
  let stubs: PlannedStub[] = [];
  let stubbed = input.stubbed;

  if (trigger === "overflow") {
    // Cheapest first: stubs, then the cut only if still over.
    stubs = planToolOutputStubs({
      entries,
      stubbed,
      targetTokens: target,
      spareRecentToolResults: s.spareRecentToolResults,
      minTokens: s.toolOutputStubMinTokens,
    });
    stubbed = withStubs(stubbed, stubs);
    if (totalTokens(entries, stubbed) <= target) {
      notes.push(`overflow: ${stubs.length} stub(s) sufficed, no horizon cut`);
      return {
        kind: stubs.length ? "stubs" : "none",
        trigger,
        stubs,
        prune: pruneDraft(trigger, stubs),
        estimates: {
          before,
          after: input.fixedTokens + totalTokens(entries, stubbed),
          target: Math.floor(s.targetFraction * w),
        },
        notes,
      };
    }
  }

  if (s.elideHeartbeats) {
    const hb = planHeartbeatStubs({ entries, stubbed });
    if (hb.length) {
      notes.push(`${hb.length / 2} heartbeat pair(s) elided`);
    }
    stubs = [...stubs, ...hb];
    stubbed = withStubs(stubbed, hb);
  }

  let cut = planHorizonCut({
    entries,
    stubbed,
    targetTokens: target,
    minKeepUserTurns: s.minKeepUserTurns,
  });

  // Minimum gain: a cut that saves less than the ledger costs (or less than
  // minElidedTokens) is a prefix rewrite for nothing. Overflow and manual
  // triggers take whatever they can get.
  if (cut && trigger !== "overflow" && trigger !== "manual") {
    const floor = Math.max(s.minElidedTokens, 2 * Math.min(s.ledgerBudgetTokens, 400));
    if (cut.elidedTokens < floor) {
      notes.push(
        `horizon cut skipped: it would elide only ${cut.elidedTokens} tokens (minimum ${floor})`,
      );
      cut = null;
    }
  }

  if (!cut) {
    // Still over target with nothing to cut (one huge turn): stub inside it.
    const more = planToolOutputStubs({
      entries,
      stubbed,
      targetTokens: target,
      spareRecentToolResults: s.spareRecentToolResults,
      minTokens: s.toolOutputStubMinTokens,
    });
    stubs = [...stubs, ...more];
    stubbed = withStubs(stubbed, more);
    const after = input.fixedTokens + totalTokens(entries, stubbed);
    notes.push(
      more.length
        ? `no user-turn boundary to cut at; ${more.length} tool output(s) stubbed instead`
        : "nothing to elide: history fits or only the current turn exists",
    );
    return {
      kind: stubs.length ? "stubs" : "none",
      trigger,
      stubs,
      prune: pruneDraft(trigger, stubs),
      estimates: { before, after, target: Math.floor(s.targetFraction * w) },
      notes,
    };
  }

  // Kept region still over target: stub its older tool outputs too.
  const kept = entries.slice(cut.cutIndex);
  if (totalTokens(kept, stubbed) > target) {
    const more = planToolOutputStubs({
      entries: kept,
      stubbed,
      targetTokens: target,
      spareRecentToolResults: s.spareRecentToolResults,
      minTokens: s.toolOutputStubMinTokens,
    });
    if (more.length) {
      notes.push(`kept region over target after the cut; ${more.length} tool output(s) stubbed`);
    }
    stubs = [...stubs, ...more];
    stubbed = withStubs(stubbed, more);
  }

  const elided = entries.slice(0, cut.cutIndex);
  const range = elidedRange(input.sessionId, elided, input.stubbed);
  const hbPairs = stubs.filter((st) => st.kind === "heartbeat_pair");
  const hbLast = elided
    .filter((e) => e.isHeartbeatPrompt)
    .map((e) => e.timestamp)
    .filter((t): t is number => typeof t === "number");
  const summaryText = input.summary?.text;
  const ledger = renderLedger({
    elided: range,
    threads: selectThreads(elided),
    heartbeats: {
      count: range.heartbeats,
      lastTs: hbLast.length ? Math.max(...hbLast) : undefined,
    },
    openItems: input.openItems,
    lastExchange: lastExchangeOf(elided),
    previousOffloads: input.previousOffloads,
    workingMemoryFlushed: input.workingMemoryFlushed,
    summary: summaryText,
    budgetTokens: s.ledgerBudgetTokens,
  });
  const keptTokens = totalTokens(kept, stubbed);
  const after = input.fixedTokens + estimateTextTokens(ledger) + keptTokens;
  const compaction: CompactionEntryDraft = {
    summary: ledger,
    firstKeptEntryId: cut.firstKeptEntryId,
    tokensBefore: before,
    details: {
      policy: "offload",
      version: 1,
      trigger,
      elided: range,
      kept: { firstEntryId: cut.firstKeptEntryId, estTokens: keptTokens },
      previousCompactionId: input.previousCompactionId,
      previousOffloads: input.previousOffloads,
      workingMemoryFlushed: input.workingMemoryFlushed,
      ...(input.summary
        ? {
            summary: {
              model: input.summary.model,
              costUsd: input.summary.costUsd,
              inputTokens: input.summary.inputTokens,
              outputTokens: input.summary.outputTokens,
            },
          }
        : {}),
    },
  };
  notes.push(
    `horizon cut at turn ${entries[cut.cutIndex]!.turn} (entry ${cut.firstKeptEntryId}): ${range.messages} messages / ~${range.estTokens} tokens elided, ${hbPairs.length / 2} heartbeat pair(s)`,
  );
  // Heartbeat stubs inside the elided range are moot (the cut hides them);
  // only stubs in the kept region need a prune record.
  const keptIds = new Set(kept.map((e) => e.id));
  const keptStubs = stubs.filter((st) => keptIds.has(st.entryId));
  return {
    kind: "horizon",
    trigger,
    cut,
    stubs: keptStubs,
    compaction,
    prune: pruneDraft(trigger, keptStubs),
    estimates: { before, after, target: Math.floor(s.targetFraction * w) },
    notes,
  };
}
