import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScorePairFn } from "../experiment-sandbox.js";
import {
  readHarnessPolicyProvenance,
  readLivePolicy,
} from "../../agents/pi-embedded-runner/harness-policy-store.js";
import { defaultHarnessPolicy } from "../../agents/pi-embedded-runner/harness-policy.js";
import { runHarnessEvolve } from "./harness-evolve.js";

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE skill_executions (
    id TEXT PRIMARY KEY, skill_crystal_id TEXT, session_id TEXT, started_at INTEGER,
    completed_at INTEGER, success INTEGER, reward_score REAL, error_type TEXT)`);
  const stmt = db.prepare(
    `INSERT INTO skill_executions
     (id, skill_crystal_id, session_id, started_at, completed_at, success, reward_score, error_type)
     VALUES (?, ?, 's', ?, ?, ?, 0.5, ?)`,
  );
  // 80 completed executions (gives a held-out set) including failures (gives clusters).
  for (let i = 0; i < 80; i++) {
    const fail = i % 4 === 0;
    stmt.run(
      `exec-${i}`,
      `skill-${i % 3}`,
      1000 + i,
      2000 + i,
      fail ? 0 : 1,
      fail ? "tool_not_found" : null,
    );
  }
  return db;
}

const candidateWins: ScorePairFn = async (_a, _b, sel) =>
  sel.map((e) => ({ taskId: e.id, aPassed: false, bPassed: true }));

const proposerLlm = async () =>
  JSON.stringify([
    {
      policy: {
        ...defaultHarnessPolicy(),
        tools: {
          descriptionOverrides: {
            memory_search: "Use for recall of prior facts before answering.",
          },
        },
      },
      targetedMechanism: "skill:tool_not_found",
      rationale: "route factual questions through memory_search",
    },
  ]);

describe("runHarnessEvolve (PLAN-25 orchestrator)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "harness-evolve-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mines, proposes, validates, and promotes one policy end-to-end", async () => {
    const res = await runHarnessEvolve({
      db: seedDb(),
      cycleId: "cycle-1",
      baseline: defaultHarnessPolicy(),
      llmCall: proposerLlm,
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 1, // not a slow-update cycle
      scorePair: candidateWins,
      bootstrapIterations: 500,
      random: () => 0.5,
    });
    expect(res.promotedVersion).not.toBeNull();
    expect(res.insights.length).toBeGreaterThanOrEqual(1);
    expect(res.insights[0].mode).toBe("harness_evolve");
    const live = readLivePolicy({ configDir: dir });
    expect(live?.provenance).toBe("evolved");
    expect(live?.tools.descriptionOverrides.memory_search).toContain("recall");

    // The promotion left a full evidence trail: trigger clusters, gate
    // statistics, and the held-out execution ids that were judged.
    const provenance = await readHarnessPolicyProvenance(100, { configDir: dir });
    const promote = provenance.filter((r) => r.event === "promote");
    expect(promote).toHaveLength(1);
    expect(promote[0]).toMatchObject({
      version: res.promotedVersion,
      reason: "skill:tool_not_found",
      surfacesTouched: ["tools"],
      trigger: { mechanism: "skill:tool_not_found" },
    });
    expect(promote[0]!.ci95Low).toBeGreaterThan(0);
    expect(promote[0]!.nPaired).toBeGreaterThan(0);
    expect(promote[0]!.trigger?.clusters?.length).toBeGreaterThanOrEqual(1);
    expect(promote[0]!.trigger?.clusters?.[0]?.sampleIds.length).toBeGreaterThan(0);
    expect(promote[0]!.heldOutIds?.length).toBeGreaterThan(0);
  });

  it("is inert with no trace data", async () => {
    const res = await runHarnessEvolve({
      db: new DatabaseSync(":memory:"),
      cycleId: "c",
      baseline: defaultHarnessPolicy(),
      llmCall: proposerLlm,
      nowMs: 1,
      configDir: dir,
      scorePair: candidateWins,
    });
    expect(res.promotedVersion).toBeNull();
    expect(res.llmCalls).toBe(0);
    expect(readLivePolicy({ configDir: dir })).toBeNull();
  });

  it("does not promote when the candidate fails validation", async () => {
    const res = await runHarnessEvolve({
      db: seedDb(),
      cycleId: "c",
      baseline: defaultHarnessPolicy(),
      llmCall: proposerLlm,
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 1,
      scorePair: async (_a, _b, sel) =>
        sel.map((e) => ({ taskId: e.id, aPassed: true, bPassed: true })),
      random: () => 0.5,
    });
    expect(res.promotedVersion).toBeNull();
    expect(readLivePolicy({ configDir: dir })).toBeNull();

    // Rejections leave evidence too
    const provenance = await readHarnessPolicyProvenance(100, { configDir: dir });
    const rejects = provenance.filter((r) => r.event === "reject");
    expect(rejects.length).toBeGreaterThanOrEqual(1);
    expect(rejects[0]!.reason).toMatch(/no-improvement|ci-includes-zero/);
    expect(rejects[0]!.heldOutIds?.length).toBeGreaterThan(0);
  });
});
