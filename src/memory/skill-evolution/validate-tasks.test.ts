/**
 * The upgraded tasks-mode gate: K trials, regression/capability suites,
 * exact sign test. Pins the behaviors the research pass mandated.
 */

import { describe, expect, it } from "vitest";
import type { CorpusTask, TaskCorpus } from "./task-corpus.js";
import { validateAgainstTasks } from "./validate-tasks.js";

function task(id: string, suite?: "regression" | "capability"): CorpusTask {
  return {
    id,
    prompt: `answer ${id}`,
    checker: { kind: "exact", value: `ok-${id}` },
    ...(suite ? { suite } : {}),
  };
}

function corpus(tasks: CorpusTask[]): TaskCorpus {
  return { tasks, version: "test-v1" };
}

/** Runner: per (task, variant) fixed pass/fail via lookup; throws when marked. */
function runner(behavior: Record<string, { incumbent: boolean; candidate: boolean }>) {
  return async (t: CorpusTask, variant: "incumbent" | "candidate") =>
    behavior[t.id]?.[variant] ? `ok-${t.id}` : "wrong";
}

describe("validateAgainstTasks (sign-test gate)", () => {
  it("promotes on 5 clean capability wins with regression suite intact", async () => {
    const tasks = [
      ...[1, 2, 3].map((i) => task(`reg-${i}`, "regression")),
      ...[1, 2, 3, 4, 5].map((i) => task(`cap-${i}`, "capability")),
    ];
    const behavior: Record<string, { incumbent: boolean; candidate: boolean }> = {};
    for (const t of tasks) {
      behavior[t.id] =
        t.suite === "regression"
          ? { incumbent: true, candidate: true }
          : { incumbent: false, candidate: true };
    }
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: runner(behavior),
      trialsPerTask: 2,
    });
    expect(verdict.reason).toBe("accepted");
    expect(verdict.wins).toBe(5);
    expect(verdict.pValue!).toBeLessThan(0.05);
    expect(verdict.trialsPerTask).toBe(2);
  });

  it("4 clean wins is NOT promotable (p=0.0625)", async () => {
    const tasks = [1, 2, 3, 4, 5].map((i) => task(`cap-${i}`, "capability"));
    const behavior: Record<string, { incumbent: boolean; candidate: boolean }> = {
      "cap-1": { incumbent: false, candidate: true },
      "cap-2": { incumbent: false, candidate: true },
      "cap-3": { incumbent: false, candidate: true },
      "cap-4": { incumbent: false, candidate: true },
      "cap-5": { incumbent: true, candidate: true },
    };
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: runner(behavior),
    });
    // Positive but underpowered (4 discordant): HOLD, not a permanent reject.
    expect(verdict.reason).toBe("insufficient-evidence");
    expect(verdict.accepted).toBe(false);
    expect(verdict.pValue).toBeCloseTo(0.0625, 3);
  });

  it("measured non-improvement (partial losses balance wins) rejects", async () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((i) => task(`cap-${i}`, "capability"));
    // cap-1..3: clean wins. cap-4..6: incumbent 2/3, candidate 1/3 — a
    // partial loss (not a collapse, so not a "new failure").
    const calls = new Map<string, number>();
    const partial = async (t: CorpusTask, variant: "incumbent" | "candidate") => {
      const idx = Number(t.id.split("-")[1]);
      if (idx <= 3) {
        return variant === "candidate" ? `ok-${t.id}` : "wrong";
      }
      const key = `${t.id}:${variant}`;
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      const passes = variant === "incumbent" ? n <= 2 : n <= 1;
      return passes ? `ok-${t.id}` : "wrong";
    };
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: partial,
      trialsPerTask: 3,
    });
    expect(verdict.regressions).toEqual([]);
    expect(verdict.wins).toBe(3);
    expect(verdict.losses).toBe(3);
    expect(verdict.reason).toBe("no-improvement");
  });

  it("fewer than 5 capability tasks can never reject on evidence: HOLD", async () => {
    const tasks = [
      ...[1, 2, 3].map((i) => task(`reg-${i}`, "regression")),
      ...[1, 2, 3].map((i) => task(`cap-${i}`, "capability")),
    ];
    const behavior: Record<string, { incumbent: boolean; candidate: boolean }> = {};
    for (const t of tasks) {
      behavior[t.id] = { incumbent: true, candidate: true };
    }
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: runner(behavior),
    });
    expect(verdict.reason).toBe("insufficient-capability-tasks");
  });

  it("a capability task the incumbent fully mastered counts as a new failure when it collapses", async () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((i) => task(`cap-${i}`, "capability"));
    const behavior: Record<string, { incumbent: boolean; candidate: boolean }> = {};
    for (let i = 1; i <= 5; i++) {
      behavior[`cap-${i}`] = { incumbent: false, candidate: true };
    }
    behavior["cap-6"] = { incumbent: true, candidate: false }; // 1.0 -> 0 collapse
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: runner(behavior),
    });
    expect(verdict.reason).toBe("regression");
    expect(verdict.regressions).toEqual(["cap-6"]);
  });

  it("suite-wide slight degradation on the regression suite is caught by the drift test", async () => {
    const tasks = [
      ...Array.from({ length: 8 }, (_, i) => task(`reg-${i}`, "regression")),
      ...[1, 2, 3, 4, 5].map((i) => task(`cap-${i}`, "capability")),
    ];
    const calls = new Map<string, number>();
    const driftRunner = async (t: CorpusTask, variant: "incumbent" | "candidate") => {
      if (t.suite === "regression") {
        if (variant === "incumbent") {
          return `ok-${t.id}`;
        }
        const n = (calls.get(t.id) ?? 0) + 1;
        calls.set(t.id, n);
        return n === 1 ? "wrong" : `ok-${t.id}`; // candidate 2/3 on EVERY regression task
      }
      return variant === "candidate" ? `ok-${t.id}` : "wrong";
    };
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: driftRunner,
      trialsPerTask: 3,
    });
    expect(verdict.regressions).toEqual(["suite-wide-drift"]);
    expect(verdict.reason).toBe("regression");
  });

  it("an apparent regression is CONFIRMED with extra trials; a transient flake is forgiven", async () => {
    const tasks = [
      task("reg-1", "regression"),
      ...[1, 2, 3, 4, 5].map((i) => task(`cap-${i}`, "capability")),
    ];
    let candidateRegCalls = 0;
    const flakyOnce = async (t: CorpusTask, variant: "incumbent" | "candidate") => {
      if (t.id === "reg-1") {
        if (variant === "incumbent") {
          return `ok-${t.id}`;
        }
        candidateRegCalls += 1;
        // Fails the first 2 of 3 trials (looks like a regression), then recovers.
        return candidateRegCalls <= 2 ? "wrong" : `ok-${t.id}`;
      }
      return variant === "candidate" ? `ok-${t.id}` : "wrong";
    };
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: flakyOnce,
      trialsPerTask: 3,
    });
    // Confirmation round ran (3 + 3 trials); 4/6 clears the threshold.
    expect(candidateRegCalls).toBe(6);
    expect(verdict.regressions).toEqual([]);
    expect(verdict.reason).toBe("accepted");
  });

  it("a regression rejects regardless of capability wins", async () => {
    const tasks = [
      task("reg-1", "regression"),
      ...[1, 2, 3, 4, 5].map((i) => task(`cap-${i}`, "capability")),
    ];
    const behavior: Record<string, { incumbent: boolean; candidate: boolean }> = {
      "reg-1": { incumbent: true, candidate: false }, // newly failing
    };
    for (let i = 1; i <= 5; i++) {
      behavior[`cap-${i}`] = { incumbent: false, candidate: true };
    }
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: runner(behavior),
    });
    expect(verdict.reason).toBe("regression");
    expect(verdict.regressions).toEqual(["reg-1"]);
    expect(verdict.accepted).toBe(false);
  });

  it("a single flaky regression trial does not reject (K=3, threshold 0.5)", async () => {
    const tasks = [
      ...[1, 2, 3, 4, 5].map((i) => task(`reg-${i}`, "regression")),
      task("cap-1", "capability"),
    ];
    let regCalls = 0;
    const flakyRunner = async (t: CorpusTask, variant: "incumbent" | "candidate") => {
      if (t.id === "reg-1" && variant === "candidate") {
        regCalls += 1;
        return regCalls === 1 ? "wrong" : `ok-${t.id}`; // fails 1 of 3 trials
      }
      if (t.id === "cap-1") {
        return variant === "candidate" ? `ok-${t.id}` : "wrong";
      }
      return `ok-${t.id}`;
    };
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: flakyRunner,
      trialsPerTask: 3,
    });
    expect(verdict.regressions).toEqual([]);
    // A lone capability task cannot carry significance: HOLD, and above all
    // NOT a regression reject.
    expect(verdict.reason).toBe("insufficient-capability-tasks");
  });

  it("holds (no-capability-tasks) when the corpus is regression-only, WITHOUT rollouts", async () => {
    const tasks = [1, 2, 3, 4, 5].map((i) => task(`reg-${i}`, "regression"));
    let calls = 0;
    const counting = async (t: CorpusTask) => {
      calls += 1;
      return `ok-${t.id}`;
    };
    const verdict = await validateAgainstTasks({ corpus: corpus(tasks), runTask: counting });
    expect(verdict.reason).toBe("no-capability-tasks");
    expect(verdict.accepted).toBe(false);
    // Decided BEFORE spending rollouts.
    expect(calls).toBe(0);
  });

  it("suite-untagged tasks default to capability", async () => {
    const tasks = [1, 2, 3, 4, 5].map((i) => task(`t-${i}`));
    const behavior: Record<string, { incumbent: boolean; candidate: boolean }> = {};
    for (const t of tasks) {
      behavior[t.id] = { incumbent: false, candidate: true };
    }
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: runner(behavior),
    });
    expect(verdict.reason).toBe("accepted");
  });
});

