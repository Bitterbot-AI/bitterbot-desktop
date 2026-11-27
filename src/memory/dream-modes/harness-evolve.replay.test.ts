import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTrialHarnessPolicy } from "../../agents/embedded-runner/harness-policy-trial.js";
import {
  defaultHarnessPolicy,
  type HarnessPolicy,
  serializePolicyForJudge,
} from "../../agents/embedded-runner/harness-policy.js";
import { LearningDispatchStopped } from "../learning-dispatch-stopped.js";
import type { CorpusTask } from "../skill-evolution/task-corpus.js";
import type { AgentTurnFn } from "../skill-evolution/task-runner.js";
import type { HeldOutExecution } from "../skill-execution-selection.js";
import { HarnessReplayLedger } from "./harness-evolve.replay-ledger.js";
import {
  createPredictedEvaluator,
  createReplayEvaluator,
  type ReplayableExecution,
  selectReplayableExecutions,
  summarizeExclusions,
} from "./harness-evolve.replay.js";

const VALIDATION_SESSION = "agent:main:skill-evolve-val-test";

function exec(id: string, over: Partial<HeldOutExecution> = {}): HeldOutExecution {
  return {
    id,
    skillId: "sk",
    sessionId: "s",
    completedAt: 1,
    success: false,
    rewardScore: null,
    errorType: null,
    contextJson: "{}",
    runId: `run-${id}`,
    toolName: "read",
    ...over,
  };
}

function task(id: string, over: Partial<CorpusTask> = {}): CorpusTask {
  return {
    id: `task-${id}`,
    prompt: `Compute the answer for ${id}. Reply with exactly one line of the form "FINAL: <answer>".`,
    checker: { kind: "final", value: "42" },
    sourceRunId: `run-${id}`,
    ...over,
  };
}

function withFragment(id: string): HarnessPolicy {
  const p = defaultHarnessPolicy();
  p.prompt.fragments.push({ id, text: `fragment ${id}`, order: 0 });
  return p;
}

interface Call {
  prompt: string;
  fragmentIds: string[];
  workspaceDir: string;
}

/**
 * Scripted executor. It reads the policy the SAME way the embedded runner
 * does (the trial registry, keyed by the scratch workspace, validation
 * sessions only) and answers correctly iff `passes(policy)`.
 */
function scriptedTurn(passes: (fragmentIds: string[]) => boolean): {
  turn: AgentTurnFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const turn: AgentTurnFn = async (prompt, opts) => {
    const workspaceDir = opts?.workspaceDir ?? "";
    const policy = resolveTrialHarnessPolicy({ workspaceDir, sessionKey: VALIDATION_SESSION });
    const fragmentIds = (policy?.prompt.fragments ?? []).map((f) => f.id);
    calls.push({ prompt, fragmentIds, workspaceDir });
    return {
      text: passes(fragmentIds) ? "FINAL: 42" : "FINAL: 7",
      runId: `trial-run-${calls.length}`,
    };
  };
  return { turn, calls };
}

function resolver(...policies: HarnessPolicy[]): (text: string) => HarnessPolicy | undefined {
  const map = new Map(policies.map((p) => [serializePolicyForJudge(p), p]));
  return (text) => map.get(text);
}

function replayableSet(n: number): ReplayableExecution[] {
  return Array.from({ length: n }, (_, i) => ({ execution: exec(`e${i}`), task: task(`e${i}`) }));
}

describe("selectReplayableExecutions (PLAN-64 Phase 6 eligibility)", () => {
  it("keeps only executions with a run, a scratch-runner tool and a hermetic checked task", () => {
    const executions = [
      exec("ok"),
      exec("norun", { runId: null }),
      exec("notool", { toolName: null }),
      exec("msg", { toolName: "message" }),
      exec("wallet", { toolName: "wallet" }),
      exec("browser", { toolName: "browser" }),
      exec("notask"),
      exec("net"),
      exec("abs"),
      exec("dup", { runId: "run-ok" }),
    ];
    const tasks = [
      task("ok"),
      task("msg"),
      task("wallet"),
      task("browser"),
      task("net", { prompt: "Run curl https://example.com and reply FINAL: <answer>" }),
      task("abs", { prompt: "Read /home/user/secret.txt and reply FINAL: <answer>" }),
      // No sourceRunId: a task that was not drafted from any recorded run.
      task("orphan", { sourceRunId: undefined }),
    ];
    const res = selectReplayableExecutions({ executions, tasks });
    expect(res.replayable.map((r) => r.execution.id)).toEqual(["ok"]);
    expect(Object.fromEntries(res.excluded.map((e) => [e.id, e.reason]))).toEqual({
      norun: "no-run-id",
      notool: "unknown-tool",
      msg: "tool-outside-scratch-runner",
      wallet: "tool-outside-scratch-runner",
      browser: "tool-outside-scratch-runner",
      notask: "no-verifier",
      net: "not-hermetic",
      abs: "not-hermetic",
      dup: "duplicate-task",
    });
    expect(summarizeExclusions(res.excluded)).toContain(
      "3 tool not available in the scratch runner",
    );
  });

  it("honours the scratch runner's allow-list when exec is granted", () => {
    const executions = [exec("sh", { toolName: "exec" })];
    const tasks = [task("sh")];
    expect(selectReplayableExecutions({ executions, tasks }).replayable).toHaveLength(0);
    expect(
      selectReplayableExecutions({ executions, tasks, allowedTools: ["read", "exec"] }).replayable,
    ).toHaveLength(1);
  });
});

