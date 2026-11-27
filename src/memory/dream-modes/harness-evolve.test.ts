import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  promotePolicy,
  readHarnessPolicyProvenance,
  readLivePolicy,
} from "../../agents/embedded-runner/harness-policy-store.js";
import { resolveTrialHarnessPolicy } from "../../agents/embedded-runner/harness-policy-trial.js";
import {
  defaultHarnessPolicy,
  type HarnessPolicy,
} from "../../agents/embedded-runner/harness-policy.js";
import type { ScorePairFn } from "../experiment-sandbox.js";
import type { CorpusTask } from "../skill-evolution/task-corpus.js";
import type { AgentTurnFn } from "../skill-evolution/task-runner.js";
import { isHeldOut } from "../skill-execution-selection.js";
import { runHarnessEvolve } from "./harness-evolve.js";
import { HarnessReplayLedger } from "./harness-evolve.replay-ledger.js";

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
    // PLAN-64 Phase 6: an injected judge executes nothing and is labelled so.
    expect(promote[0]).toMatchObject({ evaluation: "predicted", nExecuted: 0 });
    expect(res.insights[0]!.content).toContain("PREDICTION");
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

// ── PLAN-64 Phase 6: replay evaluation through the real scorer, selection,
// gate and slow-update code, with a scripted trial executor. ──

const N_EXECUTIONS = 200;
/** Every 7th execution was recorded from a messaging tool; every 11th has no run id. */
const isMessaging = (i: number) => i % 7 === 0;
const hasNoRun = (i: number) => i % 11 === 0;

function seedReplayDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE skill_executions (
    id TEXT PRIMARY KEY, skill_crystal_id TEXT, session_id TEXT, started_at INTEGER,
    completed_at INTEGER, success INTEGER, reward_score REAL, error_type TEXT,
    run_id TEXT, tool_name TEXT)`);
  const stmt = db.prepare(
    `INSERT INTO skill_executions
     (id, skill_crystal_id, session_id, started_at, completed_at, success, reward_score, error_type, run_id, tool_name)
     VALUES (?, ?, 's', ?, ?, ?, 0.5, ?, ?, ?)`,
  );
  for (let i = 0; i < N_EXECUTIONS; i++) {
    const fail = i % 4 === 0;
    stmt.run(
      `exec-${i}`,
      `skill-${i % 3}`,
      1000 + i,
      2000 + i,
      fail ? 0 : 1,
      fail ? "tool_not_found" : null,
      hasNoRun(i) ? null : `run-${i}`,
      isMessaging(i) ? "message" : "read",
    );
  }
  return db;
}

/** One reviewed, checked task per recorded run (including the ones that must be excluded). */
function replayTasks(): CorpusTask[] {
  return Array.from({ length: N_EXECUTIONS }, (_, i) => ({
    id: `task-${i}`,
    prompt: `TASK-${i}: compute it. Reply with exactly one line of the form "FINAL: <answer>".`,
    checker: { kind: "final" as const, value: "42" },
    sourceRunId: `run-${i}`,
  }));
}

function expectedReplayable(): number[] {
  const out: number[] = [];
  for (let i = N_EXECUTIONS - 1; i >= 0; i--) {
    if (isHeldOut(`exec-${i}`) && !isMessaging(i) && !hasNoRun(i)) out.push(i);
  }
  return out;
}

function fragmentPolicy(id: string): HarnessPolicy {
  return {
    ...defaultHarnessPolicy(),
    prompt: { fragments: [{ id, text: `instruction ${id}`, order: 0 }] },
  };
}

const proposeFragment = (id: string) => async () =>
  JSON.stringify([
    {
      policy: fragmentPolicy(id),
      targetedMechanism: "skill:tool_not_found",
      rationale: `add ${id}`,
    },
  ]);

/** Scripted trial executor: reads the policy bound to the trial workspace, like the runner. */
function scripted(passes: (fragmentIds: string[]) => boolean): {
  agentTurn: AgentTurnFn;
  prompts: string[];
} {
  const prompts: string[] = [];
  const agentTurn: AgentTurnFn = async (prompt, opts) => {
    prompts.push(prompt);
    const policy = resolveTrialHarnessPolicy({
      workspaceDir: opts?.workspaceDir,
      sessionKey: "agent:main:skill-evolve-val-test",
    });
    const ids = (policy?.prompt.fragments ?? []).map((f) => f.id);
    return { text: passes(ids) ? "FINAL: 42" : "FINAL: 0", runId: `r${prompts.length}` };
  };
  return { agentTurn, prompts };
}

describe("runHarnessEvolve replay evaluation (PLAN-64 Phase 6)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "harness-evolve-replay-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("promotes a candidate that wins on real replay and records the trials", async () => {
    const db = seedReplayDb();
    const { agentTurn, prompts } = scripted((ids) => ids.includes("fix"));
    const ledger = new HarnessReplayLedger(db);
    const res = await runHarnessEvolve({
      db,
      cycleId: "cycle-replay",
      baseline: defaultHarnessPolicy(),
      llmCall: proposeFragment("fix"),
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 1,
      evaluation: "replay",
      replay: { agentTurn, tasks: replayTasks(), ledger },
      bootstrapIterations: 500,
    });
    expect(res.promotedVersion).not.toBeNull();
    expect(readLivePolicy({ configDir: dir })?.prompt.fragments[0]?.id).toBe("fix");

    // Default: 10 pairs per comparison, both arms each.
    const replayable = expectedReplayable();
    expect(replayable.length).toBeGreaterThanOrEqual(10);
    expect(prompts).toHaveLength(20);
    const ran = new Set(prompts.map((p) => Number(/^TASK-(\d+):/.exec(p)?.[1])));
    expect([...ran].toSorted((a, b) => a - b)).toEqual(
      replayable.slice(0, 10).toSorted((a, b) => a - b),
    );
    // Excluded executions (messaging tool, no run id, not held out) never ran.
    for (const i of ran) {
      expect(isMessaging(i) || hasNoRun(i)).toBe(false);
      expect(isHeldOut(`exec-${i}`)).toBe(true);
    }

    const promote = (await readHarnessPolicyProvenance(100, { configDir: dir })).filter(
      (r) => r.event === "promote",
    );
    expect(promote).toHaveLength(1);
    expect(promote[0]).toMatchObject({
      version: res.promotedVersion,
      evaluation: "replay",
      nExecuted: 10,
      nPaired: 10,
    });
    expect(promote[0]!.trialIds).toHaveLength(20);
    expect(promote[0]!.trialIds!.toSorted()).toEqual(
      ledger
        .trials("cycle-replay")
        .map((t) => t.id)
        .toSorted(),
    );
    expect(promote[0]!.heldOutIds).toEqual(replayable.slice(0, 24).map((i) => `exec-${i}`));
    expect(res.insights[0]!.content).toContain("real replay");
    expect(res.insights[0]!.content).toContain("10 paired trials executed");
  });

  it("rejects a candidate that regresses on replay", async () => {
    const db = seedReplayDb();
    const { agentTurn, prompts } = scripted((ids) => !ids.includes("bad"));
    const res = await runHarnessEvolve({
      db,
      cycleId: "c",
      baseline: defaultHarnessPolicy(),
      llmCall: proposeFragment("bad"),
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 1,
      replay: { agentTurn, tasks: replayTasks() }, // evaluation defaults to replay
      bootstrapIterations: 500,
    });
    expect(res.promotedVersion).toBeNull();
    expect(readLivePolicy({ configDir: dir })).toBeNull();
    expect(prompts).toHaveLength(20);
    const rejects = (await readHarnessPolicyProvenance(100, { configDir: dir })).filter(
      (r) => r.event === "reject",
    );
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({
      reason: "no-improvement",
      evaluation: "replay",
      nExecuted: 10,
      delta: -1,
    });
  });

  it("cannot promote below the minimum replayable sample and says why", async () => {
    const db = seedReplayDb();
    const { agentTurn, prompts } = scripted(() => true);
    let llmCalls = 0;
    const replayable = expectedReplayable();
    // Only three of the held-out executions have a reviewed task.
    const tasks = replayTasks().filter((t) =>
      replayable.slice(0, 3).some((i) => t.sourceRunId === `run-${i}`),
    );
    const res = await runHarnessEvolve({
      db,
      cycleId: "c",
      baseline: defaultHarnessPolicy(),
      llmCall: async () => {
        llmCalls += 1;
        return proposeFragment("fix")();
      },
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 10, // a slow-update cycle: that must not run either
      evaluation: "replay",
      replay: { agentTurn, tasks },
    });
    expect(res.promotedVersion).toBeNull();
    expect(res.rolledBackTo).toBeNull();
    expect(prompts).toHaveLength(0);
    expect(llmCalls).toBe(0); // no proposer spend on a gate that cannot pass
    expect(readLivePolicy({ configDir: dir })).toBeNull();
    expect(res.insights).toHaveLength(1);
    expect(res.insights[0]!.content).toMatch(/3 of \d+ held-out executions are replayable/);
    expect(res.insights[0]!.content).toContain("5 are required");
    expect(res.insights[0]!.content).toContain("no reviewed task with a checker");
    expect(res.insights[0]!.content).toContain("promoted nothing");
    expect(res.insights[0]!.content).not.toContain("\u2014");
  });

  it("refuses to promote when replay has no trial executor", async () => {
    const res = await runHarnessEvolve({
      db: seedReplayDb(),
      cycleId: "c",
      baseline: defaultHarnessPolicy(),
      llmCall: proposeFragment("fix"),
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 1,
      evaluation: "replay",
      replay: { tasks: replayTasks() },
    });
    expect(res.promotedVersion).toBeNull();
    expect(res.llmCalls).toBe(0);
    expect(res.insights[0]!.content).toContain("no trial executor");
  });

  it("does not promote on a trial budget that cannot reach the minimum, across a restart", async () => {
    const db = seedReplayDb();
    // A previous process lifetime reserved 7 of this cycle's 12 turns, then died.
    const before = new HarnessReplayLedger(db, { bootId: "before-crash" });
    before.openCycle("cycle-crash", 12);
    for (let i = 0; i < 7; i++) {
      before.reserve("cycle-crash", 12, {
        comparison: "x",
        executionId: `e${i}`,
        taskId: `t${i}`,
        arm: "baseline",
        policyHash: "h",
      });
    }
    const { agentTurn, prompts } = scripted((ids) => ids.includes("fix"));
    const ledger = new HarnessReplayLedger(db, { bootId: "after-restart" });
    const res = await runHarnessEvolve({
      db,
      cycleId: "cycle-crash",
      baseline: defaultHarnessPolicy(),
      llmCall: proposeFragment("fix"),
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 1,
      evaluation: "replay",
      replay: { agentTurn, tasks: replayTasks(), ledger, maxTrialTurns: 12 },
    });
    // 5 turns left afford 2 pairs: below the minimum, so nothing is dispatched.
    expect(prompts).toHaveLength(0);
    expect(res.promotedVersion).toBeNull();
    expect(ledger.reserved("cycle-crash")).toBe(7);
    expect(ledger.trials("cycle-crash").every((t) => t.state === "interrupted")).toBe(true);
    const rejects = (await readHarnessPolicyProvenance(100, { configDir: dir })).filter(
      (r) => r.event === "reject",
    );
    expect(rejects[0]).toMatchObject({
      reason: "insufficient-data (agent_turns-budget)",
      evaluation: "replay",
      nExecuted: 0,
    });
    expect(res.insights.at(-1)!.content).toContain("stopped early (agent_turns-budget)");
  });

  it("auto-rollback via slow-update uses replay, before any proposal", async () => {
    const db = seedReplayDb();
    // History: v1 (good) archived, live = a later policy that regresses.
    await promotePolicy(fragmentPolicy("good"), { reason: "seed" }, { configDir: dir });
    await promotePolicy(fragmentPolicy("bad"), { reason: "seed" }, { configDir: dir });
    expect(readLivePolicy({ configDir: dir })?.prompt.fragments[0]?.id).toBe("bad");

    const { agentTurn, prompts } = scripted((ids) => !ids.includes("bad"));
    let llmCalls = 0;
    const ledger = new HarnessReplayLedger(db);
    const res = await runHarnessEvolve({
      db,
      cycleId: "cycle-slow",
      baseline: defaultHarnessPolicy(),
      llmCall: async () => {
        llmCalls += 1;
        return proposeFragment("fix")();
      },
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 10,
      evaluation: "replay",
      replay: { agentTurn, tasks: replayTasks(), ledger },
      bootstrapIterations: 500,
    });
    expect(res.rolledBackTo).toBe(1);
    expect(readLivePolicy({ configDir: dir })?.prompt.fragments[0]?.id).toBe("good");
    expect(prompts).toHaveLength(20); // 10 pairs, archived vs live, really executed
    expect(llmCalls).toBe(0); // the rollback is the cycle's one mutation
    expect(res.promotedVersion).toBeNull();

    const rollback = (await readHarnessPolicyProvenance(100, { configDir: dir })).filter(
      (r) => r.event === "rollback",
    );
    expect(rollback).toHaveLength(1);
    expect(rollback[0]).toMatchObject({ version: 1, evaluation: "replay", nExecuted: 10 });
    expect(rollback[0]!.reason).toContain("[evaluation=replay]");
    expect(rollback[0]!.trialIds).toHaveLength(20);
    expect(res.insights[0]!.content).toContain("measured by real replay");
  });

  it("labels the predicted judge as a prediction everywhere it is reported", async () => {
    const db = seedReplayDb();
    const { agentTurn, prompts } = scripted(() => true);
    // One model plays proposer and judge; the judge predicts a win on every row.
    const llmCall = async (prompt: string) => {
      if (!prompt.includes("Past execution contexts")) return proposeFragment("fix")();
      const n = (prompt.match(/^\[\d+\]/gm) ?? []).length;
      return JSON.stringify({
        trials: Array.from({ length: n }, (_, i) => ({
          index: i + 1,
          originalPassed: false,
          mutatedPassed: true,
        })),
      });
    };
    const res = await runHarnessEvolve({
      db,
      cycleId: "c",
      baseline: defaultHarnessPolicy(),
      llmCall,
      nowMs: 5000,
      configDir: dir,
      cycleIndex: 1,
      evaluation: "predicted",
      replay: { agentTurn, tasks: replayTasks() },
      bootstrapIterations: 500,
    });
    expect(res.promotedVersion).not.toBeNull();
    expect(prompts).toHaveLength(0); // nothing is executed in predicted mode
    const promote = (await readHarnessPolicyProvenance(100, { configDir: dir })).filter(
      (r) => r.event === "promote",
    );
    expect(promote[0]).toMatchObject({ evaluation: "predicted", nExecuted: 0, trialIds: [] });
    expect(res.insights[0]!.content).toContain("PREDICTION");
    expect(res.insights[0]!.content).toContain("nothing was executed");
    expect(res.insights[0]!.content).toContain("predicted \u0394=");
  });
});
