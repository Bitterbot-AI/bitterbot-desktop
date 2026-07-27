import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inspectRetrievalTrace } from "./doctor-retrieval.js";

const NOW = 1_750_000_000_000;

function traceDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE retrieval_trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, query_len INTEGER NOT NULL DEFAULT 0,
      vector_hits INTEGER NOT NULL DEFAULT 0, keyword_hits INTEGER NOT NULL DEFAULT 0,
      graph_hits INTEGER NOT NULL DEFAULT 0, fused INTEGER NOT NULL DEFAULT 0,
      extra TEXT, created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertTrace(
  db: DatabaseSync,
  kind: "search" | "recall",
  hits: { vec?: number; kw?: number; graph?: number; fused?: number },
  at: number = NOW - 60_000,
): void {
  db.prepare(
    `INSERT INTO retrieval_trace (kind, vector_hits, keyword_hits, graph_hits, fused, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(kind, hits.vec ?? 0, hits.kw ?? 0, hits.graph ?? 0, hits.fused ?? 0, at);
}

describe("inspectRetrievalTrace", () => {
  it("does NOT flag keyword on a healthy recall-dominated node (regression)", () => {
    // On kind='recall' rows keyword_hits counts FTS-FALLBACK facts: zero
    // there means the vector path is HEALTHY. A naive cross-kind sum
    // perpetually warned "keyword wired-but-dead" on exactly the good case.
    const db = traceDb();
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", { vec: 3, graph: 1, fused: 4 });
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.some((r) => /"keyword"/.test(r.message) && r.level === "warn")).toBe(false);
    expect(results.some((r) => r.level === "ok")).toBe(true);
    db.close();
  });

  it("counts recall keyword-fallback hits toward the vector lane", () => {
    // Vector column 0 but fallback keyword facts flowing → the vector LANE
    // (embedding pipeline degraded-but-recalling) is not "dead".
    const db = traceDb();
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", { kw: 2, fused: 2 });
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.some((r) => /"vector"/.test(r.message) && r.level === "warn")).toBe(false);
    db.close();
  });

  it("flags the graph lane when other lanes contribute and graph never does", () => {
    const db = traceDb();
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", { vec: 3, fused: 3 });
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.some((r) => r.level === "warn" && /"graph" had 0 hits/.test(r.message))).toBe(
      true,
    );
    db.close();
  });

  it("judges the keyword lane only on explicit search traffic", () => {
    const db = traceDb();
    // Plenty of recall traffic plus enough searches where keyword returns 0.
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", { vec: 2, fused: 2 });
    for (let i = 0; i < 25; i++) insertTrace(db, "search", { vec: 2, fused: 2 });
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.some((r) => r.level === "warn" && /"keyword" had 0 hits/.test(r.message))).toBe(
      true,
    );
    db.close();
  });

  it("stays quiet on keyword when search traffic is too thin", () => {
    const db = traceDb();
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", { vec: 2, fused: 2, graph: 1 });
    for (let i = 0; i < 5; i++) insertTrace(db, "search", { vec: 2, fused: 2, graph: 1 });
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.some((r) => /"keyword"/.test(r.message) && r.level === "warn")).toBe(false);
    db.close();
  });

  it("all-zero lanes on a sparse memory is info, not three dead wires", () => {
    const db = traceDb();
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", {});
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.every((r) => r.level === "info")).toBe(true);
    expect(results.some((r) => /sparse/.test(r.message))).toBe(true);
    db.close();
  });

  it("flags fusion returning nothing while lanes contribute", () => {
    const db = traceDb();
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", { vec: 1, graph: 1, fused: 0 });
    const results = inspectRetrievalTrace(db, NOW);
    expect(
      results.some((r) => r.level === "warn" && /Fusion produced 0 results/.test(r.message)),
    ).toBe(true);
    db.close();
  });

  it("stays quiet (info) below the minimum sample size", () => {
    const db = traceDb();
    for (let i = 0; i < 5; i++) insertTrace(db, "recall", {});
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.every((r) => r.level === "info")).toBe(true);
    db.close();
  });

  it("ignores samples outside the 7-day window", () => {
    const db = traceDb();
    for (let i = 0; i < 25; i++) insertTrace(db, "recall", { vec: 1 }, NOW - 30 * 24 * 60 * 60_000);
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.every((r) => r.level === "info")).toBe(true);
    db.close();
  });

  it("info when the trace table is absent (pre-v21 DB)", () => {
    const db = new DatabaseSync(":memory:");
    const results = inspectRetrievalTrace(db, NOW);
    expect(results.some((r) => r.level === "info" && /absent/.test(r.message))).toBe(true);
    db.close();
  });
});