describe("HarnessReplayLedger (durable trial-turn reservation)", () => {
  const trial = (n: number) => ({
    comparison: "c",
    executionId: `e${n}`,
    taskId: `t${n}`,
    arm: "baseline" as const,
    policyHash: "h",
  });

  it("refuses a reservation past the ceiling and commits nothing for it", () => {
    const db = new DatabaseSync(":memory:");
    const ledger = new HarnessReplayLedger(db);
    ledger.openCycle("c1", 3);
    for (let i = 0; i < 3; i++) ledger.reserve("c1", 3, trial(i));
    expect(() => ledger.reserve("c1", 3, trial(3))).toThrow(LearningDispatchStopped);
    expect(ledger.reserved("c1")).toBe(3);
    expect(ledger.trials("c1")).toHaveLength(3);
    expect(ledger.remaining("c1", 3)).toBe(0);
  });

  it("keeps reserved turns across a simulated crash: no double spend on restart", () => {
    const db = new DatabaseSync(":memory:");
    const before = new HarnessReplayLedger(db, { bootId: "boot-a" });
    before.openCycle("c1", 4);
    const done = before.reserve("c1", 4, trial(0));
    before.settle(done, "passed", "run-0");
    before.reserve("c1", 4, trial(1)); // dispatched, never settled: the process died
    before.reserve("c1", 4, trial(2));

    // Restart: a new process lifetime reopens the same cycle on the same store.
    const after = new HarnessReplayLedger(db, { bootId: "boot-b" });
    after.openCycle("c1", 4);
    expect(after.reserved("c1")).toBe(3);
    expect(after.remaining("c1", 4)).toBe(1);
    expect(after.trials("c1").map((t) => t.state)).toEqual([
      "passed",
      "interrupted",
      "interrupted",
    ]);
    after.reserve("c1", 4, trial(3));
    expect(() => after.reserve("c1", 4, trial(4))).toThrow(LearningDispatchStopped);
    // Raising the configured ceiling after the fact does not refund the cycle.
    expect(after.remaining("c1", 400)).toBe(0);
  });
});

