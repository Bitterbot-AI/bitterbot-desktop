/**
 * PLAN-34 Phase 4 — promotion end-to-end through the dream engine:
 * eligible modes only, verifier gate (a paraphrase-plus-false-conclusion is
 * rejected), chunks-only persistence with the origin/semantic_type marker,
 * the per-cycle cap, the kill switch, and dream_search reading the promoted
 * corpus.
 */
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DreamEngine } from "./dream-engine.js";
import { searchDreamInsights } from "./dream-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

const ALIGNED = "[1,0,0,0]";

/** Seed a first-party, non-dream source chunk the insight will cite. */
function seedSource(db: DatabaseSync, id: string, trust = "first_party"): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       origin, semantic_type, session_trust, importance_score, lifecycle, created_at, updated_at)
     VALUES (?, 'p', 'sessions', 0, 0, ?, ?, 'test', ?, 'indexed', 'fact', ?, 0.8, 'active', ?, ?)`,
  ).run(id, `source text ${id}`, `h_${id}`, ALIGNED, trust, now, now);
}

/** A promotable insight carrying the given cited source ids. */
function promotableInsight(sourceIds: string[], content = "A grounded hypothesis.") {
  return {
    id: `ins_${crypto.randomUUID()}`,
    content,
    embedding: [1, 0, 0, 0],
    confidence: 0.8,
    mode: "simulation" as const,
    sourceChunkIds: sourceIds,
    sourceClusterIds: [],
    dreamCycleId: "c1",
    importanceScore: 0.64,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** A dream engine whose run() promotes a pre-seeded insight list. */
function makeEngine(
  db: DatabaseSync,
  opts: {
    verifier?: (
      i: { content: string },
      s: { text: string }[],
    ) => Promise<{ unsupported: number; misattribution: boolean }>;
    insightPromotion?: { enabled?: boolean };
    writer?: (row: {
      text: string;
      embedding: number[];
      importanceScore: number;
      evidenceRefs: string;
    }) => boolean;
  } = {},
) {
  const engine = new DreamEngine(
    db,
    { llmCall: async () => "{}", insightPromotion: opts.insightPromotion },
    (async () => ({ content: "", confidence: 0 })) as never,
    async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
  );
  engine.setInsightVerifier(
    opts.verifier ?? (async () => ({ unsupported: 0, misattribution: false })),
  );
  // Default writer: write a searchable-ish chunk directly (no provider).
  const writer =
    opts.writer ??
    ((row) => {
      const id = `dream_insight_${crypto.randomUUID()}`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
           origin, semantic_type, epistemic_layer, evidence_refs, importance_score, lifecycle, created_at, updated_at)
         VALUES (?, ?, 'memory', 0, 0, ?, ?, 'test', ?, 'dream', 'insight', 'mental_model', ?, ?, 'generated', ?, ?)`,
      ).run(
        id,
        `dream/insight/${id}`,
        row.text,
        crypto.createHash("sha256").update(row.text).digest("hex"),
        JSON.stringify(row.embedding),
        row.evidenceRefs,
        row.importanceScore,
        now,
        now,
      );
      return true;
    });
  engine.setInsightChunkWriter(writer);
  return engine;
}

