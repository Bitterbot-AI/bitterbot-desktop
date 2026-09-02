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
