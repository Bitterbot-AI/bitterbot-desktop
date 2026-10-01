/**
 * Cut simulation: replay a session turn by turn, fire the offload policy's
 * turn-end trigger exactly where the runtime would, and record each cut with
 * the entries elided and kept at that moment. Later turns are never visible
 * to a cut (they have not happened yet).
 *
 * Per-set budget modes (PLAN-52A Section 5.1):
 *   production  W = 200k, fixed = 20k (sets A, C, D)
 *   history     W' = trigger / 0.55 with fixed = 0 (set B), stated non-production
 */

import fs from "node:fs/promises";
import path from "node:path";
import { totalTokens } from "../../src/agents/runtime/compaction/cut.js";
import {
  DEFAULT_OFFLOAD_SETTINGS,
  planOffload,
  shouldOffload,
  type OffloadPolicySettings,
} from "../../src/agents/runtime/compaction/offload-policy.js";
import {
  buildTranscriptView,
  parseJsonl,
} from "../../src/agents/runtime/compaction/transcript-view.js";
import type {
  OffloadPlan,
  PolicyEntry,
  StubKind,
} from "../../src/agents/runtime/compaction/types.js";
import type { CorpusSession, CorpusSet } from "./corpus.js";

export type BudgetMode = {
  contextWindow: number;
  fixedTokens: number;
  label: string;
  /**
   * Use the real prompt size recorded on the last assistant message of the
   * turn (`usage.input + cacheRead + cacheWrite`) for the trigger check, as
   * pi does, and calibrate the planner's fixed share so its estimate of the
   * prompt equals that real size. Production-shaped sets only.
   */
  useActualUsage: boolean;
};

/**
 * Set A runs at the production window with real usage for the trigger (these
 * sessions reached 133k to 190k prompt tokens; chars/4 over their history says
 * 37k to 64k, because the system prompt was ~50k at the time and JSON-heavy
 * tool output tokenises denser than 4 chars/token). Sets B, C and D are far
 * too small for a 200k window and run at a reduced history budget, which is
 * stated in the report as a non-production trigger regime.
 */
/**
 * Per-set planner settings. Set A sessions have three to five user turns, one
 * of them the tool-heavy turn that caused the overflow; with the default keep
 * floor of two real turns the only legal cut frees a few hundred tokens and
 * the guard skips it, so set A runs with a one-turn floor (stated in the
 * report). The history-budget sets lower the minimum-gain floor in proportion.
 */
export function settingsFor(set: CorpusSet): OffloadPolicySettings {
  if (set === "A") {
    return { ...DEFAULT_OFFLOAD_SETTINGS, minKeepUserTurns: 1 };
  }
  return { ...DEFAULT_OFFLOAD_SETTINGS, minElidedTokens: 800 };
}

export function budgetModeFor(set: CorpusSet): BudgetMode {
  const history = (trigger: number, label: string): BudgetMode => ({
    contextWindow: Math.round(trigger / DEFAULT_OFFLOAD_SETTINGS.triggerTurnEndFraction),
    fixedTokens: 0,
    label,
    useActualUsage: false,
  });
  switch (set) {
    case "A":
      return {
        contextWindow: 200_000,
        fixedTokens: 20_000,
        label: "production-200k",
        useActualUsage: true,
      };
    case "D":
      return history(2_000, "history-2k");
    default:
      return history(3_000, "history-3k");
  }
}

/** Real prompt size at the end of a turn, from the last assistant entry that recorded usage. */
export function lastActualPrompt(visible: readonly PolicyEntry[]): number | undefined {
  for (let i = visible.length - 1; i >= 0; i--) {
    const e = visible[i]!;
    if (e.role === "assistant" && typeof e.promptTokensActual === "number") {
      return e.promptTokensActual;
    }
  }
  return undefined;
}

export type CutRecord = {
  cutId: string;
  sessionId: string;
  set: CorpusSet;
  budget: BudgetMode;
  /** Turn ordinal at whose end the trigger fired. */
  atTurn: number;
  plan: OffloadPlan;
  /** Entry ids elided by this cut (the previous visible region up to the cut). */
  elidedIds: string[];
  /** Entry ids kept at the moment of the cut (cut .. end of turn). */
  keptIds: string[];
  /** Stubs in force after this cut (cumulative). */
  stubbed: Array<[string, StubKind]>;
  /** Transcript file truncated to this moment, with the compaction + prune entries appended. */
  cutFilePath: string;
  cutSessionId: string;
};

