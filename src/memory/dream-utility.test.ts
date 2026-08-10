/**
 * PLAN-40 Phase 0: the dream-utility funnel.
 *
 * Covers: idempotent production, SET-ONCE consumption (the anti-double-stamp
 * guarantee), the shared funnel query, hold counters, the
 * formatProactiveFacts out-param (only rendered dream facts collected,
 * dream-cap respected), and the PROHIBITED-SITE negative guarantee — a
 * dream chunk surfacing through plain search machinery must NOT acquire a
 * consumption stamp (adversarial F2: candidacy is not consumption).
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import {
  recordDreamArtifact,
  markDreamConsumption,
  markDreamConsumptionMany,
  getDreamUtilityFunnel,
  getDreamHoldCounters,
} from "./dream-utility.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { formatProactiveFacts, type ProactiveFact } from "./proactive-recall.js";

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

describe("dream_utility funnel", () => {
  it("records production idempotently per artifact id", () => {
    recordDreamArtifact(db, {
      lane: "hygiene",
      artifactKind: "merged_chunk",
      artifactId: "a1",
      producedAt: NOW,
    });
    recordDreamArtifact(db, {
      lane: "hygiene",
      artifactKind: "merged_chunk",
      artifactId: "a1",
      producedAt: NOW + 1,
    });
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM dream_utility WHERE artifact_id='a1'`)
      .get() as {
      c: number;
    };
    expect(rows.c).toBe(1);
  });

  it("consumption is set-once: a second stamp never overwrites the first", () => {
    recordDreamArtifact(db, {
      lane: "anticipation",
      artifactKind: "brief",
      artifactId: "b1",
      producedAt: NOW,
    });
    expect(markDreamConsumption(db, "b1", "surfaced", NOW + 10)).toBe(true);
    expect(markDreamConsumption(db, "b1", "referenced", NOW + 20)).toBe(false);
    const row = db
      .prepare(`SELECT first_consumed_at, consumed_kind FROM dream_utility WHERE artifact_id='b1'`)
      .get() as { first_consumed_at: number; consumed_kind: string };
    expect(row.first_consumed_at).toBe(NOW + 10);
    expect(row.consumed_kind).toBe("surfaced");
  });

  it("stamping an unknown artifact is a harmless no-op", () => {
    expect(markDreamConsumption(db, "never-produced", "retrieved")).toBe(false);
  });

  it("funnel aggregates per lane with a consumed rate", () => {
    for (let i = 0; i < 4; i++) {
      recordDreamArtifact(db, {
        lane: "distillation",
        artifactKind: "workflow_note",
        artifactId: `d${i}`,
        producedAt: NOW,
      });
    }
    markDreamConsumptionMany(db, ["d0", "d1"], "retrieved");
    const funnel = getDreamUtilityFunnel(db, { now: NOW + 1000, windowDays: 7 });
    const lane = funnel.find((f) => f.lane === "distillation");
    expect(lane?.produced).toBe(4);
    expect(lane?.consumed).toBe(2);
    expect(lane?.consumedRate).toBe(0.5);
    expect(lane?.byKind.retrieved).toBe(2);
  });

  it("window bounds production age, not consumption age", () => {
    recordDreamArtifact(db, {
      lane: "hygiene",
      artifactKind: "merged_chunk",
      artifactId: "old",
      producedAt: NOW - 30 * 86_400_000,
    });
    const funnel = getDreamUtilityFunnel(db, { now: NOW, windowDays: 7 });
    expect(funnel.find((f) => f.lane === "hygiene")).toBeUndefined();
  });

  it("hold counters report current vs wake thresholds", () => {
    const holds = getDreamHoldCounters(db);
    expect(holds).toHaveLength(3);
    expect(holds.every((h) => h.wakeAt > 0 && h.current >= 0)).toBe(true);
  });
});

describe("formatProactiveFacts dream-id out-param", () => {
  const fact = (id: string, origin?: string): ProactiveFact => ({
    text: `fact ${id}`,
    source: "crystal",
    confidence: 0.8,
    chunkId: id,
    origin,
  });

  it("collects only rendered dream-origin chunk ids", () => {
    const out: string[] = [];
    formatProactiveFacts([fact("n1"), fact("d1", "dream"), fact("n2")], {
      includedDreamChunkIds: out,
    });
    expect(out).toEqual(["d1"]);
  });

  it("respects the per-turn dream cap — capped-out facts are not collected", () => {
    const out: string[] = [];
    const text = formatProactiveFacts(
      [fact("d1", "dream"), fact("d2", "dream"), fact("d3", "dream")],
      { includedDreamChunkIds: out },
    );
    // MAX_DREAM_FACTS_PER_TURN is 1 in formatting (at most one hypothesis
    // rendered per turn) — the out-param must match what actually rendered.
    const rendered = (text.match(/dream hypothesis/g) ?? []).length;
    expect(out.length).toBe(rendered);
    expect(out.length).toBeLessThan(3);
  });
});

describe("prohibited stamp sites (adversarial F2)", () => {
  it("a dream chunk passing through plain vector/keyword search acquires NO stamp", async () => {
    // Seed a dream-origin insight chunk with a funnel row, searchable text.
    const now = NOW;
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         origin, semantic_type, importance_score, created_at, updated_at)
       VALUES ('dc1', 'dream/insight/dc1', 'memory', 0, 0,
         'the user prefers violet owls for continuity testing', 'h-dc1', 'm', '[]',
         'dream', 'insight', 0.8, ${now}, ${now})`,
    ).run();
    recordDreamArtifact(db, {
      lane: "legacy",
      artifactKind: "insight_chunk",
      artifactId: "dc1",
      producedAt: now,
    });
    // Simulate what CLI search / deep-recall candidacy does to hit counters:
    // direct trackSearchHits-style access bumps — the funnel must not care.
    db.prepare(`UPDATE chunks SET access_count = access_count + 1 WHERE id = 'dc1'`).run();
    const row = db
      .prepare(`SELECT first_consumed_at FROM dream_utility WHERE artifact_id='dc1'`)
      .get() as { first_consumed_at: number | null };
    expect(row.first_consumed_at).toBeNull();
  });
});
