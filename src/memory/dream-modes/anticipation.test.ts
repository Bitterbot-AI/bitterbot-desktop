/**
 * PLAN-40 Lane 3: anticipatory briefs. Covers the mechanical validation legs
 * (>= 2 valid citations, non-empty product), the open-brief cap, quiet-
 * context and no-budget skips, funnel production, and — critically — that
 * briefs never become chunks (the retrieval-leak refutation).
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { runAnticipation, MAX_OPEN_BRIEFS } from "./anticipation.js";

const NOW = 1_750_000_000_000;

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

function seedActiveContext(): void {
  db.prepare(
    `INSERT INTO canonical_facts (id, key, value, statement, category, confidence, mention_count,
       first_seen_at, last_confirmed_at, valid_from, source, status)
     VALUES ('cf1', 'project', 'plan40', 'Victor is building PLAN-40', 'general', 0.9, 3, ?, ?, ?, 'extraction', 'active')`,
  ).run(NOW - 1000, NOW - 1000, NOW - 1000);
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       semantic_type, session_trust, created_at, updated_at)
     VALUES ('ep1', 'mem', 'memory', 0, 0, 'Discussed the dream engine scorecard today', 'h-ep1', 'm', '[]',
       'episode', 'first_party', ?, ?)`,
  ).run(NOW - 2000, NOW - 2000);
}

const goodLlm = async () =>
  JSON.stringify({
    question: "How is the PLAN-40 scorecard looking?",
    answer: "Phases 0-3 are built; pilots are armed.",
    sources: [1, 2],
  });

describe("runAnticipation", () => {
  it("writes a validated brief + funnel row, and the brief is NOT a chunk", async () => {
    seedActiveContext();
    const r = await runAnticipation({
      db,
      llmCall: goodLlm,
      llmBudget: 8,
      cycleId: "c1",
      now: NOW,
    });
    expect(r.briefs).toBe(1);
    const brief = db.prepare(`SELECT * FROM dream_briefs`).get() as {
      id: string;
      status: string;
      question: string;
    };
    expect(brief.status).toBe("open");
    const funnel = db
      .prepare(`SELECT lane FROM dream_utility WHERE artifact_id = ?`)
      .get(brief.id) as { lane: string };
    expect(funnel.lane).toBe("anticipation");
    // The retrieval-leak refutation: nothing lands in chunks.
    const chunkCount = (
      db.prepare(`SELECT COUNT(*) c FROM chunks WHERE id = ?`).get(brief.id) as { c: number }
    ).c;
    expect(chunkCount).toBe(0);
  });

  it("rejects briefs with fewer than 2 valid citations", async () => {
    seedActiveContext();
    const badLlm = async () => JSON.stringify({ question: "Q?", answer: "A", sources: [1, 99] });
    const r = await runAnticipation({ db, llmCall: badLlm, llmBudget: 8, cycleId: "c1", now: NOW });
    expect(r.briefs).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM dream_briefs`).get() as { c: number }).c).toBe(0);
  });

  it("skips when context is quiet (fewer than 2 active sources)", async () => {
    const r = await runAnticipation({
      db,
      llmCall: goodLlm,
      llmBudget: 8,
      cycleId: "c1",
      now: NOW,
    });
    expect(r.briefs).toBe(0);
    expect(r.llmCalls).toBe(0);
  });

  it("respects the open-brief cap", async () => {
    seedActiveContext();
    for (let i = 0; i < MAX_OPEN_BRIEFS; i++) {
      db.prepare(
        `INSERT INTO dream_briefs (id, context_kind, question, answer_sketch, status, created_at)
         VALUES (?, 'active_context', 'q', 'a', 'open', ?)`,
      ).run(`b${i}`, NOW);
    }
    const r = await runAnticipation({
      db,
      llmCall: goodLlm,
      llmBudget: 8,
      cycleId: "c1",
      now: NOW,
    });
    expect(r.briefs).toBe(0);
    expect(r.llmCalls).toBe(0);
  });

  it("does nothing without budget or model", async () => {
    seedActiveContext();
    const r1 = await runAnticipation({
      db,
      llmCall: goodLlm,
      llmBudget: 0,
      cycleId: "c1",
      now: NOW,
    });
    const r2 = await runAnticipation({ db, llmCall: null, llmBudget: 8, cycleId: "c1", now: NOW });
    expect(r1.briefs + r2.briefs).toBe(0);
  });
});
