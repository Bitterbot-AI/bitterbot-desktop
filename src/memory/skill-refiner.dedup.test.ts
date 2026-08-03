import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DreamInsight } from "./dream-types.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { SkillRefiner } from "./skill-refiner.js";

// The dream engine's novelty gate: a mutation that is a semantic near-duplicate
// of an existing crystal must be archived, not minted as yet another copy —
// the fix for the field's 68 reworded "resilient middleware" crystals.

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

function insertCrystal(
  db: DatabaseSync,
  id: string,
  opts: { category: string; stableId: string; embedding: number[] },
) {
  db.prepare(
    `INSERT INTO chunks
       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at,
        lifecycle_state, semantic_type, skill_category, stable_skill_id, governance_json)
     VALUES (?, ?, 'skill', 1, 1, ?, 'none', ?, ?, ?, 'active', 'skill', ?, ?, '{}')`,
  ).run(
    id,
    `skills/${id}`,
    id,
    `skill ${id}`,
    JSON.stringify(opts.embedding),
    Date.now(),
    opts.category,
    opts.stableId,
  );
}

const insight = (embedding: number[], content: string): DreamInsight => ({
  id: `ins-${content}`,
  content,
  embedding,
  confidence: 0.9,
  mode: "recombine" as DreamInsight["mode"],
  sourceChunkIds: [],
  sourceClusterIds: [],
  dreamCycleId: "cycle-1",
  importanceScore: 0.8,
  accessCount: 0,
  lastAccessedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// A verifier that always passes, so scoring/verification never masks the
// dedup decision under test.
const passVerifier = { verify: () => ({ passed: true, overallReason: "" }) } as never;

function makeRefiner(db: DatabaseSync) {
  // promotionThreshold 0 so every mutation reaches the dedup gate.
  return new SkillRefiner(
    db,
    { promotionThreshold: 0, dedupSimilarityThreshold: 0.9 },
    undefined,
    undefined,
    undefined,
    passVerifier,
  );
}

describe("SkillRefiner — semantic dedup at generation", () => {
  it("archives a mutation that is a near-duplicate of an existing crystal", () => {
    const db = open();
    // The lineage/category the mutation belongs to, plus an existing crystal in it.
    insertCrystal(db, "orig", { category: "net", stableId: "stable-net", embedding: [0, 1, 0] });
    insertCrystal(db, "existing", {
      category: "net",
      stableId: "stable-net",
      embedding: [1, 0, 0],
    });

    const refiner = makeRefiner(db);
    // Mutation embedding nearly parallel to "existing" ([1,0,0]) → cosine ~0.999.
    const result = refiner.evaluateMutations({ id: "orig", text: "resilient middleware" }, [
      insight([1, 0.05, 0], "dup"),
    ]);

    expect(result.mutations[0]!.promoted).toBe(false);
    expect(result.mutations[0]!.reason).toMatch(/near-duplicate/i);
    // No new crystal was minted.
    const count = db.prepare(`SELECT COUNT(*) n FROM chunks WHERE semantic_type='skill'`).get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it("crystallizes a genuinely novel mutation and stores its embedding", () => {
    const db = open();
    insertCrystal(db, "orig", { category: "net", stableId: "stable-net", embedding: [1, 0, 0] });

    const refiner = makeRefiner(db);
    // Orthogonal embedding → not a duplicate.
    const result = refiner.evaluateMutations({ id: "orig", text: "resilient middleware" }, [
      insight([0, 0, 1], "novel"),
    ]);

    expect(result.mutations[0]!.promoted).toBe(true);
    // A new crystal exists AND carries a non-empty embedding (so future cycles
    // can dedup against it).
    const fresh = db
      .prepare(`SELECT embedding FROM chunks WHERE semantic_type='skill' AND id != 'orig' LIMIT 1`)
      .get() as { embedding: string } | undefined;
    expect(fresh).toBeTruthy();
    expect(fresh!.embedding).not.toBe("[]");
    expect(JSON.parse(fresh!.embedding)).toEqual([0, 0, 1]);
  });
});
