/**
 * Transcript preparation for session extraction (token-efficiency pass,
 * 2026-09-19).
 *
 * Flattened session entries (`buildSessionEntry`) are `User: ...` /
 * `Assistant: ...` labeled lines with unlabeled continuation lines. Two
 * transforms run before the extraction prompt is built:
 *
 * 1. `stripHeartbeatTurns`: the heartbeat runner's "Read HEARTBEAT.md ..."
 *    prompt and its HEARTBEAT_OK ack are protocol scaffolding, not memory.
 *    On the reference node the daily main transcript carried 48 such pairs
 *    and the handover brief read "Purpose: Monitor workspace via HEARTBEAT.md
 *    protocol". A transcript with no other turns yields no extraction call.
 * 2. `windowTranscript`: transcripts over the size threshold are split into
 *    line-aligned windows so each call fits the output cap instead of
 *    truncating into unparseable JSON.
 *
 * Both return a `lineMap` (window/filtered 1-based line -> original 1-based
 * line) so evidence citations keep pointing at the real transcript.
 */

import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";

const USER_PREFIX = "User: ";
const ASSISTANT_PREFIX = "Assistant: ";

export type PreparedTranscript = {
  content: string;
  /** index i (0-based line of `content`) -> original 1-based line number. */
  lineMap: number[];
  droppedTurns: number;
};

function isTurnStart(line: string): boolean {
  return line.startsWith(USER_PREFIX) || line.startsWith(ASSISTANT_PREFIX);
}

/** The heartbeat prompt: a user turn that names HEARTBEAT.md and the ack token. */
export function isHeartbeatPromptText(text: string): boolean {
  return /HEARTBEAT\.md/i.test(text) && text.includes(HEARTBEAT_TOKEN);
}

/** A bare HEARTBEAT_OK ack (optional trailing punctuation / whitespace). */
export function isHeartbeatAckText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith(HEARTBEAT_TOKEN)) {
    return false;
  }
  const rest = trimmed.slice(HEARTBEAT_TOKEN.length);
  return rest.length === 0 || !/[A-Za-z0-9_]/.test(rest);
}

type Turn = { role: "user" | "assistant" | "other"; start: number; end: number; text: string };

function splitTurns(lines: string[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isTurnStart(line) || turns.length === 0) {
      const role = line.startsWith(USER_PREFIX)
        ? "user"
        : line.startsWith(ASSISTANT_PREFIX)
          ? "assistant"
          : "other";
      const text =
        role === "user"
          ? line.slice(USER_PREFIX.length)
          : role === "assistant"
            ? line.slice(ASSISTANT_PREFIX.length)
            : line;
      turns.push({ role, start: i, end: i, text });
    } else {
      const cur = turns[turns.length - 1]!;
      cur.end = i;
      cur.text += "\n" + line;
    }
  }
  return turns;
}

/**
 * Drop heartbeat prompt turns and the HEARTBEAT_OK ack that follows each.
 * An assistant reply that is NOT a bare ack (an alert) is kept.
 */
export function stripHeartbeatTurns(content: string): PreparedTranscript {
  if (!content) {
    return { content: "", lineMap: [], droppedTurns: 0 };
  }
  const lines = content.split("\n");
  const turns = splitTurns(lines);
  const keep = Array.from({ length: turns.length }, () => true);
  let dropped = 0;
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t]!;
    if (turn.role === "user" && isHeartbeatPromptText(turn.text)) {
      keep[t] = false;
      dropped++;
      const next = turns[t + 1];
      if (next && next.role === "assistant" && isHeartbeatAckText(next.text)) {
        keep[t + 1] = false;
        dropped++;
        t++;
      }
    } else if (turn.role === "assistant" && isHeartbeatAckText(turn.text)) {
      // Orphan ack (prompt not captured): still scaffolding.
      keep[t] = false;
      dropped++;
    }
  }
  if (dropped === 0) {
    return { content, lineMap: lines.map((_, i) => i + 1), droppedTurns: 0 };
  }
  const out: string[] = [];
  const lineMap: number[] = [];
  for (let t = 0; t < turns.length; t++) {
    if (!keep[t]) {
      continue;
    }
    for (let i = turns[t]!.start; i <= turns[t]!.end; i++) {
      out.push(lines[i]!);
      lineMap.push(i + 1);
    }
  }
  return { content: out.join("\n"), lineMap, droppedTurns: dropped };
}

export type TranscriptWindow = {
  content: string;
  /** index i (0-based line of `content`) -> original 1-based line number. */
  lineMap: number[];
};

/**
 * Split a prepared transcript into windows of at most `maxChars`, breaking
 * only at turn boundaries (a single oversized turn becomes its own window).
 */
export function windowTranscript(
  prepared: PreparedTranscript,
  maxChars: number,
): TranscriptWindow[] {
  if (!prepared.content) {
    return [];
  }
  if (maxChars <= 0 || prepared.content.length <= maxChars) {
    return [{ content: prepared.content, lineMap: prepared.lineMap }];
  }
  const lines = prepared.content.split("\n");
  const turns = splitTurns(lines);
  const windows: TranscriptWindow[] = [];
  let curLines: string[] = [];
  let curMap: number[] = [];
  let curChars = 0;
  const flush = () => {
    if (curLines.length > 0) {
      windows.push({ content: curLines.join("\n"), lineMap: curMap });
    }
    curLines = [];
    curMap = [];
    curChars = 0;
  };
  for (const turn of turns) {
    const turnChars =
      turn.text.length + (turn.role === "user" ? USER_PREFIX.length : ASSISTANT_PREFIX.length);
    if (curChars > 0 && curChars + turnChars > maxChars) {
      flush();
    }
    for (let i = turn.start; i <= turn.end; i++) {
      curLines.push(lines[i]!);
      curMap.push(prepared.lineMap[i] ?? i + 1);
    }
    curChars += turnChars + 1;
  }
  flush();
  return windows;
}

/** Map a 1-based line in a window/filtered transcript back to the original. */
export function remapLine(lineMap: number[], line: number): number {
  return lineMap[line - 1] ?? line;
}
