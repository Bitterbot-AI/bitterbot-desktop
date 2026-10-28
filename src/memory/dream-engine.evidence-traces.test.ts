/**
 * PLAN-59 Phase 0: shadow decision traces in the dream engine.
 *
 * Off and observe write no decision_traces rows. Shadow writes a
 * `dream_seed_rank` row whose `diverged` flag is true exactly when the
 * curiosity reward changes the seed order, and a `dream_mode_select` row whose
 * legacy selection is the selection the engine returned. The legacy decision
 * itself is unchanged by the telemetry in every mode.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DreamEngine } from "./dream-engine.js";
import { EvidenceTelemetry } from "./evidence-telemetry.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

type SeedRow = { id: string };
type Engine = {
  selectSeeds(limit?: number, priorityIds?: string[]): SeedRow[];
  selectModes(): string[];
};

const quiet = { debug: () => {}, warn: () => {} };
const noop = async () => "[]";
const noopSynth = async () => ({ summary: "", sections: {} }) as never;
const noopEmbed = async (xs: string[]) => xs.map(() => [] as number[]);

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

afterEach(() => {
  vi.restoreAllMocks();
});

function insertChunk(id: string, importance: number, curiosityReward: number | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, curiosity_reward, created_at, updated_at)
     VALUES (?, 'mem', 'memory', 0, 0, ?, ?, 'm', '[0.1,0.2,0.3]', ?, ?, ?, ?)`,
  ).run(id, `text ${id}`, `h-${id}`, importance, curiosityReward, now, now);
}

function engine(telemetry: EvidenceTelemetry | null): Engine {
  const e = new DreamEngine(db, { llmCall: noop, minChunksForDream: 1 }, noopSynth, noopEmbed);
  e.setEvidenceTelemetry(telemetry);
  return e as unknown as Engine;
}

const traces = () =>
  db
    .prepare(`SELECT kind, legacy_json, proposed_json, diverged FROM decision_traces ORDER BY id`)
    .all() as unknown as Array<{
    kind: string;
    legacy_json: string;
    proposed_json: string;
    diverged: number;
  }>;

describe("dream seed ranking traces (dream_seed_rank)", () => {
  it("writes nothing in off and observe mode and keeps the legacy order", () => {
    insertChunk("a", 0.5, 0.9);
    insertChunk("b", 0.8, null);
    insertChunk("c", 0.6, 0.1);
    const legacy = engine(null)
      .selectSeeds(3)
      .map((r) => r.id);
    expect(legacy).toEqual(["a", "b", "c"]); // 1.4, 0.8, 0.7
    for (const mode of ["off", "observe"] as const) {
      const ids = engine(new EvidenceTelemetry(db, { mode }, quiet))
        .selectSeeds(3)
        .map((r) => r.id);
      expect(ids).toEqual(legacy);
    }
    expect(traces()).toEqual([]);
  });

  it("shadow records diverged=1 when the curiosity reward reorders the seeds and the legacy order is unchanged", () => {
    insertChunk("a", 0.5, 0.9);
    insertChunk("b", 0.8, null);
    insertChunk("c", 0.6, 0.1);
    insertChunk("d", 0.3, 0.0);
    const ids = engine(new EvidenceTelemetry(db, { mode: "shadow" }, quiet))
      .selectSeeds(3)
      .map((r) => r.id);
    expect(ids).toEqual(["a", "b", "c"]);
    const rows = traces();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("dream_seed_rank");
    expect(rows[0]!.diverged).toBe(1);
    expect(JSON.parse(rows[0]!.legacy_json)).toEqual({ ids: ["a", "b", "c"], limit: 3 });
    expect(JSON.parse(rows[0]!.proposed_json)).toEqual({ ids: ["b", "c", "a"], limit: 3 });
  });

  it("shadow records diverged=0 when the curiosity reward does not change the order", () => {
    insertChunk("a", 0.9, 0.1);
    insertChunk("b", 0.8, 0.1);
    insertChunk("c", 0.7, null);
    const ids = engine(new EvidenceTelemetry(db, { mode: "shadow" }, quiet))
      .selectSeeds(3)
      .map((r) => r.id);
    expect(ids).toEqual(["a", "b", "c"]);
    const rows = traces();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.diverged).toBe(0);
    expect(JSON.parse(rows[0]!.proposed_json).ids).toEqual(["a", "b", "c"]);
  });

  it("priority seeds and an exhausted limit leave no trace to write", () => {
    insertChunk("a", 0.9, 0.1);
    const e = engine(new EvidenceTelemetry(db, { mode: "shadow" }, quiet));
    // limit fully consumed by priority ids: remaining = 0, no shadow query
    expect(e.selectSeeds(1, ["a"]).map((r) => r.id)).toEqual(["a"]);
    expect(traces()).toEqual([]);
  });
});

describe("dream mode selection traces (dream_mode_select)", () => {
  function seedForModes(): void {
    for (let i = 0; i < 8; i++) {
      insertChunk(`m${i}`, 0.5 + i * 0.05, 0.4);
    }
  }

  it("writes nothing in off and observe mode", () => {
    seedForModes();
    for (const mode of ["off", "observe"] as const) {
      const modes = engine(new EvidenceTelemetry(db, { mode }, quiet)).selectModes();
      expect(modes.length).toBeGreaterThan(0);
    }
    expect(traces()).toEqual([]);
  });

  it("shadow records the legacy selection as returned, a zero-GCCRF proposal, and does not change the pick", () => {
    seedForModes();
    const sequence = [0.11, 0.42, 0.73, 0.21, 0.64, 0.95, 0.37, 0.58];
    let n = 0;
    vi.spyOn(Math, "random").mockImplementation(() => sequence[n++ % sequence.length]!);
    const baseline = engine(null).selectModes();
    const callsBaseline = n;

    n = 0;
    const shadowed = engine(new EvidenceTelemetry(db, { mode: "shadow" }, quiet)).selectModes();
    expect(shadowed).toEqual(baseline);
    // the shadow selection replays the same draws instead of consuming new ones
    expect(n).toBe(callsBaseline);

    const rows = traces().filter((r) => r.kind === "dream_mode_select");
    expect(rows).toHaveLength(1);
    const legacy = JSON.parse(rows[0]!.legacy_json) as {
      selected: string[];
      weights: Record<string, number>;
      gccrfWeight: number;
    };
    const proposed = JSON.parse(rows[0]!.proposed_json) as {
      selected: string[];
      weights: Record<string, number>;
      gccrfWeight: number;
    };
    expect(legacy.selected).toEqual(shadowed);
    expect(legacy.gccrfWeight).toBeGreaterThanOrEqual(0.25);
    expect(legacy.gccrfWeight).toBeLessThanOrEqual(0.3);
    expect(proposed.gccrfWeight).toBe(0);
    expect(Object.keys(proposed.weights).toSorted()).toEqual(
      Object.keys(legacy.weights).toSorted(),
    );
    expect(proposed.selected.length).toBe(legacy.selected.length);
    // the flag is the decision, not the weights
    const same = JSON.stringify(legacy.selected) === JSON.stringify(proposed.selected);
    expect(rows[0]!.diverged).toBe(same ? 0 : 1);
  });

  it("a trace writer that throws never changes the selection", () => {
    seedForModes();
    const t = new EvidenceTelemetry(db, { mode: "shadow" }, quiet);
    vi.spyOn(t, "recordDecisionTrace").mockImplementation(() => {
      throw new Error("boom");
    });
    const sequence = [0.3, 0.6, 0.9];
    let n = 0;
    vi.spyOn(Math, "random").mockImplementation(() => sequence[n++ % sequence.length]!);
    const baseline = engine(null).selectModes();
    n = 0;
    expect(engine(t).selectModes()).toEqual(baseline);
  });
});
