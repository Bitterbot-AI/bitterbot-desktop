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
function promotableInsight(
  sourceIds: string[],
  content = "A grounded hypothesis.",
  mode: "simulation" | "extrapolation" = "simulation",
) {
  return {
    id: `ins_${crypto.randomUUID()}`,
    content,
    embedding: [1, 0, 0, 0],
    confidence: 0.8,
    mode,
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

describe("dream prediction routing (PLAN-34 Phase 4 §6.3)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = createTestDb();
    seedSource(db, "s1");
    seedSource(db, "s2");
  });

  async function promote(engine: DreamEngine, insights: unknown[]) {
    const p = engine as unknown as {
      promoteEligibleInsights(ins: unknown[], cycleId: string): Promise<void>;
    };
    await p.promoteEligibleInsights(insights, "c1");
  }

  function promotionTelemetry(database: DatabaseSync, metric: string): number {
    const row = database
      .prepare(
        `SELECT SUM(metric_value) as total FROM dream_telemetry
         WHERE phase = 'promotion' AND metric_name = ?`,
      )
      .get(metric) as { total: number | null } | undefined;
    return row?.total ?? 0;
  }
  const predictionTelemetry = (database: DatabaseSync) =>
    promotionTelemetry(database, "prediction_created");

  const CUE_CONTENT =
    "The gateway will likely need a restart next week because sqlite disk pressure keeps climbing.";

  it("a promoted extrapolation with a cue routes through the prediction writer", async () => {
    const engine = makeEngine(db);
    const calls: Array<{ insightId: string; trigger: string; confidence: number }> = [];
    engine.setDreamPredictionWriter(async (p) => {
      calls.push({ insightId: p.insightId, trigger: p.trigger, confidence: p.confidence });
      return "created";
    });
    const insight = promotableInsight(["s1", "s2"], CUE_CONTENT, "extrapolation");
    await promote(engine, [insight]);
    expect(calls).toHaveLength(1);
    expect(calls[0].insightId).toBe(insight.id);
    expect(calls[0].trigger).toBe(DreamEngine.distillPredictionTrigger(CUE_CONTENT));
    expect(predictionTelemetry(db)).toBe(1);
  });

  it("an extrapolation WITHOUT a temporal cue creates no prediction (false-fire guard)", async () => {
    const engine = makeEngine(db);
    let called = 0;
    engine.setDreamPredictionWriter(async () => {
      called++;
      return "created";
    });
    await promote(engine, [
      promotableInsight(["s1", "s2"], "The user prefers terse commit messages.", "extrapolation"),
    ]);
    expect(called).toBe(0);
    expect(predictionTelemetry(db)).toBe(0);
    // The insight itself still promoted — only the prediction leg is skipped.
    expect(promotedChunks(db)).toHaveLength(1);
  });

  it("a promoted SIMULATION insight never routes, even with a cue", async () => {
    const engine = makeEngine(db);
    let called = 0;
    engine.setDreamPredictionWriter(async () => {
      called++;
      return "created";
    });
    await promote(engine, [promotableInsight(["s1", "s2"], CUE_CONTENT, "simulation")]);
    expect(called).toBe(0);
    expect(promotedChunks(db)).toHaveLength(1);
  });

  it("a verifier-rejected extrapolation never routes (qualifiers only)", async () => {
    const engine = makeEngine(db, {
      verifier: async () => ({ unsupported: 1, misattribution: false }),
    });
    let called = 0;
    engine.setDreamPredictionWriter(async () => {
      called++;
      return "created";
    });
    await promote(engine, [promotableInsight(["s1", "s2"], CUE_CONTENT, "extrapolation")]);
    expect(called).toBe(0);
  });

  it("a capped writer records prediction_capped telemetry (slot starvation is visible)", async () => {
    const engine = makeEngine(db);
    engine.setDreamPredictionWriter(async () => "capped");
    await promote(engine, [promotableInsight(["s1", "s2"], CUE_CONTENT, "extrapolation")]);
    expect(predictionTelemetry(db)).toBe(0);
    expect(promotionTelemetry(db, "prediction_capped")).toBe(1);
  });

  it("a failed writer records neither created nor capped telemetry", async () => {
    const engine = makeEngine(db);
    engine.setDreamPredictionWriter(async () => "failed");
    await promote(engine, [promotableInsight(["s1", "s2"], CUE_CONTENT, "extrapolation")]);
    expect(predictionTelemetry(db)).toBe(0);
    expect(promotionTelemetry(db, "prediction_capped")).toBe(0);
  });

  it("a throwing writer does not break promotion", async () => {
    const engine = makeEngine(db);
    engine.setDreamPredictionWriter(async () => {
      throw new Error("prospective engine down");
    });
    await promote(engine, [promotableInsight(["s1", "s2"], CUE_CONTENT, "extrapolation")]);
    expect(promotedChunks(db)).toHaveLength(1);
  });
});