// PLAN-44 Phase 2 — I5: trigger precision, budget, safety.
describe("validateAgainstTasks (PLAN-44 Phase 2)", () => {
  function suite() {
    return [
      ...[1, 2, 3].map((i) => task(`reg-${i}`, "regression")),
      ...[1, 2, 3, 4, 5].map((i) => task(`cap-${i}`, "capability")),
    ];
  }
  /** Runner: candidate wins every capability task; reports reads per suite. */
  function readingRunner(reads: { capability: boolean; regression: boolean }) {
    return async (t: CorpusTask, variant: "incumbent" | "candidate") => {
      const pass = t.suite === "regression" || variant === "candidate";
      return {
        answer: pass ? `ok-${t.id}` : "wrong",
        skillRead:
          variant === "candidate"
            ? t.suite === "regression"
              ? reads.regression
              : reads.capability
            : null,
      };
    };
  }

  it("HOLDs never-triggered when the agent did not read the candidate on capability tasks", async () => {
    const verdict = await validateAgainstTasks({
      corpus: corpus(suite()),
      runTask: readingRunner({ capability: false, regression: false }),
      trialsPerTask: 1,
    });
    expect(verdict.reason).toBe("never-triggered");
    expect(verdict.candidateReadRate).toEqual({ capability: 0, regression: 0 });
  });

  it("REJECTs over-triggered when the candidate is read on unrelated regression tasks", async () => {
    const verdict = await validateAgainstTasks({
      corpus: corpus(suite()),
      runTask: readingRunner({ capability: true, regression: true }),
      trialsPerTask: 1,
    });
    expect(verdict.reason).toBe("over-triggered");
  });

  it("accepts when the candidate is read where it should be and nowhere else", async () => {
    const verdict = await validateAgainstTasks({
      corpus: corpus(suite()),
      runTask: readingRunner({ capability: true, regression: false }),
      trialsPerTask: 1,
    });
    expect(verdict.reason).toBe("accepted");
    expect(verdict.candidateReadRate).toEqual({ capability: 1, regression: 0 });
  });

  it("treats unobservable reads (string runner) as neutral", async () => {
    const verdict = await validateAgainstTasks({
      corpus: corpus(suite()),
      runTask: async (t, variant) =>
        t.suite === "regression" || variant === "candidate" ? `ok-${t.id}` : "wrong",
      trialsPerTask: 1,
    });
    expect(verdict.reason).toBe("accepted");
    expect(verdict.candidateReadRate).toEqual({ capability: null, regression: null });
  });

  it("HOLDs budget-exhausted when the deadline passes, with partial perTask", async () => {
    let calls = 0;
    const verdict = await validateAgainstTasks({
      corpus: corpus(suite()),
      runTask: async (t) => {
        calls += 1;
        return `ok-${t.id}`;
      },
      trialsPerTask: 1,
      deadlineAt: Date.now() - 1,
    });
    expect(verdict.reason).toBe("budget-exhausted");
    expect(calls).toBe(0);
    expect(verdict.perTask ?? []).toHaveLength(0);
  });

  it("a safety-tagged regression failure rejects WITHOUT a second-round re-check", async () => {
    const tasks = suite();
    tasks[0] = { ...tasks[0]!, tags: ["safety"] };
    let regRuns = 0;
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: async (t, variant) => {
        if (t.id === "reg-1") {
          regRuns += 1;
          return variant === "candidate" ? "wrong" : `ok-${t.id}`;
        }
        return t.suite === "regression" || variant === "candidate" ? `ok-${t.id}` : "wrong";
      },
      trialsPerTask: 2,
    });
    expect(verdict.reason).toBe("regression");
    expect(verdict.regressions).toEqual(["reg-1"]);
    // K=2 trials x 2 arms, no confirmation round.
    expect(regRuns).toBe(4);
  });

  it("passes the trial index in ctx and sums reported tokens per arm", async () => {
    const indices = new Set<number>();
    const verdict = await validateAgainstTasks({
      corpus: corpus(suite()),
      runTask: async (t, variant, ctx) => {
        indices.add(ctx.trialIndex);
        return {
          answer: t.suite === "regression" || variant === "candidate" ? `ok-${t.id}` : "wrong",
          usage: { input: 10, output: variant === "candidate" ? 5 : 1 },
        };
      },
      trialsPerTask: 2,
    });
    expect([...indices].toSorted((a, b) => a - b)).toEqual([0, 1]);
    expect(verdict.tokens).toEqual({ incumbent: 8 * 2 * 11, candidate: 8 * 2 * 15 });
  });
});

