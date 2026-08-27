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
import { containsSourceLeak as containsSourceLeakInEgress } from "./auto-research-egress.js";
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

/**
 * Doubles as the exploration-strategy LLM and the LOCAL depersonalization
 * model (PLAN-34 Phase 2c): the rewrite prompt gets a fixed neutral phrase
 * that shares no 3-gram or entity with any test description.
 */
const strategyLlm = async (prompt: string) => {
  if (prompt.includes("Rewrite the following private note")) {
    return "neutral generic documentation subject";
  }
  return JSON.stringify([{ content: "explore the gap", confidence: 0.8, keywords: ["gap"] }]);
};
const DEPERSONALIZED = "neutral generic documentation subject";

const noopSynthesize = async () => ({ content: "", confidence: 0 });

function makeEngine(db: DatabaseSync) {
  return new DreamEngine(
    db,
    {
      llmCall: strategyLlm,
      localLlmCall: strategyLlm,
      minChunksForDream: 3,
      // V1 default flip (PLAN-41 D-D): autoResearch egress is opt-in, so the
      // research-branch tests opt in; default-off has its own test below.
      autoResearch: { enabled: true },
    },
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
    // 2c: the adapter receives the DEPERSONALIZED phrase, never the raw
    // target description.
    expect(adapter.calls).toEqual([DEPERSONALIZED]);
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

describe("findings become memory (PLAN-34 Phase 2b)", () => {
  it("a resolved target writes a world_fact crystal with url evidence and queues a finding", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = makeEngine(db);
    engine.setSkillSeekersAdapter({
      isAvailable: async () => true,
      resetCycleCounter: () => {},
      budgetRemaining: () => 3,
      fillKnowledgeGap: async () => ({
        ok: true,
        envelopes: [envelopeWith("RELEVANT deep-dive on the topic")],
        sourceUrl: "https://docs.example.com/topic",
      }),
    });
    const id = insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });

    const crystal = db
      .prepare(
        `SELECT text, epistemic_layer, evidence_refs, path FROM chunks
         WHERE epistemic_layer = 'world_fact' AND path LIKE 'dream/research/%'`,
      )
      .get() as { text: string; evidence_refs: string; path: string };
    expect(crystal).toBeDefined();
    expect(crystal.text).toContain("RELEVANT gap topic");
    expect(JSON.parse(crystal.evidence_refs)).toEqual([
      { kind: "url", url: "https://docs.example.com/topic" },
    ]);
    expect(crystal.path).toBe(`dream/research/${id}`);

    const finding = db
      .prepare(`SELECT finding, source_url, surfaced_at FROM research_findings`)
      .get() as { finding: string; source_url: string; surfaced_at: number | null };
    expect(finding).toBeDefined();
    expect(finding.finding).toContain("Looked into");
    expect(finding.source_url).toBe("https://docs.example.com/topic");
    expect(finding.surfaced_at).toBeNull(); // queued, not yet surfaced
  });

  it("irrelevant products write neither crystal nor finding", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = makeEngine(db);
    engine.setSkillSeekersAdapter(
      makeAdapter({ ok: true, envelopes: [envelopeWith("unrelated docs")] }),
    );
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM research_findings`).get()).toMatchObject({ c: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE path LIKE 'dream/research/%'`).get(),
    ).toMatchObject({ c: 0 });
  });
});

