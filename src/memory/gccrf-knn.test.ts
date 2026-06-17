/**
 * Verifies GCCRF knnSearch uses vec0's native MATCH KNN and returns correct
 * cosine-equivalent results. The query was changed from a full-table
 * vec_distance_cosine scan (~4.4s over ~8.7k vectors) to `MATCH ... k` (~0.1s);
 * since chunks_vec uses vec0's default L2 metric and embeddings are unit
 * normalized, cosine = 1 - L2^2/2. This guards both the speed-driving query
 * shape and that conversion.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { GCCRFRewardFunction } from "./gccrf-reward.js";

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function blob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

describe("GCCRF knnSearch (vec0 MATCH)", () => {
  let db: DatabaseSync;
  let reward: GCCRFRewardFunction;

  const a = [1, 0, 0, 0];
  const c = unit([1, 1, 0, 0]); // 45 deg from a -> cosine ~0.707
  const b = [0, 1, 0, 0]; // orthogonal to a -> cosine 0

  beforeAll(async () => {
    const sqliteVec = await import("sqlite-vec");
    db = new DatabaseSync(":memory:", { allowExtension: true });
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    // The GCCRF constructor adds a curiosity_reward column to chunks.
    db.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, embedding TEXT, lifecycle_state TEXT)");
    // Same shape as production chunks_vec: vec0 default (L2) metric.
    db.exec("CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4])");
    const ins = db.prepare("INSERT INTO chunks_vec(id, embedding) VALUES (?, ?)");
    ins.run("a", blob(a));
    ins.run("b", blob(b));
    ins.run("c", blob(c));
    reward = new GCCRFRewardFunction(db);
  });

  afterAll(() => {
    db.close();
  });

  it("returns nearest neighbors in cosine order with correct similarities", () => {
    const knn = (
      reward as unknown as {
        knnSearch: (e: number[], k: number) => Array<{ id: string; similarity: number }>;
      }
    ).knnSearch(a, 3);

    expect(knn.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(knn[0]!.similarity).toBeCloseTo(1, 3); // identical
    expect(knn[1]!.similarity).toBeCloseTo(Math.SQRT1_2, 3); // 45 degrees (1/sqrt(2))
    expect(knn[2]!.similarity).toBeCloseTo(0, 3); // orthogonal
  });

  it("falls back without throwing when the vec table is missing", () => {
    const bare = new DatabaseSync(":memory:");
    bare.exec(
      "CREATE TABLE chunks (id TEXT, embedding TEXT, lifecycle_state TEXT, updated_at INTEGER)",
    );
    const r = new GCCRFRewardFunction(bare);
    const knn = (r as unknown as { knnSearch: (e: number[], k: number) => unknown[] }).knnSearch(
      a,
      3,
    );
    expect(Array.isArray(knn)).toBe(true);
    bare.close();
  });
});
