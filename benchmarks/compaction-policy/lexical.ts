/**
 * Round 2: a lexical (BM25) index over a conversation's dialogue, used for
 *   - a `memory_search` stand-in offered to every arm (production indexes every
 *     user and assistant turn regardless of compaction, so the summary arm must
 *     have it too), and
 *   - the proactive transcript recall arm (L1a): the probe is searched against
 *     the elided dialogue and the top snippets are injected before the model
 *     answers, with no tool call.
 *
 * Production uses embeddings plus FTS; BM25 over the same chunks is a
 * conservative stand-in (no semantic matching), stated in the report.
 */

import type { PolicyEntry } from "../../src/agents/runtime/compaction/types.js";

export type Chunk = {
  entryId: string;
  line: number;
  turn: number;
  role: "user" | "assistant";
  text: string;
};

const STOP = new Set(
  "a an and are as at be but by did do does for from had has have how i if in is it its me my no not of on or our so that the their them then there these they this to was we were what when where which who why will with you your about into than too very can could would should just also any all been being am".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** One chunk per user/assistant entry; long entries are split at `maxChars`. Heartbeats are skipped. */
export function chunkDialogue(entries: readonly PolicyEntry[], maxChars = 1_600): Chunk[] {
  const out: Chunk[] = [];
  for (const e of entries) {
    if ((e.role !== "user" && e.role !== "assistant") || e.isHeartbeatPrompt || e.isHeartbeatAck) {
      continue;
    }
    const text = e.text.trim();
    if (!text) {
      continue;
    }
    for (let i = 0; i < text.length; i += maxChars) {
      out.push({
        entryId: e.id,
        line: e.line,
        turn: e.turn,
        role: e.role,
        text: text.slice(i, i + maxChars),
      });
    }
  }
  return out;
}

export class Bm25 {
  private readonly docs: Array<{ chunk: Chunk; tf: Map<string, number>; len: number }> = [];
  private readonly df = new Map<string, number>();
  private avgLen = 0;

  constructor(chunks: readonly Chunk[]) {
    let total = 0;
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      for (const t of tf.keys()) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
      this.docs.push({ chunk, tf, len: tokens.length });
      total += tokens.length;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
  }

  search(query: string, k: number): Array<{ chunk: Chunk; score: number }> {
    const q = [...new Set(tokenize(query))];
    if (q.length === 0 || this.docs.length === 0) {
      return [];
    }
    const n = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const scored: Array<{ chunk: Chunk; score: number }> = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of q) {
        const tf = d.tf.get(t);
        if (!tf) {
          continue;
        }
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / (this.avgLen || 1)));
      }
      if (score > 0) {
        scored.push({ chunk: d.chunk, score });
      }
    }
    return scored.toSorted((a, b2) => b2.score - a.score).slice(0, k);
  }
}

/** Render snippets for a tool result or an injected recall block, within a char budget. */
export function renderSnippets(
  hits: ReadonlyArray<{ chunk: Chunk; score: number }>,
  maxChars: number,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const h of hits) {
    const line = `[turn ${h.chunk.turn}, e${h.chunk.entryId} L${h.chunk.line}] ${h.chunk.role.toUpperCase()}: ${h.chunk.text.replace(/\s+/g, " ")}`;
    const room = maxChars - used;
    if (room <= 80) {
      break;
    }
    const clipped = line.length > room ? `${line.slice(0, room - 1)}…` : line;
    parts.push(clipped);
    used += clipped.length + 1;
  }
  return parts.join("\n");
}