describe("validateAgainstTasks: budget during a regression re-check (adversarial H3)", () => {
  it("HOLDs budget-exhausted instead of rejecting on an unconfirmed flaky regression", async () => {
    const tasks = [
      ...[1, 2, 3].map((i) => task(`reg-${i}`, "regression")),
      ...[1, 2, 3, 4, 5].map((i) => task(`cap-${i}`, "capability")),
    ];
    let reg1CandidateCalls = 0;
    const verdict = await validateAgainstTasks({
      corpus: corpus(tasks),
      runTask: async (t, variant) => {
        if (t.id === "reg-1" && variant === "candidate") {
          reg1CandidateCalls += 1;
          // The apparent regression runs the clock past the deadline, so
          // its confirmation round (PLAN-45: immediate, regression-first)
          // cannot be issued.
          await new Promise((r) => setTimeout(r, 15));
          return "wrong";
        }
        return t.suite === "regression" || variant === "candidate" ? `ok-${t.id}` : "wrong";
      },
      trialsPerTask: 1,
      deadlineAt: Date.now() + 8,
    });
    expect(verdict.reason).toBe("budget-exhausted");
    expect(reg1CandidateCalls).toBe(1); // never re-checked
  });
});

describe("applyGateCalibration (PLAN-45 Phase 2.1)", () => {
  const mk = (id: string, tags: string[], suite: "regression" | "capability" = "capability") => ({
    id,
    prompt: "p",
    checker: { kind: "final" as const, value: "1" },
    tags,
    suite,
  });
  it("drops canonical capability tasks the model always or never passes, never grown or regression tasks", async () => {
    const { applyGateCalibration } = await import("./validate-tasks.js");
    const tasks = [
      mk("reg-1", ["canonical"], "regression"),
      mk("cap-easy", ["canonical", "capability"]),
      mk("cap-hard", ["canonical", "capability"]),
      mk("cap-mid", ["canonical", "capability"]),
      mk("cap-new", ["canonical", "capability"]),
      mk("grown-1", ["mined", "reviewed"]),
      mk("cap-a", ["canonical", "capability"]),
      mk("cap-b", ["canonical", "capability"]),
      mk("cap-c", ["canonical", "capability"]),
      mk("cap-d", ["canonical", "capability"]),
    ];
    const stats = new Map([
      ["reg-1", { trials: 9, passes: 9 }],
      ["cap-easy", { trials: 9, passes: 9 }],
      ["cap-hard", { trials: 9, passes: 0 }],
      ["cap-mid", { trials: 9, passes: 4 }],
      ["cap-new", { trials: 2, passes: 2 }], // too few trials to judge
      ["grown-1", { trials: 9, passes: 9 }],
      ["cap-a", { trials: 6, passes: 3 }],
      ["cap-b", { trials: 6, passes: 3 }],
      ["cap-c", { trials: 6, passes: 3 }],
      ["cap-d", { trials: 6, passes: 3 }],
    ]);
    const r = applyGateCalibration(tasks, { incumbentStats: stats });
    expect(r.dropped.map((d) => d.id).toSorted()).toEqual(["cap-easy", "cap-hard"]);
    expect(r.tasks.map((t) => t.id)).toContain("grown-1");
    expect(r.tasks.map((t) => t.id)).toContain("reg-1");
    expect(r.tasks.map((t) => t.id)).toContain("cap-new");
    expect(r.tasks).toHaveLength(8);
  });
  it("keeps at least five canonical capability tasks (closest to 0.5) when calibration would empty the suite", async () => {
    const { applyGateCalibration } = await import("./validate-tasks.js");
    const tasks = ["a", "b", "c", "d", "e", "f"].map((x) =>
      mk(`cap-${x}`, ["canonical", "capability"]),
    );
    const stats = new Map([
      ["cap-a", { trials: 10, passes: 10 }],
      ["cap-b", { trials: 10, passes: 9 }],
      ["cap-c", { trials: 10, passes: 0 }],
      ["cap-d", { trials: 10, passes: 1 }],
      ["cap-e", { trials: 10, passes: 10 }],
      ["cap-f", { trials: 10, passes: 8.5 }],
    ]);
    const r = applyGateCalibration(tasks, { incumbentStats: stats });
    expect(r.tasks).toHaveLength(5);
    expect(r.dropped).toHaveLength(1);
    expect([0, 1]).toContain(r.dropped[0]!.rate); // one of the extreme ones goes
    expect(applyGateCalibration(tasks, undefined).tasks).toHaveLength(6);
  });
});

