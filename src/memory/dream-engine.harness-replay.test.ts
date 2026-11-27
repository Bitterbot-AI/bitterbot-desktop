/**
 * PLAN-64 Phase 6: the dream engine hands the harness_evolve mode its
 * evaluation setting, and never builds a trial executor it may not use.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultHarnessPolicy } from "../agents/embedded-runner/harness-policy.js";
import { DreamEngine, type HarnessEvolveContext } from "./dream-engine.js";
import type { DreamInsight } from "./dream-types.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

type ModeResult = { insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number };
type EngineInternals = {
  runHarnessEvolveMode(cycleId: string): Promise<ModeResult>;
  buildEvolutionAgentTurn(): Promise<unknown>;
};

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
  const stmt = db.prepare(
    `INSERT INTO skill_executions
       (id, skill_crystal_id, session_id, started_at, completed_at, success, error_type, run_id, tool_name)
     VALUES (?, 'skill', 's', ?, ?, ?, ?, ?, 'read')`,
  );
  const now = Date.now();
  for (let i = 0; i < 120; i++) {
    const fail = i % 4 === 0;
    stmt.run(
      `exec-${i}`,
      now - i,
      now - i,
      fail ? 0 : 1,
      fail ? "tool_not_found" : null,
      `run-${i}`,
    );
  }
});

function engineWith(ctx: Partial<HarnessEvolveContext>, llmCall: () => Promise<string>) {
  const engine = new DreamEngine(
    db,
    { llmCall, minChunksForDream: 1 },
    async () => "",
    async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  );
  engine.setHarnessEvolveContext({
    enabled: true,
    baseline: () => defaultHarnessPolicy(),
    ...ctx,
  });
  const internals = engine as unknown as EngineInternals;
  const build = vi.spyOn(internals, "buildEvolutionAgentTurn");
  return { internals, build };
}

describe("dream engine harness_evolve wiring (PLAN-64 Phase 6)", () => {
  it("stays inert when the mode is not enabled", async () => {
    const llm = vi.fn(async () => "[]");
    const { internals, build } = engineWith({ enabled: false }, llm);
    const res = await internals.runHarnessEvolveMode("c1");
    expect(res).toEqual({ insights: [], llmCalls: 0, chunksAnalyzed: 0 });
    expect(llm).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("defaults to replay and refuses to promote when replay may not dispatch", async () => {
    const llm = vi.fn(async () => "[]");
    const { internals, build } = engineWith({ canReplay: () => false }, llm);
    const res = await internals.runHarnessEvolveMode("c1");
    expect(build).not.toHaveBeenCalled(); // no gateway client is assembled
    expect(llm).not.toHaveBeenCalled(); // no proposer spend
    expect(res.insights).toHaveLength(1);
    expect(res.insights[0]!.mode).toBe("harness_evolve");
    expect(res.insights[0]!.content).toContain("(replay) evaluated nothing and promoted nothing");
    expect(res.insights[0]!.content).toContain("no trial executor");
  });

  it("with a trial executor, replay still refuses when nothing is replayable", async () => {
    const llm = vi.fn(async () => "[]");
    const { internals, build } = engineWith({ canReplay: () => true }, llm);
    const turn = vi.fn(async () => "FINAL: 42");
    build.mockResolvedValue(turn);
    const res = await internals.runHarnessEvolveMode("c1");
    expect(build).toHaveBeenCalledTimes(1);
    // The node has no reviewed task linked to any of these runs.
    expect(turn).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    expect(res.insights[0]!.content).toMatch(/0 of \d+ held-out executions are replayable/);
    expect(res.insights[0]!.content).toContain("no reviewed task with a checker");
  });

  it("predicted mode never builds a trial executor", async () => {
    const llm = vi.fn(async () => "[]"); // the proposer returns no candidates
    const { internals, build } = engineWith(
      { evaluation: "predicted", canReplay: () => true },
      llm,
    );
    const res = await internals.runHarnessEvolveMode("c1");
    expect(build).not.toHaveBeenCalled();
    expect(llm).toHaveBeenCalledTimes(1);
    expect(res.insights).toEqual([]);
  });
});
