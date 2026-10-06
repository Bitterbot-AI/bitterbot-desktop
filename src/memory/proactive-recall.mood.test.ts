/**
 * The agent's mood colors which memories come to mind unprompted: with high
 * oxytocin a relational memory outranks an equally relevant plain fact.
 */
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proactiveRecall } from "./proactive-recall.js";

const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const blob = (v: number[]) => Buffer.from(new Float32Array(unit(v)).buffer);
const QUERY = unit([1, 1, 0, 0]);

describe("proactive recall and mood", () => {
  let db: DatabaseSync;

  beforeAll(async () => {
    const sqliteVec = await import("sqlite-vec");
    db = new DatabaseSync(":memory:", { allowExtension: true });
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    db.exec(`CREATE TABLE chunks (
      id TEXT PRIMARY KEY, text TEXT, importance_score REAL, epistemic_layer TEXT,
      semantic_type TEXT, emotional_valence REAL, lifecycle TEXT, source TEXT,
      origin TEXT DEFAULT 'indexed', created_at INTEGER, embedding TEXT)`);
    db.exec("CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4])");
    const insC = db.prepare(
      `INSERT INTO chunks (id, text, importance_score, epistemic_layer, semantic_type, lifecycle)
       VALUES (?, ?, 0.8, 'world_fact', ?, 'generated')`,
    );
    const insV = db.prepare("INSERT INTO chunks_vec(id, embedding) VALUES (?, ?)");
    // Slightly closer to the query, but a plain fact.
    insC.run("fact", "The launch review is on Thursday.", "fact");
    insV.run("fact", blob([1, 1, 0.05, 0]));
    // Slightly further, but relational.
    insC.run("rel", "Sam is helping with the launch review.", "relationship");
    insV.run("rel", blob([1, 1, 0.25, 0]));
  });
  afterAll(() => db.close());

  const recall = (hormonalState?: { dopamine: number; cortisol: number; oxytocin: number }) =>
    proactiveRecall({
      userMessage: "how is the launch review going?",
      queryEmbedding: QUERY,
      db,
      userModelManager: null,
      recentlySurfaced: new Map(),
      currentTurn: 1,
      ...(hormonalState ? { hormonalState: { ...hormonalState, lastDecay: 0 } } : {}),
    }).facts.map((f) => f.chunkId);

  it("ranks by similarity alone with no mood", () => {
    expect(recall()).toEqual(["fact", "rel"]);
  });

  it("brings the relational memory first when oxytocin is high", () => {
    expect(recall({ dopamine: 0.1, cortisol: 0.02, oxytocin: 0.9 })).toEqual(["rel", "fact"]);
  });
});