/** Replay one session and return its cuts. Pure except for writing cut files. */
export async function simulateCuts(params: {
  session: CorpusSession;
  heartbeatPrompts: readonly string[];
  settings?: OffloadPolicySettings;
  cutsDir: string;
}): Promise<CutRecord[]> {
  const settings = params.settings ?? settingsFor(params.session.set);
  const raw = await fs.readFile(params.session.filePath, "utf-8");
  const records = parseJsonl(raw);
  const view = buildTranscriptView({
    records,
    sessionIdFallback: params.session.sessionId,
    heartbeatPrompts: params.heartbeatPrompts,
  });
  const budget = budgetModeFor(params.session.set);
  const all = view.allEntries;
  const cuts: CutRecord[] = [];
  let visibleStart = 0; // index into `all` of the first visible entry
  let stubbed = new Map<string, StubKind>(view.stubbedIds);
  let previousCompactionId: string | null = null;
  let previousOffloads = [...view.previousOffloads];
  const lastTurn = all.length ? all[all.length - 1]!.turn : 0;

  // The last turn is included: the probe plays the part of the next message.
  for (let turn = 1; turn <= lastTurn; turn++) {
    // End of this turn = index of the last entry with .turn === turn.
    let endIdx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.turn === turn) {
        endIdx = i;
        break;
      }
    }
    if (endIdx < visibleStart) {
      continue;
    }
    const visible: PolicyEntry[] = all.slice(visibleStart, endIdx + 1);
    const estimatedHistory = totalTokens(visible, stubbed);
    const actual = budget.useActualUsage ? lastActualPrompt(visible) : undefined;
    const promptTokens = actual ?? budget.fixedTokens + estimatedHistory;
    // Calibrated fixed share: with real usage, everything the estimate does not
    // see (system prompt of the day, tokenizer density) lands in `fixed`, so the
    // planner's before/after numbers line up with reality.
    const fixedTokens =
      actual !== undefined
        ? Math.max(budget.fixedTokens, actual - estimatedHistory)
        : budget.fixedTokens;
    if (
      !shouldOffload({
        trigger: "turn-end",
        promptTokens,
        contextWindow: budget.contextWindow,
        settings,
      })
    ) {
      continue;
    }
    const plan = planOffload({
      sessionId: params.session.sessionId,
      trigger: "turn-end",
      entries: visible,
      stubbed,
      fixedTokens,
      contextWindow: budget.contextWindow,
      settings,
      previousCompactionId,
      previousOffloads,
      openItems: [],
      workingMemoryFlushed: false,
    });
    for (const s of plan.stubs) {
      stubbed.set(s.entryId, s.kind);
    }
    if (plan.kind !== "horizon" || !plan.cut || !plan.compaction) {
      continue; // stubs-only plans do not create a probe-able elided range
    }
    const cutIndexAbs = visibleStart + plan.cut.cutIndex;
    const elided = all.slice(visibleStart, cutIndexAbs);
    const kept = all.slice(cutIndexAbs, endIdx + 1);
    const shortId =
      params.session.sessionId.length <= 12
        ? params.session.sessionId
        : params.session.sessionId.slice(0, 8);
    const cutId = `${shortId}-t${turn}`;
    const cutSessionId = `${params.session.sessionId}--${cutId}`;
    const compactionId = `cmp-${cutId}`;
    // Materialise the transcript as it stood at this moment: every record up to
    // the kept end, then the compaction entry and the prune record.
    const upto = records.filter((r) => r.__line <= kept[kept.length - 1]!.line);
    const lines = upto.map((r) => {
      const rec: Record<string, unknown> = { ...r };
      delete rec.__line;
      if (rec.type === "session") {
        rec.id = cutSessionId;
      }
      return JSON.stringify(rec);
    });
    const lastId = kept[kept.length - 1]!.id;
    lines.push(
      JSON.stringify({
        type: "compaction",
        id: compactionId,
        parentId: lastId,
        timestamp: new Date().toISOString(),
        summary: plan.compaction.summary,
        firstKeptEntryId: plan.compaction.firstKeptEntryId,
        tokensBefore: plan.compaction.tokensBefore,
        details: plan.compaction.details,
        fromHook: false,
      }),
    );
    if (plan.prune) {
      lines.push(
        JSON.stringify({
          type: "custom",
          id: `prune-${cutId}`,
          parentId: compactionId,
          timestamp: new Date().toISOString(),
          customType: plan.prune.customType,
          data: plan.prune.data,
        }),
      );
    }
    await fs.mkdir(params.cutsDir, { recursive: true });
    const cutFilePath = path.join(params.cutsDir, `${cutSessionId}.jsonl`);
    await fs.writeFile(cutFilePath, lines.join("\n") + "\n", "utf-8");
    cuts.push({
      cutId,
      sessionId: params.session.sessionId,
      set: params.session.set,
      budget,
      atTurn: turn,
      plan,
      elidedIds: elided.map((e) => e.id),
      keptIds: kept.map((e) => e.id),
      stubbed: [...stubbed.entries()],
      cutFilePath,
      cutSessionId,
    });
    // Apply the cut for the rest of the replay.
    visibleStart = cutIndexAbs;
    previousCompactionId = compactionId;
    previousOffloads = [
      ...previousOffloads,
      {
        compactionId,
        turnFrom: plan.compaction.details.elided.turnFrom,
        turnTo: plan.compaction.details.elided.turnTo,
        firstEntryId: plan.compaction.details.elided.firstEntryId,
        lastEntryId: plan.compaction.details.elided.lastEntryId,
      },
    ];
    stubbed = new Map(stubbed);
  }
  return cuts;
}
