/**
 * Phase 0 gate-hardening tests (PLAN-33).
 *
 * Three silent cold-start drop gates in proactive recall:
 *  1. A null query embedding (cold-process embed timeout) used to skip the
 *     entire semantic crystal stage — the keyword fallback keeps it alive.
 *  2. The graph/identity stages fill first and could crowd the semantic stage
 *     out of all maxFacts slots — vectorReserve guarantees it headroom.
 *  3. The cooldown map lives on the process-singleton manager, so a fresh
 *     conversation in a warm process inherited the previous session's
 *     suppression window — applyRecallScope clears it on conversation change.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { applyRecallScope, buildRecallFtsQuery, proactiveRecall } from "./proactive-recall.js";
import { UserModelManager } from "./user-model.js";

const FTS_TABLE = "chunks_fts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE chunks (
    id TEXT PRIMARY KEY, text TEXT, importance_score REAL, epistemic_layer TEXT,
    semantic_type TEXT, emotional_valence REAL, lifecycle TEXT, source TEXT,
    created_at INTEGER, embedding TEXT)`);
  // Production FTS5 DDL (memory-schema.ts).
  db.exec(
    `CREATE VIRTUAL TABLE ${FTS_TABLE} USING fts5(
      text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED,
      start_line UNINDEXED, end_line UNINDEXED)`,
  );
  return db;
}

function insertFact(
  db: DatabaseSync,
  id: string,
  text: string,
  opts: { layer?: string; importance?: number; lifecycle?: string; models?: string[] } = {},
): void {
  db.prepare(
    `INSERT INTO chunks (id, text, importance_score, epistemic_layer, semantic_type, lifecycle)
     VALUES (?, ?, ?, ?, 'fact', ?)`,
  ).run(
    id,
    text,
    opts.importance ?? 0.5,
    opts.layer ?? "world_fact",
    opts.lifecycle ?? "generated",
  );
  // The FTS table carries one row per embedding model — mirror that so the
  // GROUP BY dedup in the fallback query is actually exercised.
  for (const model of opts.models ?? ["pending", "text-embedding-3-small"]) {
    db.prepare(
      `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
       VALUES (?, ?, 'memory/facts.md', 'memory', ?, 1, 1)`,
    ).run(text, id, model);
  }
}

describe("keyword fallback when the query embedding is unavailable", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = makeDb();
    insertFact(db, "repo", "The project repository is github.com/Bitterbot-AI/bitterbot-desktop.");
    insertFact(db, "episode", "We spent the afternoon debugging the repository sync job.", {
      layer: "experience",
    });
    insertFact(db, "expired", "The repository used to live under a personal account.", {
      lifecycle: "expired",
    });
    insertFact(db, "lowimp", "Repository CI badge is green.", { importance: 0.01 });
  });

  afterAll(() => db.close());

  const keywordFallback = { ftsTable: FTS_TABLE };

  it("surfaces layer-eligible crystals via FTS with a null embedding", () => {
    const result = proactiveRecall({
      userMessage: "which repository had traffic yesterday?",
      queryEmbedding: null,
      db,
      userModelManager: null,
      recentlySurfaced: new Map(),
      currentTurn: 1,
      keywordFallback,
    });
    const texts = result.facts.map((f) => f.text).join(" | ");
    expect(texts).toContain("Bitterbot-AI/bitterbot-desktop");
    expect(result.layerCounts.keywordFacts).toBeGreaterThan(0);
    expect(result.layerCounts.vectorFacts).toBe(0);
    // Same fact indexed under two embedding models must surface once, not twice.
    const repoHits = result.facts.filter((f) => f.chunkId === "repo");
    expect(repoHits.length).toBe(1);
  });

  it("applies the same layer/lifecycle/importance filters as the vector stage", () => {
    const result = proactiveRecall({
      userMessage: "tell me about the repository",
      queryEmbedding: null,
      db,
      userModelManager: null,
      recentlySurfaced: new Map(),
      currentTurn: 1,
      keywordFallback,
    });
    const ids = result.facts.map((f) => f.chunkId);
    expect(ids).not.toContain("episode"); // experience layer excluded
    expect(ids).not.toContain("expired"); // dead lifecycle excluded
    expect(ids).not.toContain("lowimp"); // below minImportance
  });

  it("respects the cooldown window in the fallback path", () => {
    const surfaced = new Map<string, number>();
    const first = proactiveRecall({
      userMessage: "which repository?",
      queryEmbedding: null,
      db,
      userModelManager: null,
      recentlySurfaced: surfaced,
      currentTurn: 1,
      keywordFallback,
    });
    expect(first.layerCounts.keywordFacts).toBeGreaterThan(0);
    const second = proactiveRecall({
      userMessage: "which repository?",
      queryEmbedding: null,
      db,
      userModelManager: null,
      recentlySurfaced: surfaced,
      currentTurn: 2,
      keywordFallback,
    });
    expect(second.layerCounts.keywordFacts).toBe(0);
  });

  it("keeps the pre-fallback behavior when no fallback is supplied (opt-in)", () => {
    const result = proactiveRecall({
      userMessage: "which repository had traffic yesterday?",
      queryEmbedding: null,
      db,
      userModelManager: null,
      recentlySurfaced: new Map(),
      currentTurn: 1,
    });
    expect(result.facts.length).toBe(0);
  });
});

describe("vectorReserve keeps the semantic stage from being crowded out", () => {
  let db: DatabaseSync;
  let userModel: UserModelManager;

  beforeAll(() => {
    db = makeDb();
    userModel = new UserModelManager(db);
    const ins = db.prepare(
      `INSERT INTO user_preferences (id, category, key, value, confidence, evidence_ids, created_at, updated_at)
       VALUES (?, 'identity', ?, ?, 0.9, '[]', 1, 1)`,
    );
    ins.run("p1", "user_name", "Victor");
    ins.run("p2", "user_role", "neuroscientist");
    ins.run("p3", "user_location", "somewhere");
    insertFact(db, "repo", "The project repository is github.com/Bitterbot-AI/bitterbot-desktop.");
  });

  afterAll(() => db.close());

  it("caps pre-semantic stages so keyword/vector matches still land", () => {
    const result = proactiveRecall({
      userMessage: "which repository had traffic yesterday?",
      queryEmbedding: null,
      db,
      userModelManager: userModel,
      recentlySurfaced: new Map(),
      currentTurn: 1,
      config: { maxFacts: 3, vectorReserve: 2 },
      keywordFallback: { ftsTable: FTS_TABLE },
    });
    // Identity would otherwise take all 3 slots (3 prefs at 0.9 confidence);
    // the reserve holds 2 back for the semantic stage.
    expect(result.layerCounts.identityFacts).toBeLessThanOrEqual(1);
    expect(result.facts.map((f) => f.chunkId)).toContain("repo");
  });

  it("releases the reserve when no semantic stage can run", () => {
    const result = proactiveRecall({
      userMessage: "hello there, how are you?",
      queryEmbedding: null,
      db,
      userModelManager: userModel,
      recentlySurfaced: new Map(),
      currentTurn: 1,
      config: { maxFacts: 3, vectorReserve: 2 },
      // No keywordFallback and no embedding — identity may use all slots.
    });
    expect(result.layerCounts.identityFacts).toBe(3);
  });
});

describe("buildRecallFtsQuery", () => {
  it("ORs content words and drops stopwords/short tokens", () => {
    const q = buildRecallFtsQuery("which repository had traffic yesterday?");
    expect(q).toContain('"repository"');
    expect(q).toContain('"traffic"');
    expect(q).toContain(" OR ");
    expect(q).not.toContain('"which"');
    expect(q).not.toContain('"had"');
  });

  it("returns null for messages with no usable content words", () => {
    expect(buildRecallFtsQuery("how are you?")).toBeNull();
    expect(buildRecallFtsQuery("")).toBeNull();
  });
});

describe("applyRecallScope clears the cooldown map on conversation change", () => {
  it("clears when the scope key changes, keeps within a conversation", () => {
    const cooldown = new Map<string, number>([["fact-1", 7]]);
    let scope = applyRecallScope(cooldown, undefined, "agent:main:webchat:abc");
    expect(cooldown.size).toBe(0);
    expect(scope).toBe("agent:main:webchat:abc");

    cooldown.set("fact-1", 8);
    scope = applyRecallScope(cooldown, scope, "agent:main:webchat:abc");
    expect(cooldown.size).toBe(1); // same conversation — suppression persists

    scope = applyRecallScope(cooldown, scope, "agent:main:webchat:def");
    expect(cooldown.size).toBe(0); // new conversation — fresh window
    expect(scope).toBe("agent:main:webchat:def");
  });

  it("keeps today's behavior for callers without a scope key", () => {
    const cooldown = new Map<string, number>([["fact-1", 7]]);
    const scope = applyRecallScope(cooldown, "agent:main:webchat:abc", undefined);
    expect(cooldown.size).toBe(1);
    expect(scope).toBe("agent:main:webchat:abc");
  });
});
