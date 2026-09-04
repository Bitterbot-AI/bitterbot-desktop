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