describe("createReplayEvaluator (real-execution ScorePairFn)", () => {
  let dir: string;
  let db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "harness-replay-"));
    db = new DatabaseSync(":memory:");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function build(opts: {
    replayable: ReplayableExecution[];
    turn: AgentTurnFn;
    policies: HarnessPolicy[];
    maxTrialTurns?: number;
    random?: () => number;
    canDispatch?: () => boolean;
    ledger?: HarnessReplayLedger;
  }) {
    const ledger = opts.ledger ?? new HarnessReplayLedger(db);
    const maxTrialTurns = opts.maxTrialTurns ?? 40;
    ledger.openCycle("cycle", maxTrialTurns);
    const evaluator = createReplayEvaluator({
      cycleId: "cycle",
      ledger,
      maxTrialTurns,
      replayable: opts.replayable,
      resolvePolicy: resolver(...opts.policies),
      agentTurn: opts.turn,
      random: opts.random,
      canDispatch: opts.canDispatch,
      storeOpts: { configDir: dir },
    });
    return { evaluator, ledger };
  }

  it("runs both arms for every replayable execution, each under its own policy", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const { turn, calls } = scriptedTurn((ids) => ids.includes("fix"));
    const replayable = replayableSet(6);
    const { evaluator, ledger } = build({ replayable, turn, policies: [base, cand] });

    const out = await evaluator.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(cand),
      replayable.map((r) => r.execution),
    );
    expect(out).toHaveLength(6);
    expect(out.every((p) => !p.aPassed && p.bPassed)).toBe(true);
    expect(out.map((p) => p.taskId)).toEqual(replayable.map((r) => r.execution.id));

    // Two real turns per execution: one saw no fragment, one saw the candidate's.
    expect(calls).toHaveLength(12);
    for (const r of replayable) {
      const mine = calls.filter((c) => c.prompt === r.task.prompt);
      expect(mine.map((c) => c.fragmentIds.join()).toSorted()).toEqual(["", "fix"]);
    }
    // Each trial ran in its own scratch workspace, removed afterwards, and
    // the policy binding does not outlive the trial.
    expect(new Set(calls.map((c) => c.workspaceDir)).size).toBe(12);
    for (const c of calls) {
      expect(c.workspaceDir.startsWith(dir)).toBe(true);
      expect(existsSync(c.workspaceDir)).toBe(false);
      expect(
        resolveTrialHarnessPolicy({ workspaceDir: c.workspaceDir, sessionKey: VALIDATION_SESSION }),
      ).toBeNull();
    }

    const receipt = evaluator.takeReceipt();
    expect(receipt).toMatchObject({ evaluation: "replay", nExecuted: 6, nErrored: 0 });
    expect(receipt?.trialIds).toHaveLength(12);
    expect(receipt?.stopped).toBeUndefined();
    const rows = ledger.trials("cycle");
    expect(rows.map((r) => r.id).toSorted()).toEqual([...(receipt?.trialIds ?? [])].toSorted());
    expect(rows.filter((r) => r.arm === "candidate").every((r) => r.state === "passed")).toBe(true);
    expect(rows.filter((r) => r.arm === "baseline").every((r) => r.state === "failed")).toBe(true);
    expect(rows.every((r) => r.run_id?.startsWith("trial-run-"))).toBe(true);
    expect(evaluator.takeReceipt()).toBeNull();
  });

  it("randomises arm order per task with the injected random", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const { turn, calls } = scriptedTurn(() => true);
    const replayable = replayableSet(6);
    const draws = [0.1, 0.9, 0.9, 0.1, 0.4, 0.6];
    let i = 0;
    const { evaluator } = build({
      replayable,
      turn,
      policies: [base, cand],
      random: () => draws[i++ % draws.length]!,
    });
    await evaluator.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(cand),
      replayable.map((r) => r.execution),
    );
    // First call of each pair: candidate when the draw is below 0.5.
    const firstArms = replayable.map((r) => {
      const first = calls.find((c) => c.prompt === r.task.prompt)!;
      return first.fragmentIds.includes("fix") ? "candidate" : "baseline";
    });
    expect(firstArms).toEqual([
      "candidate",
      "baseline",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]);
  });

  it("never runs an execution that is not in the eligible set", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const { turn, calls } = scriptedTurn(() => true);
    const replayable = replayableSet(5);
    const { evaluator } = build({ replayable, turn, policies: [base, cand] });
    const out = await evaluator.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(cand),
      [...replayable.map((r) => r.execution), exec("excluded-1"), exec("excluded-2")],
    );
    expect(out.map((p) => p.taskId)).toEqual(replayable.map((r) => r.execution.id));
    expect(calls.some((c) => c.prompt.includes("excluded"))).toBe(false);
  });

  it("runs nothing when fewer than the minimum are replayable or affordable", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const { turn, calls } = scriptedTurn(() => true);
    const few = replayableSet(4);
    const a = build({ replayable: few, turn, policies: [base, cand] });
    expect(
      await a.evaluator.scorePair(
        serializePolicyForJudge(base),
        serializePolicyForJudge(cand),
        few.map((r) => r.execution),
      ),
    ).toEqual([]);
    expect(a.evaluator.takeReceipt()).toMatchObject({
      nExecuted: 0,
      stopped: "insufficient-replayable",
    });

    const many = replayableSet(8);
    const b = build({
      replayable: many,
      turn,
      policies: [base, cand],
      maxTrialTurns: 8, // affords 4 pairs: below the minimum of 5
      ledger: new HarnessReplayLedger(new DatabaseSync(":memory:")),
    });
    expect(
      await b.evaluator.scorePair(
        serializePolicyForJudge(base),
        serializePolicyForJudge(cand),
        many.map((r) => r.execution),
      ),
    ).toEqual([]);
    expect(b.evaluator.takeReceipt()).toMatchObject({
      nExecuted: 0,
      stopped: "agent_turns-budget",
    });
    expect(calls).toHaveLength(0);
  });

  it("honours the trial-turn ceiling across comparisons", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const other = withFragment("other");
    const { turn, calls } = scriptedTurn(() => true);
    const replayable = replayableSet(8);
    const { evaluator, ledger } = build({
      replayable,
      turn,
      policies: [base, cand, other],
      maxTrialTurns: 12,
    });
    const sel = replayable.map((r) => r.execution);
    const first = await evaluator.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(cand),
      sel,
    );
    // 12 turns afford 6 pairs.
    expect(first).toHaveLength(6);
    expect(calls).toHaveLength(12);
    const second = await evaluator.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(other),
      sel,
    );
    expect(second).toEqual([]);
    expect(evaluator.takeReceipt()?.stopped).toBe("agent_turns-budget");
    expect(calls).toHaveLength(12);
    expect(ledger.reserved("cycle")).toBe(12);
  });

  it("drops a pair when an arm errors and stops on an operational hold", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const replayable = replayableSet(7);
    let n = 0;
    const turn: AgentTurnFn = async (prompt) => {
      n += 1;
      if (prompt.includes("e1.")) throw new Error("gateway timeout");
      if (prompt.includes("e6.")) throw new LearningDispatchStopped("paused");
      return "FINAL: 42";
    };
    const { evaluator, ledger } = build({ replayable, turn, policies: [base, cand] });
    const out = await evaluator.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(cand),
      replayable.map((r) => r.execution),
    );
    // e1 errored (dropped, second arm not spent); e6 held (comparison ends).
    expect(out.map((p) => p.taskId)).toEqual(["e0", "e2", "e3", "e4", "e5"]);
    expect(evaluator.takeReceipt()).toMatchObject({
      nExecuted: 5,
      nErrored: 1,
      stopped: "paused",
    });
    const states = ledger.trials("cycle").map((t) => t.state);
    expect(states.filter((s) => s === "error")).toHaveLength(1);
    expect(states.filter((s) => s === "held")).toHaveLength(1);
    expect(states.filter((s) => s === "reserved")).toHaveLength(0);
    // Errored and held turns were still reserved: interruption is not a free call.
    expect(ledger.reserved("cycle")).toBe(n);
  });

  it("stops dispatching when the lane is paused", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const { turn, calls } = scriptedTurn(() => true);
    const replayable = replayableSet(6);
    let allowed = 2;
    const { evaluator } = build({
      replayable,
      turn,
      policies: [base, cand],
      canDispatch: () => allowed-- > 0,
    });
    const out = await evaluator.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(cand),
      replayable.map((r) => r.execution),
    );
    expect(out).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(evaluator.takeReceipt()?.stopped).toBe("paused");
  });

  it("stops when the executor keeps failing or the wall budget is spent", async () => {
    const base = defaultHarnessPolicy();
    const cand = withFragment("fix");
    const replayable = replayableSet(8);
    let n = 0;
    const down = build({
      replayable,
      turn: async () => {
        n += 1;
        throw new Error("gateway unreachable");
      },
      policies: [base, cand],
    });
    const sel = replayable.map((r) => r.execution);
    expect(
      await down.evaluator.scorePair(
        serializePolicyForJudge(base),
        serializePolicyForJudge(cand),
        sel,
      ),
    ).toEqual([]);
    expect(down.evaluator.takeReceipt()).toMatchObject({
      nExecuted: 0,
      nErrored: 3,
      stopped: "executor-failing",
    });
    expect(n).toBe(3); // three turns, not sixteen

    const { turn, calls } = scriptedTurn(() => true);
    let clock = 0;
    const ledger = new HarnessReplayLedger(new DatabaseSync(":memory:"));
    ledger.openCycle("cycle", 40);
    const timed = createReplayEvaluator({
      cycleId: "cycle",
      ledger,
      maxTrialTurns: 40,
      replayable,
      resolvePolicy: resolver(base, cand),
      agentTurn: async (prompt, opts) => {
        clock += 60_000;
        return turn(prompt, opts);
      },
      storeOpts: { configDir: dir },
      maxWallMs: 5 * 60_000,
      now: () => clock,
    });
    const out = await timed.scorePair(
      serializePolicyForJudge(base),
      serializePolicyForJudge(cand),
      sel,
    );
    expect(out).toHaveLength(3); // 6 one-minute turns cross the 5-minute ceiling
    expect(calls).toHaveLength(6);
    expect(timed.takeReceipt()?.stopped).toBe("wall-budget");
  });

  it("refuses to guess a policy it was not given", async () => {
    const base = defaultHarnessPolicy();
    const { turn, calls } = scriptedTurn(() => true);
    const replayable = replayableSet(6);
    const { evaluator } = build({ replayable, turn, policies: [base] });
    const out = await evaluator.scorePair(
      serializePolicyForJudge(base),
      "some text that is not a known policy",
      replayable.map((r) => r.execution),
    );
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(evaluator.takeReceipt()?.stopped).toBe("unknown-policy");
  });
});

describe("createPredictedEvaluator", () => {
  it("labels its receipts as a prediction with zero executed trials", async () => {
    const evaluator = createPredictedEvaluator(async (_a, _b, sel) =>
      sel.map((e) => ({ taskId: e.id, aPassed: false, bPassed: true })),
    );
    expect(evaluator.evaluation).toBe("predicted");
    await evaluator.scorePair("a", "b", [exec("x")]);
    expect(evaluator.takeReceipt()).toEqual({
      evaluation: "predicted",
      nExecuted: 0,
      trialIds: [],
      nErrored: 0,
    });
  });
});
