/**
 * PLAN-40 Lane 2: memory hygiene. Covers the backfill delegation, staleness
 * ask ordering (enqueue-then-stamp), the 3-ask 'unconfirmed' terminal state,
 * and the ops-absent no-op path.
 *
 * The 1b near-duplicate merge and its tests were deleted 2026-08-14 after the
 * merge failed its pre-registered D2 gate (0/23 top-5 changes — see
 * docs/reviews/plan40-phase-adversarial-2026-08-11.md). Demotion-preservation
 * coverage for the summaries it left behind lives in
 * manager.merge-survives-reindex.test.ts and
 * manager.reindex-preserves-crystals.test.ts.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { runHygiene, type HygieneOps } from "./hygiene.js";

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

const opsWith = (
  backfill?: () => Promise<{ embedded: number; remaining: number }>,
): HygieneOps => ({
  backfillEmbeddings: backfill ?? (async () => ({ embedded: 0, remaining: 0 })),
});

describe("runHygiene backfill", () => {
  it("delegates to the manager's drainer and reports the count", async () => {
    let calledWith = -1;
    const result = await runHygiene({
      db,
      ops: {
        backfillEmbeddings: async (limit: number) => {
          calledWith = limit;
          return { embedded: 7, remaining: 3 };
        },
      },
      cycleId: "c1",
      now: NOW,
    });
    expect(calledWith).toBeGreaterThan(0);
    expect(result.backfilled).toBe(7);
    expect(result.chunksProcessed).toBe(7);
  });

  it("is a no-op without ops", async () => {
    const result = await runHygiene({ db, ops: null, cycleId: "c1", now: NOW });
    expect(result.backfilled).toBe(0);
    expect(result.staleAsks).toBe(0);
  });

  it("survives a throwing drainer and still runs staleness", async () => {
    db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence,
         mention_count, first_seen_at, last_confirmed_at, valid_from, source, status,
         staleness_asked_count)
       VALUES ('cf1', 'k1', 'v', 's', 'general', 0.8, 1, ?, ?, ?, 'extraction', 'active', 0)`,
    ).run(NOW - 100 * DAY, NOW - 100 * DAY, NOW - 100 * DAY);
    const result = await runHygiene({
      db,
      ops: opsWith(async () => {
        throw new Error("drainer down");
      }),
      cycleId: "c1",
      now: NOW,
    });
    expect(result.backfilled).toBe(0);
    expect(result.staleAsks).toBe(1);
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
    const result = await runHygiene({ db, ops: opsWith(), cycleId: "c1", now: NOW });
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
    const result = await runHygiene({ db, ops: opsWith(), cycleId: "c1", now: NOW });
    expect(result.staleAsks).toBe(0);
  });

  it("transitions to 'unconfirmed' after 3 asks instead of asking forever", async () => {
    insertFact("cf1", NOW - 200 * DAY, 3);
    const result = await runHygiene({ db, ops: opsWith(), cycleId: "c1", now: NOW });
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