describe("egress safety (PLAN-34 Phase 2c)", () => {
  it("fails closed with ZERO egress when no local depersonalization model is configured", async () => {
    const db = createTestDb();
    seedChunks(db);
    // No localLlmCall: cloud-only engine.
    const engine = new DreamEngine(
      db,
      { llmCall: strategyLlm, minChunksForDream: 3 },
      noopSynthesize as never,
      fakeEmbedBatch,
    );
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(0); // no egress at all
  });

  it("sensitive topics never leave the machine (deterministic skip-list, outcome recorded)", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = makeEngine(db);
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    const id = insertTarget(db, {
      type: "knowledge_gap",
      description: "research medication options for my diagnosis",
    });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(0);
    const t = getTarget(db, id);
    expect(t.meta.researchOutcome).toBe("sensitive_skipped");
    expect(t.resolvedAt).toBeNull();
  });

  it("a leaking depersonalization output is containment-rejected before any egress", async () => {
    const db = createTestDb();
    seedChunks(db);
    // Local model parrots the source verbatim — the deterministic
    // post-filter must reject it, not the prompt instruction.
    const leakyLlm = async (prompt: string) =>
      prompt.includes("Rewrite the following private note")
        ? "RELEVANT gap topic about the private project"
        : JSON.stringify([{ content: "s", confidence: 0.8, keywords: [] }]);
    const engine = new DreamEngine(
      db,
      {
        llmCall: leakyLlm,
        localLlmCall: leakyLlm,
        minChunksForDream: 3,
        autoResearch: { enabled: true },
      },
      noopSynthesize as never,
      fakeEmbedBatch,
    );
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    const id = insertTarget(db, {
      type: "knowledge_gap",
      description: "RELEVANT gap topic about the private project",
    });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(0);
    expect(getTarget(db, id).meta.researchOutcome).toBe("containment_rejected");
  });

  it("enforces the persisted daily cap across engine restarts (reserve-then-act)", async () => {
    const db = createTestDb();
    seedChunks(db);
    const mkEngine = () =>
      new DreamEngine(
        db,
        {
          llmCall: strategyLlm,
          localLlmCall: strategyLlm,
          minChunksForDream: 3,
          autoResearch: { enabled: true, maxPerDay: 1 },
        },
        noopSynthesize as never,
        fakeEmbedBatch,
      );
    const engine1 = mkEngine();
    const adapter1 = makeAdapter({ ok: true, envelopes: [envelopeWith("unrelated")] });
    engine1.setSkillSeekersAdapter(adapter1);
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT first gap" });
    await engine1.run({ modes: ["exploration"] });
    expect(adapter1.calls).toHaveLength(1); // budget of 1 consumed

    // "Restart": a NEW engine over the same DB must see the spent budget.
    const engine2 = mkEngine();
    const adapter2 = makeAdapter({ ok: true, envelopes: [envelopeWith("unrelated")] });
    engine2.setSkillSeekersAdapter(adapter2);
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT second gap" });
    await engine2.run({ modes: ["exploration"] });
    expect(adapter2.calls).toHaveLength(0); // cap survives the restart
  });

  it("autoResearch is OFF BY DEFAULT — research egress is opt-in (PLAN-41 D-D)", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = new DreamEngine(
      db,
      { llmCall: strategyLlm, localLlmCall: strategyLlm, minChunksForDream: 3 },
      noopSynthesize as never,
      fakeEmbedBatch,
    );
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(0);
  });

  it("curiosity.autoResearch.enabled=false disables the research branch entirely", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = new DreamEngine(
      db,
      {
        llmCall: strategyLlm,
        localLlmCall: strategyLlm,
        minChunksForDream: 3,
        autoResearch: { enabled: false },
      },
      noopSynthesize as never,
      fakeEmbedBatch,
    );
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("egress hardening (PLAN-34 Phase 2 adversarial fixes)", () => {
  it("a cloud model named as the local model does NOT depersonalize/egress (localModelIsLocal=false)", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = new DreamEngine(
      db,
      // localLlmCall wired, but the manager flagged the spec as NOT local.
      {
        llmCall: strategyLlm,
        localLlmCall: strategyLlm,
        localModelIsLocal: false,
        minChunksForDream: 3,
      },
      noopSynthesize as never,
      fakeEmbedBatch,
    );
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(0); // no verbatim note ever left the machine
  });

  it("a transient model outage records transient_error and keeps the target retryable", async () => {
    const db = createTestDb();
    seedChunks(db);
    // Local model throws (outage) on the depersonalization prompt.
    const throwingLocal = async (prompt: string) => {
      if (prompt.includes("Rewrite the following private note")) {
        throw new Error("local model unavailable");
      }
      return JSON.stringify([{ content: "s", confidence: 0.8, keywords: [] }]);
    };
    const engine = new DreamEngine(
      db,
      {
        llmCall: throwingLocal,
        localLlmCall: throwingLocal,
        minChunksForDream: 3,
        autoResearch: { enabled: true },
      },
      noopSynthesize as never,
      fakeEmbedBatch,
    );
    engine.setSkillSeekersAdapter(makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] }));
    const id = insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    const t = getTarget(db, id);
    expect(t.meta.researchOutcome).toBe("transient_error");
    expect(t.meta.externalResearched).toBeFalsy(); // NOT retired — retries next cycle
    expect(t.resolvedAt).toBeNull();
  });

  it("a search-provider error is transient, not a terminal no_url retire", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = makeEngine(db);
    engine.setSkillSeekersAdapter(
      makeAdapter({ ok: false, envelopes: [], error: "search_provider_error" }),
    );
    const id = insertTarget(db, { type: "knowledge_gap", description: "RELEVANT gap topic" });

    await engine.run({ modes: ["exploration"] });
    const t = getTarget(db, id);
    expect(t.meta.researchOutcome).toBe("transient_error");
    expect(t.meta.externalResearched).toBeFalsy();
  });

  it("acceptance: a description-embedded URL never rides to the adapter; the egressed query leaks no source 3-gram or entity", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = makeEngine(db);
    const adapter = makeAdapter({ ok: false, envelopes: [], error: "no_url_in_gap_description" });
    engine.setSkillSeekersAdapter(adapter);
    const description =
      "RELEVANT investigate https://github.com/Victor-Gil/private-notes?q=aubaine partners";
    insertTarget(db, { type: "knowledge_gap", description });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(1);
    const egressed = adapter.calls[0];
    // The raw URL never leaves.
    expect(egressed).not.toContain("github.com");
    expect(egressed).not.toContain("aubaine");
    expect(egressed).not.toContain("Victor");
    // Plan acceptance: no source 3-gram and no source entity in the query.
    expect(containsSourceLeakInEgress(description, egressed)).toBe(false);
  });

  it("already-externalResearched targets are excluded at the query, freeing the research window", async () => {
    const db = createTestDb();
    seedChunks(db);
    const engine = makeEngine(db);
    const adapter = makeAdapter({ ok: true, envelopes: [envelopeWith("RELEVANT")] });
    engine.setSkillSeekersAdapter(adapter);
    // Three high-priority targets already terminally researched...
    for (let i = 0; i < 3; i++) {
      insertTarget(db, {
        type: "knowledge_gap",
        description: `RELEVANT done ${i}`,
        priority: 0.99,
        metadata: JSON.stringify({ externalResearched: 1 }),
      });
    }
    // ...and one fresh lower-priority target must still get its attempt.
    insertTarget(db, { type: "knowledge_gap", description: "RELEVANT fresh one", priority: 0.5 });

    await engine.run({ modes: ["exploration"] });
    expect(adapter.calls).toHaveLength(1);
  });
});
