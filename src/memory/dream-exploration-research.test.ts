/**
 * PLAN-34 Phase 2a — exploration mode reaches real research with honest
 * outcomes. The contract under test: frontier targets qualify for the
 * Skill-Seekers branch; a target resolves ONLY when the research product is
 * embedding-relevant to it (never on scrape success); explored-marking
 * happens after the attempt; every attempt records an outcome code
 * (no_url | domain_blocked | irrelevant | resolved) for the Phase 6 funnel.
 */
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DreamEngine } from "./dream-engine.js";
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

function seedChunks(db: DatabaseSync, count = 6): void {
  const stmt = db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, 'memory', 0, 0, ?, ?, 'test', '[0.1,0.2,0.3,0.4]', 0.8, 'active', ?, ?)`,
  );
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    stmt.run(crypto.randomUUID(), `seed-${i}.md`, `seed chunk text ${i}`, `hash-${i}`, now, now);
  }
}

function insertTarget(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    type: string;
    description: string;
    priority: number;
    metadata: string;
  }> = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  db.prepare(
    `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
  ).run(
    id,
    overrides.type ?? "frontier",
    overrides.description ?? "RELEVANT topic to research",
    overrides.priority ?? 0.9,
    overrides.metadata ?? "{}",
    Date.now(),
    Date.now() + 3_600_000,
  );
  return id;
}

function getTarget(db: DatabaseSync, id: string) {
  const row = db
    .prepare(`SELECT resolved_at, metadata FROM curiosity_targets WHERE id = ?`)
    .get(id) as { resolved_at: number | null; metadata: string };
  return { resolvedAt: row.resolved_at, meta: JSON.parse(row.metadata || "{}") };
}

/**
 * Deterministic fake embeddings: any text containing "RELEVANT" maps to one
 * axis, everything else to an orthogonal one — so relevance is 1.0 when
 * product and target agree and 0.0 when they don't.
 */
const fakeEmbedBatch = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => (t.includes("RELEVANT") ? [1, 0, 0, 0] : [0, 1, 0, 0]));

const strategyLlm = async () =>
  JSON.stringify([{ content: "explore the gap", confidence: 0.8, keywords: ["gap"] }]);

const noopSynthesize = async () => ({ content: "", confidence: 0 });

function makeEngine(db: DatabaseSync) {
  return new DreamEngine(
    db,
    { llmCall: strategyLlm, localLlmCall: strategyLlm, minChunksForDream: 3 },
    noopSynthesize as never,
    fakeEmbedBatch,
  );
}

function makeAdapter(result: {
  ok: boolean;
  envelopes: Array<{ name: string; skill_md: string }>;
  error?: string;
}) {
  const calls: string[] = [];
  const adapter = {
    calls,
    isAvailable: async () => true,
    resetCycleCounter: () => {},
    budgetRemaining: () => 3,
    fillKnowledgeGap: async (desc: string) => {
      calls.push(desc);
      return result;
    },
  };
  return adapter;
}

const envelopeWith = (content: string) => ({
  name: "researched-skill",
  skill_md: Buffer.from(content).toString("base64"),
});

describe("exploration mode real research (PLAN-34 Phase 2a)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    seedChunks(db);
  });

  it("frontier targets qualify for the research branch", async () => {
    const engine = makeEngine(db);
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT content")] });
    engine.setSkillSeekersAdapter(adapter);
    insertTarget(db, { type: "frontier", description: "RELEVANT frontier gap" });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toEqual(["RELEVANT frontier gap"]);
  });

  it("resolves a target only when the research product is relevant", async () => {
    const engine = makeEngine(db);
    engine.setSkillSeekersAdapter(
      makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT deep-dive content")] }),
    );
    const id = insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    const t = getTarget(db, id);
    expect(t.resolvedAt).not.toBeNull();
    expect(t.meta.researchOutcome).toBe("resolved");
    expect(t.meta.researchRelevance).toBeGreaterThanOrEqual(0.4);
    expect(t.meta.explored).toBe(1);
    expect(t.meta.externalResearched).toBe(1);
  });

  it("scrape success alone never resolves: irrelevant products leave the target open", async () => {
    const engine = makeEngine(db);
    engine.setSkillSeekersAdapter(
      makeAdapter({ ok: true, envelopes: [envelopeWith("totally unrelated scraped docs")] }),
    );
    const id = insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    const t = getTarget(db, id);
    expect(t.resolvedAt).toBeNull();
    expect(t.meta.researchOutcome).toBe("irrelevant");
  });

  it("records no_url and domain_blocked outcome codes without resolving", async () => {
    for (const [error, expected] of [
      ["no_url_in_gap_description", "no_url"],
      ["domain_blocked", "domain_blocked"],
      ["domain_blocked_via_search", "domain_blocked"],
    ] as const) {
      const freshDb = createTestDb();
      seedChunks(freshDb);
      const engine = makeEngine(freshDb);
      engine.setSkillSeekersAdapter(makeAdapter({ ok: false, envelopes: [], error }));
      const id = insertTarget(freshDb, { type: "frontier" });

      await engine.run({ modes: ["exploration"] });
      const t = getTarget(freshDb, id);
      expect(t.resolvedAt).toBeNull();
      expect(t.meta.researchOutcome).toBe(expected);
      expect(t.meta.explored).toBe(1); // marked AFTER the attempt
    }
  });

  it("never re-attempts a target already externally researched", async () => {
    const engine = makeEngine(db);
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    insertTarget(db, {
      type: "knowledge_gap",
      metadata: JSON.stringify({ externalResearched: 1, researchOutcome: "irrelevant" }),
    });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(0);
  });

  it("non-eligible target types still get strategy-level explored marking, no outcome code", async () => {
    const engine = makeEngine(db);
    engine.setSkillSeekersAdapter(makeAdapter({ ok: true, envelopes: [] }));
    const id = insertTarget(db, { type: "stale_region", description: "aging region" });

    await engine.run({ modes: ["exploration"] });
    const t = getTarget(db, id);
    expect(t.meta.explored).toBe(1);
    expect(t.meta.researchOutcome).toBeUndefined();
    expect(t.resolvedAt).toBeNull();
  });
});
