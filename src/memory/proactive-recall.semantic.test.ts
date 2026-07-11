/**
 * Regression test for the proactive-recall wiring bug.
 *
 * The only caller used to pass `queryEmbedding: null`, so the semantic branch
 * never ran and stored world_facts (e.g. "ranked #4 on OpenRouter", "processed
 * 636M tokens") were never surfaced into the prompt — the agent would then
 * "hallucinate" denials of facts sitting embedded in its own DB. These tests
 * pin the behavior that, given a real query embedding, relevant directive/
 * world_fact/mental_model crystals surface, including ones below the old 0.4
 * importance floor, and that without an embedding only identity facts surface.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { proactiveRecall } from "./proactive-recall.js";

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
function blob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(unit(v)).buffer);
}

// Embedding close to the query (so cosine score clears minScore 0.55).
const QUERY = unit([1, 1, 0, 0]);

describe("proactiveRecall semantic surfacing", () => {
  let db: DatabaseSync;

  beforeAll(async () => {
    const sqliteVec = await import("sqlite-vec");
    db = new DatabaseSync(":memory:", { allowExtension: true });
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    db.exec(`CREATE TABLE chunks (
      id TEXT PRIMARY KEY, text TEXT, importance_score REAL, epistemic_layer TEXT,
      semantic_type TEXT, emotional_valence REAL, lifecycle TEXT, source TEXT,
      origin TEXT DEFAULT 'indexed',
      created_at INTEGER, embedding TEXT)`);
    db.exec("CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4])");

    const insC = db.prepare(
      `INSERT INTO chunks (id, text, importance_score, epistemic_layer, semantic_type, lifecycle)
       VALUES (?, ?, ?, ?, 'fact', 'generated')`,
    );
    const insV = db.prepare("INSERT INTO chunks_vec(id, embedding) VALUES (?, ?)");

    // High-importance, on-topic world_fact.
    insC.run(
      "rank",
      "Bitterbot is ranked #4 on the OpenRouter Top Public Apps list.",
      0.75,
      "world_fact",
    );
    insV.run("rank", blob([1, 1, 0, 0]));
    // Low-importance world_fact (0.18) — below the old 0.4 floor, must still surface.
    insC.run(
      "tokens",
      "Bitterbot processed 636 million tokens according to OpenRouter.",
      0.18,
      "world_fact",
    );
    insV.run("tokens", blob([1, 0.9, 0, 0]));
    // Off-topic world_fact — high importance but orthogonal, must be filtered by minScore.
    insC.run("offtopic", "The capital of France is Paris.", 0.95, "world_fact");
    insV.run("offtopic", blob([0, 0, 1, 0]));
    // Borderline relevance: cos([1,0,1,0], [1,1,0,0]) = 0.50 — between the old
    // 0.55 gate (would have been dropped) and the tuned 0.45 gate (surfaces).
    // Mirrors the real "who is my wife" ~0.50 case that used to fall through.
    insC.run("borderline", "Bitterbot's mesh has 36,000 active nodes.", 0.6, "world_fact");
    insV.run("borderline", blob([1, 0, 1, 0]));
  });

  afterAll(() => db.close());

  it("surfaces on-topic world_facts, including below the old importance floor", () => {
    const result = proactiveRecall({
      userMessage: "what kind of traction does Bitterbot have on OpenRouter?",
      queryEmbedding: QUERY,
      db,
      userModelManager: null,
      recentlySurfaced: new Map(),
      currentTurn: 1,
    });
    const texts = result.facts.map((f) => f.text).join(" | ");
    expect(texts).toContain("ranked #4");
    expect(texts).toContain("636 million"); // lowered floor lets the 0.18 fact through
    expect(texts).not.toContain("Paris"); // off-topic filtered by cosine minScore
  });

  it("surfaces borderline-relevant facts (~0.50 cosine) that the old 0.55 gate dropped", () => {
    const result = proactiveRecall({
      userMessage: "how many nodes does the bitterbot mesh have?",
      queryEmbedding: QUERY,
      db,
      userModelManager: null,
      recentlySurfaced: new Map(),
      currentTurn: 1,
    });
    const texts = result.facts.map((f) => f.text).join(" | ");
    // cos 0.50 >= 0.45 (tuned) but < 0.55 (old) — this is the relational/short-query fix.
    expect(texts).toContain("36,000 active nodes");
  });

  it("surfaces nothing semantic when no query embedding is provided (the old bug)", () => {
    const result = proactiveRecall({
      userMessage: "what kind of traction does Bitterbot have?",
      queryEmbedding: null,
      db,
      userModelManager: null,
      recentlySurfaced: new Map(),
      currentTurn: 1,
    });
    expect(result.facts.length).toBe(0);
  });

  it("respects the cooldown window so a fact is not resurfaced every turn", () => {
    const surfaced = new Map<string, number>();
    const first = proactiveRecall({
      userMessage: "traction on OpenRouter?",
      queryEmbedding: QUERY,
      db,
      userModelManager: null,
      recentlySurfaced: surfaced,
      currentTurn: 1,
    });
    expect(first.facts.length).toBeGreaterThan(0);
    // Next turn, still inside cooldownTurns (5) — the same facts stay quiet.
    const second = proactiveRecall({
      userMessage: "traction on OpenRouter?",
      queryEmbedding: QUERY,
      db,
      userModelManager: null,
      recentlySurfaced: surfaced,
      currentTurn: 2,
    });
    expect(second.facts.length).toBe(0);
  });
});