describe("dream insight backfill (PLAN-34 §6.2, redesigned)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = createTestDb();
    seedSource(db, "s1");
    seedSource(db, "s2");
  });

  function seedHistoricalInsight(
    id: string,
    mode = "extrapolation",
    sourceIds: string[] = ["s1", "s2"],
    importance = 0.6,
  ): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO dream_insights (id, content, embedding, confidence, mode,
         source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score,
         access_count, last_accessed_at, created_at, updated_at)
       VALUES (?, ?, ?, 0.8, ?, ?, '[]', 'old_cycle', ?, 0, NULL, ?, ?)`,
    ).run(
      id,
      `Historical hypothesis ${id}.`,
      ALIGNED,
      mode,
      JSON.stringify(sourceIds),
      importance,
      now,
      now,
    );
  }

  async function runBackfill(engine: DreamEngine, cycleId = "c1"): Promise<void> {
    await (
      engine as unknown as { backfillPromotedInsights(cycleId: string): Promise<void> }
    ).backfillPromotedInsights(cycleId);
  }

  function metaValue(key: string): string | undefined {
    return (
      db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined
    )?.value;
  }

  it("promotes an eligible historical insight, then completes on exhaustion — not on a 0-promotion run", async () => {
    seedHistoricalInsight("hist_1");
    const engine = makeEngine(db);
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(1);
    // Assessed and marked attempted; done only after the NEXT run finds nothing.
    expect(metaValue("dream_insight_backfill_attempted")).toContain("hist_1");
    expect(metaValue("dream_insight_backfill_done")).toBeUndefined();
    await runBackfill(engine);
    expect(metaValue("dream_insight_backfill_done")).toBe("1");
    expect(metaValue("dream_insight_backfill_attempted")).toBeUndefined();
    // Fast path afterwards: no further writes.
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(1);
  });

  it("never double-writes an already-promoted insight (dedupe via evidence_refs)", async () => {
    seedHistoricalInsight("hist_dup");
    const engine = makeEngine(db);
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(1);
    // Clear the flags entirely — simulate an operator reset.
    db.prepare(`DELETE FROM meta WHERE key IN
      ('dream_insight_backfill_done', 'dream_insight_backfill_attempted')`).run();
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(1); // still exactly one
  });

  it("DOA regression: refuses to assess while any session chunk still has NULL trust", async () => {
    // The real DOA path (adversarial pass): a Phase-4→§6.2 upgrade DB has
    // live first_party chunks AND pre-migration session chunks still NULL.
    // A global "some first_party exists" guard would wrongly proceed and
    // burn the top-importance candidates against ungrounded sources. Seed
    // exactly that shape: two NULL-trust session source chunks the insight
    // cites, plus an unrelated first_party chunk so a global count is > 0.
    const bare = createTestDb();
    db = bare;
    seedSource(bare, "null_a", null as unknown as string); // step A hasn't run
    seedSource(bare, "null_b", null as unknown as string);
    seedSource(bare, "live_fp", "first_party"); // Phase-4 live chunk exists
    seedHistoricalInsight("hist_doa", "extrapolation", ["null_a", "null_b"]);
    const engine = makeEngine(bare);
    await runBackfill(engine);
    expect(promotedChunks(bare)).toHaveLength(0);
    expect(metaValue("dream_insight_backfill_attempted")).toBeUndefined();
    expect(metaValue("dream_insight_backfill_done")).toBeUndefined(); // NOT locked

    // Once step A stamps the pending session chunks, the SAME insight grounds
    // and promotes — nothing was lost to a premature attempted-mark.
    bare
      .prepare(`UPDATE chunks SET session_trust = 'first_party' WHERE id IN ('null_a', 'null_b')`)
      .run();
    await runBackfill(engine);
    expect(promotedChunks(bare)).toHaveLength(1);
    expect(metaValue("dream_insight_backfill_attempted")).toContain("hist_doa");
  });

  it("a promoted dream-insight chunk (source='sessions', NULL trust) does not deadlock the guard", async () => {
    // Under a sources=['sessions'] config, writePromotedInsightChunk writes
    // source='sessions' + NULL session_trust. Those generated artifacts must
    // NOT count as pending session history, or the guard would block the
    // backlog forever (step A's one-shot latch never re-stamps them).
    seedHistoricalInsight("hist_ok");
    // Simulate a previously-promoted insight chunk from a sessions-only config.
    const now = Date.now();
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         origin, semantic_type, session_trust, importance_score, lifecycle, created_at, updated_at)
       VALUES ('dream_prev', 'dream/insight/dream_prev', 'sessions', 0, 0, 'prev insight', 'h_prev',
         'test', '[1,0,0,0]', 'dream', 'insight', NULL, 0.4, 'generated', ?, ?)`,
    ).run(now, now);
    const engine = makeEngine(db);
    await runBackfill(engine);
    // The guard ignored the dream chunk and proceeded to promote the backlog.
    expect(promotedChunks(db).some((c) => c.text.includes("hist_ok"))).toBe(true);
  });

  it("a verifier-rejected candidate is marked attempted, and exhaustion still completes cleanly", async () => {
    seedHistoricalInsight("hist_rej");
    const engine = makeEngine(db, {
      verifier: async () => ({ unsupported: 1, misattribution: false }),
    });
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(0);
    expect(metaValue("dream_insight_backfill_attempted")).toContain("hist_rej");
    // A 0-promotion (assessed-but-refused) run must NOT prematurely latch done.
    expect(metaValue("dream_insight_backfill_done")).toBeUndefined();
    await runBackfill(engine);
    // Assessed-and-refused is a real verdict — exhaustion completes the backfill.
    expect(metaValue("dream_insight_backfill_done")).toBe("1");
  });

  it("processes at most MAX_PROMOTIONS_PER_CYCLE candidates per cycle (incremental drip)", async () => {
    for (let i = 0; i < 5; i++) {
      seedHistoricalInsight(`hist_${i}`, "extrapolation", ["s1", "s2"], 0.9 - i * 0.1);
    }
    const engine = makeEngine(db);
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(3); // cap per cycle
    await runBackfill(engine, "c2");
    expect(promotedChunks(db)).toHaveLength(5); // remaining two
  });

  it("only extrapolation/simulation modes are candidates", async () => {
    seedHistoricalInsight("hist_replay", "replay");
    const engine = makeEngine(db);
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(0);
    await runBackfill(engine);
    expect(metaValue("dream_insight_backfill_done")).toBe("1"); // empty scope exhausts
  });

  it("the kill switch skips assessment without marking anything", async () => {
    seedHistoricalInsight("hist_off");
    const engine = makeEngine(db, { insightPromotion: { enabled: false } });
    await runBackfill(engine);
    expect(promotedChunks(db)).toHaveLength(0);
    expect(metaValue("dream_insight_backfill_attempted")).toBeUndefined();
    expect(metaValue("dream_insight_backfill_done")).toBeUndefined();
  });
});

// NOTE: the run()-level tests for the livePromotionRan gate live in
// dream-backfill-gate.test.ts (a non-e2e file). Driving DreamEngine.run()
// pulls first-time dynamic imports (dream-evaluator, etc.) that make vite's
// e2e-config dep optimizer re-scan and emit noise; the default config
// handles them cleanly, so the wiring test runs there.

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
