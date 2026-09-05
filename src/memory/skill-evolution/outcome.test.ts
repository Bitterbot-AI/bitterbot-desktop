import { describe, expect, it } from "vitest";
import type { ReconstructedTrace, TraceToolStep } from "./types.js";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import {
  computeRunOutcome,
  deriveRunOutcome,
  findTaskVerdict,
  formatRunOutcome,
} from "./outcome.js";
import { reconstructTrace } from "./traces.js";

function tool(name: string, opts: { error?: boolean; pending?: boolean } = {}): TraceToolStep {
  return {
    kind: "tool",
    name,
    args: "{}",
    result: opts.error ? "boom" : "ok",
    isError: opts.error === true,
    ...(opts.pending ? { pending: true } : {}),
  };
}

function trace(
  steps: TraceToolStep[] = [],
  overrides: Partial<ReconstructedTrace> = {},
): ReconstructedTrace {
  return {
    runId: "r",
    taskId: null,
    task: null,
    model: "anthropic/claude-x",
    sessionKey: "agent:main:main",
    startedAt: 1,
    endedAt: 2,
    steps,
    endedWithError: false,
    errorText: null,
    completedExplicitly: false,
    isComplete: true,
    toolCallCount: steps.length,
    toolErrorCount: steps.filter((s) => s.isError).length,
    toolPendingCount: steps.filter((s) => s.pending).length,
    lastSeq: 1,
    ...overrides,
  };
}

describe("computeRunOutcome (B3 evidence hierarchy)", () => {
  it("L0 for an incomplete run, L1 when tools are clean, L2 on explicit completion", () => {
    expect(computeRunOutcome(trace([], { isComplete: false })).level).toBe(0);
    expect(computeRunOutcome(trace([tool("read")])).level).toBe(1);
    expect(computeRunOutcome(trace([tool("read")], { completedExplicitly: true })).level).toBe(2);
  });

  it("a body-level tool failure keeps the run at L0 even when the agent called complete()", () => {
    const o = computeRunOutcome(
      trace([tool("exec", { error: true })], { completedExplicitly: true }),
    );
    expect(o.level).toBe(0);
    expect(o.negatives).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/1 tool call\(s\) failed/),
        expect.stringMatching(/despite failed/),
      ]),
    );
  });

  it("an approval-pending tool call blocks L1: the action never ran", () => {
    const o = computeRunOutcome(trace([tool("exec", { pending: true })]));
    expect(o.level).toBe(0);
    expect(o.negatives[0]).toMatch(/awaiting approval/);
  });

  it("a passing task verification is L3; a failed one is a negative regardless of tools", () => {
    const pass = computeRunOutcome(trace([tool("write")]), {
      taskVerdict: {
        verdict: "pass",
        level: 3,
        checksPassed: 2,
        checksTotal: 2,
        judgeModel: "m",
        runId: "r",
        ts: 5,
      },
    });
    expect(pass.level).toBe(3);
    expect(pass.evidence.at(-1)).toMatch(/2\/2 executed checks/);
    const fail = computeRunOutcome(trace([tool("write")], { completedExplicitly: true }), {
      taskVerdict: {
        verdict: "fail",
        level: 1,
        checksPassed: 0,
        checksTotal: 1,
        judgeModel: null,
        runId: "r",
        ts: 5,
      },
    });
    expect(fail.level).toBe(2);
    expect(fail.negatives).toEqual([
      expect.stringMatching(/task judge said fail \(0\/1 checks passed\)/),
    ]);
  });

  it("human feedback is L4 when confirmed and a negative when rejected", () => {
    const yes = computeRunOutcome(trace([tool("write")]), {
      feedback: { runId: "r", verdict: "confirmed", note: null, by: "operator", ts: 1 },
    });
    expect(yes.level).toBe(4);
    const no = computeRunOutcome(trace([tool("write")], { completedExplicitly: true }), {
      feedback: { runId: "r", verdict: "rejected", note: "wrong file", by: "operator", ts: 1 },
    });
    expect(no.level).toBe(2);
    expect(no.negatives[0]).toMatch(/human rejected.*wrong file/);
    expect(formatRunOutcome(no)).toMatch(/evidence-level: L2/);
  });
});

describe("deriveRunOutcome joins task verdicts and feedback from the journal", () => {
  it("finds the latest judged event for the run's task and ignores verdicts for other runs", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-t",
      sessionKey: "agent:main:main",
      steps: [{ kind: "tool", name: "write", args: { path: "out.md" }, result: "ok" }],
      completedExplicitly: true,
    });
    // Task events are journaled under `task:<id>` with taskId set (task_judge).
    const emit = (data: Record<string, unknown>) =>
      journal.append({
        runId: "task:t1",
        taskId: "t1",
        stream: "task",
        seq: 1,
        ts: Date.now(),
        data,
      });
    emit({
      phase: "judged",
      verdict: "fail",
      level: 1,
      checksPassed: 0,
      checksTotal: 1,
      runId: "run-other",
    });
    emit({
      phase: "judged",
      verdict: "pass",
      level: 3,
      checksPassed: 1,
      checksTotal: 1,
      judgeModel: "anthropic/j",
      runId: "run-t",
    });
    expect(findTaskVerdict(journal, "t1", "run-t")).toMatchObject({
      verdict: "pass",
      level: 3,
      judgeModel: "anthropic/j",
    });
    expect(findTaskVerdict(journal, "t1", "run-zzz")).toBeNull();

    const trace = (await reconstructTrace(journal, "run-t"))!;
    trace.taskId = "t1";
    const outcome = deriveRunOutcome(trace, {
      journal,
      feedback: new Map([
        ["run-t", { runId: "run-t", verdict: "confirmed" as const, note: null, by: "op", ts: 2 }],
      ]),
    });
    expect(outcome.level).toBe(4);
    expect(outcome.taskVerdict?.verdict).toBe("pass");
    expect(outcome.feedback?.verdict).toBe("confirmed");
  });

  it("reads the model identity journaled on lifecycle start", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-m",
      steps: [{ kind: "tool", name: "read", args: {}, result: "x" }],
      completedExplicitly: false,
    });
    const before = (await reconstructTrace(journal, "run-m"))!;
    expect(before.model).toBeNull();
    journal.append({
      runId: "run-m2",
      stream: "lifecycle",
      seq: 1,
      ts: Date.now(),
      data: { phase: "start", provider: "anthropic", model: "claude-test-1", thinkLevel: "low" },
    });
    journal.append({
      runId: "run-m2",
      stream: "lifecycle",
      seq: 2,
      ts: Date.now(),
      data: { phase: "end", completedExplicitly: false },
    });
    const after = (await reconstructTrace(journal, "run-m2"))!;
    expect(after.model).toBe("anthropic/claude-test-1");
  });
});