function promotedChunks(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT text, importance_score, epistemic_layer, evidence_refs FROM chunks
       WHERE origin = 'dream' AND semantic_type = 'insight'`,
    )
    .all() as Array<{
    text: string;
    importance_score: number;
    epistemic_layer: string;
    evidence_refs: string;
  }>;
}

describe("dream insight promotion (e2e)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = createTestDb();
    seedSource(db, "s1");
    seedSource(db, "s2");
  });

  // Directly exercise the private promotion path (run() needs a full cycle).
  async function promote(engine: DreamEngine, insights: unknown[]) {
    const p = engine as unknown as {
      insightPromotionEnabled: boolean;
      promoteEligibleInsights(ins: unknown[], cycleId: string): Promise<void>;
    };
    if (p.insightPromotionEnabled) {
      await p.promoteEligibleInsights(insights, "c1");
    }
  }

  it("promotes a grounded, verifier-approved insight into a marked chunk", async () => {
    const engine = makeEngine(db);
    await promote(engine, [promotableInsight(["s1", "s2"])]);
    const rows = promotedChunks(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].epistemic_layer).toBe("mental_model");
    // importance = confidence * 0.5
    expect(rows[0].importance_score).toBeCloseTo(0.4, 5);
    // evidence carries dream grounding refs
    expect(JSON.parse(rows[0].evidence_refs)[0].kind).toBe("dream");
  });

  it("rejects a paraphrase-plus-false-conclusion (verifier: unsupported > 0)", async () => {
    const engine = makeEngine(db, {
      verifier: async () => ({ unsupported: 2, misattribution: false }),
    });
    await promote(engine, [promotableInsight(["s1", "s2"], "Grounded... therefore FALSE claim.")]);
    expect(promotedChunks(db)).toHaveLength(0);
  });

  it("rejects on misattribution", async () => {
    const engine = makeEngine(db, {
      verifier: async () => ({ unsupported: 0, misattribution: true }),
    });
    await promote(engine, [promotableInsight(["s1", "s2"])]);
    expect(promotedChunks(db)).toHaveLength(0);
  });

  it("honors the per-cycle promotion cap of 3", async () => {
    const engine = makeEngine(db);
    const batch = Array.from({ length: 6 }, () => promotableInsight(["s1", "s2"]));
    await promote(engine, batch);
    expect(promotedChunks(db)).toHaveLength(3);
  });

  it("the kill switch (insightPromotion.enabled=false) promotes nothing", async () => {
    const engine = makeEngine(db, { insightPromotion: { enabled: false } });
    await promote(engine, [promotableInsight(["s1", "s2"])]);
    expect(promotedChunks(db)).toHaveLength(0);
  });

  it("dream_search reads the promoted chunks corpus", async () => {
    const engine = makeEngine(db);
    await promote(engine, [promotableInsight(["s1", "s2"], "Sparse coding folds context.")]);
    const results = searchDreamInsights(db, [1, 0, 0, 0], { minScore: 0.5 });
    expect(results.some((r) => r.content === "Sparse coding folds context.")).toBe(true);
    expect(results.every((r) => r.mode === "insight")).toBe(true);
  });
});

describe("real verifyInsightClaims parse (PLAN-34 Phase 4 designated surface)", () => {
  // Drive the REAL verifier (no setInsightVerifier stub) via a fixture LLM
  // wired as the SYNTHESIS call (the independent verifier model).
  function engineWithVerifierLlm(reply: string) {
    const db = createTestDb();
    const engine = new DreamEngine(
      db,
      {
        llmCall: async () => "GENERATOR should never verify",
        // synthesisLlmCall is the distinct verifier model.
        synthesisLlmCall: async () => reply,
      },
      (async () => ({ content: "", confidence: 0 })) as never,
      async (t: string[]) => t.map(() => [1, 0, 0, 0]),
    );
    return engine as unknown as {
      verifyInsightClaims(
        i: { content: string },
        s: { text: string }[],
      ): Promise<{ unsupported: number; misattribution: boolean }>;
    };
  }

  const twoSentence = { content: "First claim holds. Second claim also holds." };
  const sources = [{ text: "source one" }, { text: "source two" }];

  it("promotes when every sentence is labeled restated/inferred and no misattribution", async () => {
    const e = engineWithVerifierLlm('{"labels":["restated","inferred"],"misattribution":false}');
    expect(await e.verifyInsightClaims(twoSentence, sources)).toEqual({
      unsupported: 0,
      misattribution: false,
    });
  });

  it("FAILS CLOSED when the label list is shorter than the sentence count", async () => {
    // One label for a two-sentence hypothesis — sentence 2 is unexamined.
    const e = engineWithVerifierLlm('{"labels":["inferred"],"misattribution":false}');
    const v = await e.verifyInsightClaims(twoSentence, sources);
    expect(v.unsupported).toBeGreaterThan(0);
    expect(v.misattribution).toBe(true);
  });

  it("counts any non-enum / uppercase label as unsupported", async () => {
    const e = engineWithVerifierLlm('{"labels":["restated","UNSUPPORTED"],"misattribution":false}');
    expect((await e.verifyInsightClaims(twoSentence, sources)).unsupported).toBe(1);
  });

  it("misattribution FAILS OPEN to true when the key is absent or non-boolean", async () => {
    for (const reply of [
      '{"labels":["restated","inferred"]}',
      '{"labels":["restated","inferred"],"misattribution":"no"}',
    ]) {
      expect(
        (await engineWithVerifierLlm(reply).verifyInsightClaims(twoSentence, sources))
          .misattribution,
      ).toBe(true);
    }
  });

  it("empty/garbage/unparseable replies fail closed", async () => {
    for (const reply of ['{"labels":[]}', "not json", '{"labels":"x"}']) {
      const v = await engineWithVerifierLlm(reply).verifyInsightClaims(twoSentence, sources);
      expect(v.unsupported).toBeGreaterThan(0);
    }
  });

  it("a paraphrase-plus-false-conclusion (one unsupported label) is rejected", async () => {
    const e = engineWithVerifierLlm('{"labels":["restated","unsupported"],"misattribution":false}');
    expect((await e.verifyInsightClaims(twoSentence, sources)).unsupported).toBe(1);
  });

  it("the verifier is NOT the generating call (uses the distinct synthesis model)", async () => {
    // The generator returns non-JSON; if the verifier used it, parse fails
    // closed. It uses synthesisLlmCall instead, so a valid verdict returns.
    const e = engineWithVerifierLlm('{"labels":["restated","inferred"],"misattribution":false}');
    expect((await e.verifyInsightClaims(twoSentence, sources)).unsupported).toBe(0);
  });
});
