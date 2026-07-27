import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { inspectDreamModeLiveness } from "./doctor-memory-system.js";

const NOW = 1_750_000_000_000;

function dreamDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE dream_cycles (
      cycle_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, completed_at INTEGER,
      duration_ms INTEGER, state TEXT NOT NULL DEFAULT 'DORMANT',
      insights_generated INTEGER DEFAULT 0, modes_used TEXT DEFAULT '[]', error TEXT
    );
  `);
  return db;
}

function insertCycle(db: DatabaseSync, i: number, modes: string[]): void {
  db.prepare(
    `INSERT INTO dream_cycles (cycle_id, started_at, completed_at, modes_used) VALUES (?, ?, ?, ?)`,
  ).run(`c${i}`, NOW - i * 60_000, NOW - i * 60_000 + 30_000, JSON.stringify(modes));
}

const EMPTY_CFG = {} as BitterbotConfig;

describe("inspectDreamModeLiveness", () => {
  it("stays quiet below the cycle threshold (a low-weight mode needs time)", () => {
    const db = dreamDb();
    for (let i = 0; i < 30; i++) insertCycle(db, i, ["replay"]);
    expect(inspectDreamModeLiveness(db, EMPTY_CFG)).toEqual([]);
    db.close();
  });

  it("warns for enabled modes never selected across many cycles", () => {
    const db = dreamDb();
    // 45 cycles, only replay/compression ever run — harness_evolve,
    // relationship_mining etc. are enabled by default and never appear.
    for (let i = 0; i < 45; i++) insertCycle(db, i, ["replay", "compression"]);
    const results = inspectDreamModeLiveness(db, EMPTY_CFG);
    const liveness = results.find((r) => r.level === "warn");
    expect(liveness).toBeTruthy();
    expect(liveness?.message).toContain("harness_evolve");
    expect(liveness?.message).toContain("relationship_mining");
    // Disabled-by-default modes must NOT be flagged.
    expect(liveness?.message).not.toContain("research");
    db.close();
  });

  it("respects config-disabled modes", () => {
    const db = dreamDb();
    for (let i = 0; i < 45; i++)
      insertCycle(db, i, [
        "replay",
        "compression",
        "mutation",
        "simulation",
        "extrapolation",
        "exploration",
        "interceptor_harvest",
        "relationship_reconsolidation",
        "relationship_mining",
        "canonical_promotion",
      ]);
    const cfg = {
      memory: { dream: { modes: { harness_evolve: { enabled: false } } } },
    } as unknown as BitterbotConfig;
    const results = inspectDreamModeLiveness(db, cfg);
    expect(results.some((r) => r.level === "ok")).toBe(true);
    db.close();
  });

  it("reports ok when every enabled mode has run", () => {
    const db = dreamDb();
    for (let i = 0; i < 45; i++)
      insertCycle(db, i, [
        "replay",
        "compression",
        "mutation",
        "simulation",
        "extrapolation",
        "exploration",
        "interceptor_harvest",
        "relationship_reconsolidation",
        "harness_evolve",
        "relationship_mining",
        "canonical_promotion",
      ]);
    const results = inspectDreamModeLiveness(db, EMPTY_CFG);
    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe("ok");
    db.close();
  });
});
