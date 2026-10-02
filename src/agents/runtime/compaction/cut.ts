/**
 * Horizon cut and stub planning (pure).
 *
 * Horizon cut: choose a user-turn boundary so that everything from it onward
 * fits the target, never splitting a tool_use/tool_result pair and never
 * cutting inside the current (last) turn. Keep at least `minKeepUserTurns`
 * complete real turns (bare heartbeat pairs do not count as real).
 *
 * Tool-output stubs: oldest first, the most recent `spareRecentToolResults`
 * exempt, results under `minTokens` exempt (the marker would not pay for
 * itself), until the estimate reaches the target.
 */

import {
  STUB_MARKER_TOKENS,
  type HorizonCut,
  type PlannedStub,
  type PolicyEntry,
  type PolicyTurn,
  type StubKind,
} from "./types.js";

/** Effective token size of an entry given the stubs already applied. */
export function effectiveTokens(
  entry: PolicyEntry,
  stubbed: ReadonlyMap<string, StubKind>,
): number {
  const kind = stubbed.get(entry.id);
  if (kind === "heartbeat_pair") {
    return 0;
  }
  if (kind === "tool_result") {
    return Math.min(entry.tokens, STUB_MARKER_TOKENS);
  }
  return entry.tokens;
}

export function totalTokens(
  entries: readonly PolicyEntry[],
  stubbed: ReadonlyMap<string, StubKind>,
): number {
  let sum = 0;
  for (const e of entries) {
    sum += effectiveTokens(e, stubbed);
  }
  return sum;
}

/** Segment entries into user turns. Entries before the first user entry form turn 0. */
export function segmentTurns(
  entries: readonly PolicyEntry[],
  stubbed: ReadonlyMap<string, StubKind>,
): PolicyTurn[] {
  const turns: PolicyTurn[] = [];
  let current: PolicyTurn | null = null;
  let ackOnly = true;
  let sawTool = false;
  const close = (endIndex: number) => {
    if (!current) {
      return;
    }
    current.endIndex = endIndex;
    const first = entries[current.startIndex]!;
    current.isHeartbeatPair =
      first.role === "user" &&
      first.isHeartbeatPrompt &&
      ackOnly &&
      !sawTool &&
      current.endIndex > current.startIndex;
    turns.push(current);
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.role === "user" || current === null) {
      close(i - 1);
      current = { turn: e.turn, startIndex: i, endIndex: i, tokens: 0, isHeartbeatPair: false };
      ackOnly = true;
      sawTool = false;
    }
    current.tokens += effectiveTokens(e, stubbed);
    if (e.role === "assistant" && (!e.isHeartbeatAck || e.toolCallIds.length > 0)) {
      ackOnly = false;
    }
    if (e.role === "toolResult") {
      sawTool = true;
    }
  }
  close(entries.length - 1);
  return turns;
}

export function planHorizonCut(params: {
  entries: readonly PolicyEntry[];
  stubbed: ReadonlyMap<string, StubKind>;
  targetTokens: number;
  minKeepUserTurns: number;
}): HorizonCut | null {
  const { entries, stubbed } = params;
  if (entries.length === 0) {
    return null;
  }
  const turns = segmentTurns(entries, stubbed);
  if (turns.length < 2) {
    return null; // only the current turn: nothing to cut without splitting it
  }
  const minKeep = Math.max(1, Math.floor(params.minKeepUserTurns));

  // Walk back from the newest turn. The current turn is always kept whole.
  let kept = 0;
  let realKept = 0;
  let chosen: number | null = null; // index into turns of the first kept turn
  for (let t = turns.length - 1; t >= 1; t--) {
    const turn = turns[t]!;
    kept += turn.tokens;
    if (!turn.isHeartbeatPair) {
      realKept++;
    }
    const nextOlder = turns[t - 1]!;
    const wouldExceed = kept + nextOlder.tokens > params.targetTokens;
    if (wouldExceed && realKept >= minKeep) {
      chosen = t;
      break;
    }
  }
  if (chosen === null) {
    // Everything fits, or we never reached minKeep: nothing to elide.
    return null;
  }
  // Make sure the kept region includes minKeep real turns; move the cut
  // older while it does not (budget be damned, stubs come next).
  while (chosen > 1 && realKept < minKeep) {
    chosen--;
    if (!turns[chosen]!.isHeartbeatPair) {
      realKept++;
    }
  }
  const firstKept = turns[chosen]!;
  const cutIndex = firstKept.startIndex;
  const elided = entries.slice(0, cutIndex);
  if (elided.length === 0) {
    return null;
  }
  const elidedTokens = totalTokens(elided, stubbed);
  const keptTokens = totalTokens(entries.slice(cutIndex), stubbed);
  return {
    cutIndex,
    firstKeptEntryId: entries[cutIndex]!.id,
    turnFrom: elided[0]!.turn,
    turnTo: elided[elided.length - 1]!.turn,
    elidedTokens,
    keptTokens,
  };
}

export function planToolOutputStubs(params: {
  entries: readonly PolicyEntry[];
  stubbed: ReadonlyMap<string, StubKind>;
  targetTokens: number;
  spareRecentToolResults: number;
  minTokens: number;
}): PlannedStub[] {
  const { entries, stubbed } = params;
  let current = totalTokens(entries, stubbed);
  if (current <= params.targetTokens) {
    return [];
  }
  const toolIdx: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.role === "toolResult") {
      toolIdx.push(i);
    }
  }
  const spare = new Set(toolIdx.slice(-Math.max(0, Math.floor(params.spareRecentToolResults))));
  const out: PlannedStub[] = [];
  for (const i of toolIdx) {
    if (current <= params.targetTokens) {
      break;
    }
    const e = entries[i]!;
    if (spare.has(i) || stubbed.has(e.id) || e.tokens < params.minTokens) {
      continue;
    }
    const saved = e.tokens - Math.min(e.tokens, STUB_MARKER_TOKENS);
    if (saved <= 0) {
      continue;
    }
    out.push({
      entryId: e.id,
      kind: "tool_result",
      chars: e.text.length,
      tokensSaved: saved,
      toolName: e.toolName,
    });
    current -= saved;
  }
  return out;
}

/** Every bare heartbeat pair (prompt + ack) not already stubbed, both entries. */
export function planHeartbeatStubs(params: {
  entries: readonly PolicyEntry[];
  stubbed: ReadonlyMap<string, StubKind>;
}): PlannedStub[] {
  const turns = segmentTurns(params.entries, params.stubbed);
  const out: PlannedStub[] = [];
  for (const t of turns) {
    if (!t.isHeartbeatPair) {
      continue;
    }
    for (let i = t.startIndex; i <= t.endIndex; i++) {
      const e = params.entries[i]!;
      if (params.stubbed.has(e.id)) {
        continue;
      }
      out.push({
        entryId: e.id,
        kind: "heartbeat_pair",
        chars: e.text.length,
        tokensSaved: e.tokens,
      });
    }
  }
  return out;
}

/** Render the in-window marker for a stubbed tool output. */
export function renderToolStubMarker(stub: {
  toolName?: string;
  chars: number;
  entryId: string;
  toolCallId?: string;
}): string {
  if (stub.toolCallId) {
    return `[tool output offloaded: ${stub.toolName ?? "tool"}, ${stub.chars.toLocaleString()} chars; full text: recall_range tool_call_id ${stub.toolCallId}]`;
  }
  return `[tool output offloaded: ${stub.toolName ?? "tool"}, ${stub.chars.toLocaleString()} chars; full text: recall_range entry ${stub.entryId}]`;
}
