/**
 * PLAN-40 Lane 2: memory hygiene. Covers clustering (same-type, threshold,
 * one-shot exclusion), merge flow through the ops callback with funnel
 * production rows, the skill-crystal exclusion, staleness ask ordering
 * (enqueue-then-stamp) and the 3-ask 'unconfirmed' terminal state, and
 * budget/ops-absent no-op paths.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { findMergeClusters, runHygiene, type HygieneOps } from "./hygiene.js";

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
});

function insertChunk(
  id: string,
  text: string,
  embedding: number[],
  opts: { semanticType?: string; memoryType?: string; hygieneDone?: number; origin?: string } = {},
): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, semantic_type, memory_type, origin, hygiene_done,
       lifecycle, lifecycle_state, created_at, updated_at)
     VALUES (?, 'mem', 'memory', 0, 0, ?, ?, 'm', ?, 0.6, ?, ?, ?, ?, 'generated', 'active', ?, ?)`,
  ).run(
    id,
    text,
    `h-${id}`,
    JSON.stringify(embedding),
    opts.semanticType ?? "fact",
    opts.memoryType ?? null,
    opts.origin ?? null,
    opts.hygieneDone ?? 0,
    NOW,
    NOW,
  );
}

const noopOps = (writes: Array<{ text: string; memberIds: string[] }>): HygieneOps => ({
  backfillEmbeddings: async () => ({ embedded: 0, remaining: 0 }),
  writeMergedSummary: async (p) => {
    writes.push({ text: p.text, memberIds: p.memberIds });
    return `merged_${writes.length}`;
  },
});

describe("findMergeClusters", () => {
  it("clusters same-type near-duplicates and never mixes semantic types", () => {
    const a = { id: "a", semantic_type: "fact", embedding: [1, 0, 0] };
    const b = { id: "b", semantic_type: "fact", embedding: [0.999, 0.01, 0] };
    const c = { id: "c", semantic_type: "preference", embedding: [1, 0, 0] };
    const d = { id: "d", semantic_type: "fact", embedding: [0, 1, 0] };
    const clusters = findMergeClusters([a, b, c, d], 5);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memberIds.toSorted()).toEqual(["a", "b"]);
  });

  it("respects the max-cluster budget", () => {
    const mk = (id: string, v: number[]) => ({ id, semantic_type: "fact", embedding: v });
    const clusters = findMergeClusters(
      [mk("a1", [1, 0, 0]), mk("a2", [1, 0.001, 0]), mk("b1", [0, 1, 0]), mk("b2", [0, 1, 0.001])],
      1,
    );
    expect(clusters).toHaveLength(1);
  });
});

describe("runHygiene merge flow", () => {
  it("merges near-duplicates via ops, records funnel rows, and skips skill/hygiene_done/dream rows", async () => {
    insertChunk("f1", "victor lives in miami", [1, 0, 0]);
    insertChunk("f2", "victor is based in miami florida", [0.999, 0.01, 0]);
    insertChunk("s1", "skill dupe", [1, 0, 0], { semanticType: "skill", memoryType: "skill" });
    insertChunk("h1", "already merged", [1, 0, 0], { hygieneDone: 1 });
    insertChunk("d1", "dream dupe", [1, 0, 0], { origin: "dream" });
    const writes: Array<{ text: string; memberIds: string[] }> = [];
    const result = await runHygiene({
      db,
      llmCall: async () => "Victor lives in Miami, Florida.",
      ops: noopOps(writes),
      llmBudget: 8,
      cycleId: "c1",
      now: NOW,
    });
    expect(result.merged).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.memberIds.toSorted()).toEqual(["f1", "f2"]);
    const funnel = db
      .prepare(`SELECT lane, artifact_kind FROM dream_utility WHERE artifact_id = 'merged_1'`)
      .get() as { lane: string; artifact_kind: string };
    expect(funnel.lane).toBe("hygiene");
    expect(funnel.artifact_kind).toBe("merged_chunk");
  });

  it("does nothing with zero LLM budget or a null llmCall", async () => {
    insertChunk("f1", "a", [1, 0, 0]);
    insertChunk("f2", "a2", [1, 0.001, 0]);
    const writes: Array<{ text: string; memberIds: string[] }> = [];
    const r1 = await runHygiene({
      db,
      llmCall: async () => "x",
      ops: noopOps(writes),
      llmBudget: 0,
      cycleId: "c1",
    });
    const r2 = await runHygiene({
      db,
      llmCall: null,
      ops: noopOps(writes),
      llmBudget: 8,
      cycleId: "c2",
    });
    expect(r1.merged + r2.merged).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

describe("runHygiene canonical staleness", () => {
  function insertFact(id: string, lastConfirmed: number, askedCount = 0): void {
    db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence,
         mention_count, first_seen_at, last_confirmed_at, valid_from, source, status,
         staleness_asked_count)
       VALUES (?, ?, 'v', ?, 'general', 0.8, 1, ?, ?, ?, 'extraction', 'active', ?)`,
    ).run(
      id,
      `key-${id}`,
      `Statement for ${id}`,
      lastConfirmed,
      lastConfirmed,
      lastConfirmed,
      askedCount,
    );
  }

  it("enqueues a still-true question and stamps AFTER enqueue", async () => {
    insertFact("cf1", NOW - 100 * DAY);
    const result = await runHygiene({
      db,
      llmCall: null,
      ops: {
        backfillEmbeddings: async () => ({ embedded: 0, remaining: 0 }),
        writeMergedSummary: async () => null,
      },
      llmBudget: 0,
      cycleId: "c1",
      now: NOW,
    });
    expect(result.staleAsks).toBe(1);
    const q = db.prepare(`SELECT finding, target_id FROM research_findings`).get() as {
      finding: string;
      target_id: string;
    };
    expect(q.finding).toContain("Still true");
    expect(q.target_id).toBe("canonical:cf1");
    const fact = db
      .prepare(
        `SELECT staleness_asked_count, last_staleness_ask_at FROM canonical_facts WHERE id='cf1'`,
      )
      .get() as { staleness_asked_count: number; last_staleness_ask_at: number };
    expect(fact.staleness_asked_count).toBe(1);
    expect(fact.last_staleness_ask_at).toBe(NOW);
  });

  it("never re-asks within the re-ask window", async () => {
    insertFact("cf1", NOW - 100 * DAY);
    db.prepare(`UPDATE canonical_facts SET last_staleness_ask_at = ? WHERE id='cf1'`).run(
      NOW - 5 * DAY,
    );
    const result = await runHygiene({
      db,
      llmCall: null,
      ops: {
        backfillEmbeddings: async () => ({ embedded: 0, remaining: 0 }),
        writeMergedSummary: async () => null,
      },
      llmBudget: 0,
      cycleId: "c1",
      now: NOW,
    });
    expect(result.staleAsks).toBe(0);
  });

  it("transitions to 'unconfirmed' after 3 asks instead of asking forever", async () => {
    insertFact("cf1", NOW - 200 * DAY, 3);
    const result = await runHygiene({
      db,
      llmCall: null,
      ops: {
        backfillEmbeddings: async () => ({ embedded: 0, remaining: 0 }),
        writeMergedSummary: async () => null,
      },
      llmBudget: 0,
      cycleId: "c1",
      now: NOW,
    });
    expect(result.factsMarkedUnconfirmed).toBe(1);
    expect(result.staleAsks).toBe(0);
    const status = (
      db.prepare(`SELECT status FROM canonical_facts WHERE id='cf1'`).get() as { status: string }
    ).status;
    expect(status).toBe("unconfirmed");
    expect((db.prepare(`SELECT COUNT(*) c FROM research_findings`).get() as { c: number }).c).toBe(
      0,
    );
  });
});
