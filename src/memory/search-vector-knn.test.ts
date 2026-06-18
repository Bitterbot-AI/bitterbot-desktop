/**
 * Verifies searchVector uses vec0's native MATCH KNN (in a CTE) and returns
 * correct cosine-ordered results. The query changed from a full-table
 * vec_distance_cosine scan (~4.2s over ~8.7k vectors) to `MATCH ... k` + join
 * (~0.3s, ~15x). chunks_vec uses vec0's default L2 metric and embeddings are
 * unit-normalized, so the L2 order equals the cosine order and the reported
 * score (cosine) = 1 - L2^2/2.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { searchVector } from "./manager-search.js";

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
function blob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

describe("searchVector (vec0 MATCH)", () => {
  let db: DatabaseSync;
  const a = [1, 0, 0, 0];
  const c = unit([1, 1, 0, 0]); // 45 deg from a -> cosine ~0.7071
  const b = [0, 1, 0, 0]; // orthogonal to a -> cosine 0

  beforeAll(async () => {
    const sqliteVec = await import("sqlite-vec");
    db = new DatabaseSync(":memory:", { allowExtension: true });
    db.enableLoadExtension(true);
    sqliteVec.load(db);
    db.exec(`CREATE TABLE chunks (
      id TEXT PRIMARY KEY, path TEXT, start_line INTEGER, end_line INTEGER, text TEXT,
      source TEXT, model TEXT, importance_score REAL, updated_at INTEGER,
      last_accessed_at INTEGER, emotional_valence REAL
    )`);
    db.exec("CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[4])");
    const ic = db.prepare(
      "INSERT INTO chunks(id, path, start_line, end_line, text, source, model, importance_score, updated_at) VALUES (?,?,0,0,?,?,?,0.5,1)",
    );
    const iv = db.prepare("INSERT INTO chunks_vec(id, embedding) VALUES (?, ?)");
    for (const [id, vec] of [
      ["a", a],
      ["b", b],
      ["c", c],
    ] as const) {
      ic.run(id, `p/${id}.md`, `text ${id}`, "memory", "test-model");
      iv.run(id, blob(vec));
    }
  });

  afterAll(() => db.close());

  it("returns nearest neighbors in cosine order with correct scores", async () => {
    const res = await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "test-model",
      queryVec: a,
      limit: 2,
      snippetMaxChars: 50,
      ensureVectorReady: async () => true,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });

    expect(res.map((r) => r.id)).toEqual(["a", "c"]);
    expect(res[0]!.score).toBeCloseTo(1, 3);
    expect(res[1]!.score).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it("respects the model filter", async () => {
    const res = await searchVector({
      db,
      vectorTable: "chunks_vec",
      providerModel: "other-model", // matches nothing
      queryVec: a,
      limit: 5,
      snippetMaxChars: 50,
      ensureVectorReady: async () => true,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });
    expect(res).toHaveLength(0);
  });
});
