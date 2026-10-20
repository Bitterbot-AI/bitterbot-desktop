import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ReconsolidationEngine } from "./reconsolidation.js";

describe("reconsolidation", () => {
  it("counts a memory that came through its labile window as a rehearsal", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE chunks (id TEXT PRIMARY KEY, importance_score REAL, access_count INTEGER,
      reconsolidation_count INTEGER, labile_until INTEGER)`);
    db.prepare("INSERT INTO chunks VALUES ('a', 0.5, 3, 0, ?)").run(Date.now() - 1000);
    db.prepare("INSERT INTO chunks VALUES ('b', 0.5, 3, 0, ?)").run(Date.now() + 60_000);

    const engine = new ReconsolidationEngine(db);
    expect(engine.restabilizeExpired()).toBe(1);

    const row = (id: string) =>
      db.prepare("SELECT access_count, labile_until FROM chunks WHERE id = ?").get(id) as {
        access_count: number;
        labile_until: number | null;
      };
    // Consolidation recomputes importance from access_count, so this lasts.
    expect(row("a")).toEqual({ access_count: 4, labile_until: null });
    expect(row("b").access_count).toBe(3);
  });
});
