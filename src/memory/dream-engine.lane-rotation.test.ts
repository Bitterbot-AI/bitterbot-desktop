/**
 * Memory audit 2026-09-07 P3: the utility-lane rotation counter is seeded from
 * the persisted dream_cycles count in the constructor, so it ADVANCES across
 * gateway restarts. Before this fix it was an in-memory field reset to 0 each
 * boot, so lane 0 (hygiene) always won and distillation/anticipation starved.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DreamEngine } from "./dream-engine.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
});

function seedCycles(n: number): void {
  const stmt = db.prepare(
    `INSERT INTO dream_cycles (cycle_id, started_at, state) VALUES (?, ?, 'completed')`,
  );
  for (let i = 0; i < n; i += 1) {
    stmt.run(`c-${i}`, Date.now() - i);
  }
}

const noop = async () => "[]";
const noopSynth = async () => ({ summary: "", sections: {} }) as never;
const noopEmbed = async (xs: string[]) => xs.map(() => [] as number[]);

function utilityLane(cycles: number): string | undefined {
  seedCycles(cycles);
  const engine = new DreamEngine(db, { llmCall: noop, minChunksForDream: 1 }, noopSynth, noopEmbed);
  const modes = (engine as unknown as { selectModes(): string[] }).selectModes();
  return modes.find((m) => m === "hygiene" || m === "distillation" || m === "anticipation");
}

describe("dream utility-lane rotation seeding (P3)", () => {
  it("picks the lane at (persisted cycle count % 3), so it advances across restarts", () => {
    // The three utility lanes are enabled by default; the reserved slot rotates
    // hygiene -> distillation -> anticipation by the persisted cycle count.
    const lanes = ["hygiene", "distillation", "anticipation"];
    expect(utilityLane(0)).toBe(lanes[0]);
    // A fresh engine (simulating a restart) with 1 completed cycle advances.
    db.prepare(`DELETE FROM dream_cycles`).run();
    expect(utilityLane(1)).toBe(lanes[1]);
    db.prepare(`DELETE FROM dream_cycles`).run();
    expect(utilityLane(2)).toBe(lanes[2]);
    db.prepare(`DELETE FROM dream_cycles`).run();
    expect(utilityLane(3)).toBe(lanes[0]);
  });
});