describe("PLAN-45 Phase 2 gate semantics", () => {
  type T = { id: string; suite: "regression" | "capability"; tags?: string[] };
  const task = (id: string, suite: "regression" | "capability", tags: string[] = []) => ({
    id,
    prompt: `${id}. Reply FINAL: <answer>.`,
    checker: { kind: "final" as const, value: "PASS" },
    suite,
    tags,
  });
  const corpusOf = (tasks: ReturnType<typeof task>[]) => ({ tasks, version: "t" });
  const regression = Array.from({ length: 5 }, (_, i) =>
    task(`reg-${i}`, "regression", ["canonical"]),
  );

  it("2.7: a candidate win counts only when the skill was read in that trial", async () => {
    const { validateAgainstTasks } = await import("./validate-tasks.js");
    const capability = Array.from({ length: 6 }, (_, i) => task(`cap-${i}`, "capability"));
    // Candidate passes every capability task but never opens the skill on
    // three of them: those three are ambient capability, not the skill's.
    const runner = async (t: T, variant: string) =>
      t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false }
        : {
            answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
            skillRead: variant === "candidate" ? Number(t.id.slice(-1)) < 3 : false,
          };
    const v = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: runner,
      trialsPerTask: 1,
      sequential: false,
    });
    // Raw candidate rate 6/6, credited 3/6: three wins, no losses, and a
    // read rate of exactly 0.5 (not below the never-triggered floor).
    expect(v.wins).toBe(3);
    expect(v.candidatePassRate).toBeGreaterThan(v.incumbentPassRate!);
    expect(v.reason).toBe("insufficient-evidence");
    const allRead = async (t: T, variant: string) =>
      t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false }
        : {
            answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
            skillRead: variant === "candidate",
          };
    const v2 = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: allRead,
      trialsPerTask: 1,
      sequential: false,
    });
    expect(v2).toMatchObject({ reason: "accepted", wins: 6, losses: 0 });
    expect(v2.perTask?.find((t) => t.id === "cap-0")?.credited).toBe(1);
  });

  it("2.4: the SPRT stops the canonical remainder early after the grown tasks ran in full, in both directions", async () => {
    const { validateAgainstTasks, sprtDecision } = await import("./validate-tasks.js");
    expect(sprtDecision(6, 0).decision).toBe("accept");
    expect(sprtDecision(5, 0).decision).toBe("continue");
    expect(sprtDecision(0, 2).decision).toBe("reject");
    expect(sprtDecision(2, 4).decision).toBe("reject");
    const grown = Array.from({ length: 2 }, (_, i) => task(`grown-${i}`, "capability", ["mined"]));
    const canonical = Array.from({ length: 12 }, (_, i) =>
      task(`cap-${i}`, "capability", ["canonical", "capability"]),
    );
    const seen: string[] = [];
    const winner = async (t: T, variant: string) => {
      if (variant === "candidate" && t.suite === "capability") seen.push(t.id);
      return t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false }
        : {
            answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
            skillRead: variant === "candidate",
          };
    };
    const v = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...grown, ...canonical]),
      runTask: winner,
      trialsPerTask: 1,
    });
    expect(v.reason).toBe("accepted");
    // Grown first (always), then canonical until the SPRT accepts at 6 wins.
    expect(seen.slice(0, 2)).toEqual(["grown-0", "grown-1"]);
    expect(v.sequential).toMatchObject({ decision: "accept", stoppedEarly: true, tasksRun: 6 });
    // A losing candidate WITHOUT a collapse: early REJECT only once five
    // discordant pairs exist (M4), never on the grown tasks themselves.
    const loser = async (t: T, variant: string, ctx: { trialIndex: number }) =>
      t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false }
        : {
            answer:
              variant === "candidate"
                ? "FINAL: nope"
                : ctx.trialIndex === 0
                  ? "FINAL: PASS"
                  : "FINAL: nope",
            skillRead: variant === "candidate",
          };
    const l = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...grown, ...canonical]),
      runTask: loser,
      trialsPerTask: 2,
    });
    expect(l.reason).toBe("no-improvement");
    expect(l.sequential).toMatchObject({ decision: "reject", stoppedEarly: true, tasksRun: 5 });
  });

  it("2.7 (C1): a candidate that passes WITHOUT reading the skill is a tie, never a loss", async () => {
    const { validateAgainstTasks, pairedDelta } = await import("./validate-tasks.js");
    expect(pairedDelta({ incumbent: 1, candidate: 1, credited: 0 })).toBe(0);
    expect(pairedDelta({ incumbent: 1, candidate: 0, credited: 0 })).toBe(-1);
    expect(pairedDelta({ incumbent: 0, candidate: 1, credited: 1 })).toBe(1);
    expect(pairedDelta({ incumbent: 0, candidate: 1, credited: 0 })).toBe(0);
    const grown = Array.from({ length: 5 }, (_, i) => task(`grown-${i}`, "capability", ["mined"]));
    const canonical = Array.from({ length: 6 }, (_, i) =>
      task(`cap-${i}`, "capability", ["canonical", "capability"]),
    );
    // Both arms pass every canonical family; the candidate never opens the
    // skill there (unrelated). On the grown tasks the candidate reads and wins.
    const runner = async (t: T, variant: string) =>
      t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false }
        : t.id.startsWith("grown-")
          ? {
              answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
              skillRead: variant === "candidate",
            }
          : { answer: "FINAL: PASS", skillRead: false };
    const v = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...grown, ...canonical]),
      runTask: runner,
      trialsPerTask: 1,
    });
    expect(v).toMatchObject({ reason: "accepted", wins: 5, losses: 0 });
    expect(v.candidateReadRate?.capability).toBe(1);
  });

  it("2.4: alpha tightens the exact test; 5 clean wins pass at 0.05 but not at 0.025", async () => {
    const { validateAgainstTasks } = await import("./validate-tasks.js");
    const capability = Array.from({ length: 5 }, (_, i) => task(`cap-${i}`, "capability"));
    const winner = async (t: T, variant: string) =>
      t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false }
        : {
            answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
            skillRead: variant === "candidate",
          };
    const a = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: winner,
      trialsPerTask: 1,
      alpha: 0.05,
    });
    expect(a).toMatchObject({ reason: "accepted", alpha: 0.05 });
    const b = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: winner,
      trialsPerTask: 1,
      alpha: 0.025,
    });
    expect(b).toMatchObject({ reason: "insufficient-evidence", alpha: 0.025 }); // 5 wins, p=0.031: positive but underpowered at the spent alpha
  });

  it("2.5: an accepted candidate that costs too many tokens holds as cost-exceeded", async () => {
    const { validateAgainstTasks } = await import("./validate-tasks.js");
    const capability = Array.from({ length: 6 }, (_, i) => task(`cap-${i}`, "capability"));
    const expensive = async (t: T, variant: string) =>
      t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false, usage: { input: 100, output: 20 } }
        : {
            answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
            skillRead: variant === "candidate",
            usage:
              variant === "candidate" ? { input: 400, output: 100 } : { input: 100, output: 20 },
          };
    const v = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: expensive,
      trialsPerTask: 1,
    });
    expect(v.reason).toBe("cost-exceeded");
    expect(v.tokenDelta).toBeCloseTo(500 / 120 - 1);
    const lenient = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: expensive,
      trialsPerTask: 1,
      maxTokenDelta: 5,
    });
    expect(lenient.reason).toBe("accepted");
    expect(lenient.wallMs?.candidate).toBeGreaterThanOrEqual(0);
  });

  it("no discordant outcome at all is insufficient evidence, not a rejection", async () => {
    const { validateAgainstTasks } = await import("./validate-tasks.js");
    const capability = Array.from({ length: 6 }, (_, i) => task(`cap-${i}`, "capability"));
    const tie = async (t: T, variant: string) => ({
      answer: "FINAL: PASS",
      skillRead: t.suite === "capability" && variant === "candidate",
    });
    const v = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: tie,
      trialsPerTask: 1,
    });
    expect(v).toMatchObject({ reason: "insufficient-evidence", wins: 0, losses: 0 });
  });

  it("trigger precision is measured on the node's grown tasks when they exist, not on canonical families", async () => {
    const { validateAgainstTasks, relevantCapabilityTasks } = await import("./validate-tasks.js");
    const canonical = Array.from({ length: 10 }, (_, i) =>
      task(`cap-fam-${i}`, "capability", ["canonical", "capability"]),
    );
    const grown = Array.from({ length: 5 }, (_, i) =>
      task(`grown-${i}`, "capability", ["mined", "reviewed"]),
    );
    expect(
      relevantCapabilityTasks([...regression, ...canonical, ...grown]).map((t) => t.id),
    ).toEqual(grown.map((t) => t.id));
    expect(relevantCapabilityTasks([...regression, ...canonical])).toHaveLength(10);
    // A curl skill: read and winning on every grown task, never read on the
    // canonical families (ties there). Must not HOLD as never-triggered.
    const curl = async (t: T, variant: string) =>
      t.suite === "regression"
        ? { answer: "FINAL: x", skillRead: false }
        : t.id.startsWith("grown-")
          ? {
              answer: variant === "candidate" ? "FINAL: PASS" : "FINAL: nope",
              skillRead: variant === "candidate",
            }
          : { answer: "FINAL: nope", skillRead: false };
    const v = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...canonical, ...grown]),
      runTask: curl,
      trialsPerTask: 1,
      sequential: false,
    });
    expect(v.candidateReadRate?.capability).toBe(1);
    expect(v).toMatchObject({ reason: "accepted", wins: 5, losses: 0 });
  });

  it("a confirmed regression rejects before any capability rollout is spent", async () => {
    const { validateAgainstTasks } = await import("./validate-tasks.js");
    const capability = Array.from({ length: 6 }, (_, i) => task(`cap-${i}`, "capability"));
    let capabilityCalls = 0;
    const breaks = async (t: T, variant: string) => {
      if (t.suite === "capability") capabilityCalls += 1;
      return t.suite === "regression"
        ? {
            answer: variant === "candidate" && t.id === "reg-1" ? "FINAL: wrong" : "FINAL: PASS",
            skillRead: false,
          }
        : { answer: "FINAL: PASS", skillRead: variant === "candidate" };
    };
    const v = await validateAgainstTasks({
      corpus: corpusOf([...regression, ...capability]),
      runTask: breaks,
      trialsPerTask: 1,
    });
    expect(v.reason).toBe("regression");
    expect(v.regressions).toEqual(["reg-1"]);
    expect(capabilityCalls).toBe(0);
  });
});
