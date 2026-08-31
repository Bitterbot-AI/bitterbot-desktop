import { describe, expect, it } from "vitest";
import type { ReconstructedTrace } from "./types.js";
import { labelHeuristic, labelTrace } from "./labeler.js";

function trace(overrides: Partial<ReconstructedTrace> = {}): ReconstructedTrace {
  return {
    runId: "r",
    taskId: null,
    sessionKey: null,
    startedAt: 1,
    endedAt: 2,
    steps: [],
    endedWithError: false,
    errorText: null,
    completedExplicitly: false,
    isComplete: true,
    toolCallCount: 0,
    toolErrorCount: 0,
    lastSeq: 1,
    ...overrides,
  };
}

describe("labelHeuristic", () => {
  it("labels lifecycle errors as fail with high confidence", () => {
    const r = labelHeuristic(trace({ endedWithError: true }));
    expect(r).toMatchObject({ label: "fail", judged: false });
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("labels a failed terminal tool call as fail", () => {
    const r = labelHeuristic(
      trace({
        toolCallCount: 2,
        toolErrorCount: 1,
        steps: [
          { kind: "tool", name: "read", args: "", result: "ok", isError: false },
          { kind: "tool", name: "exec", args: "", result: "boom", isError: true },
        ],
      }),
    );
    expect(r.label).toBe("fail");
    expect(r.reason).toContain("exec");
  });

  it("labels high tool-error density as fail even when the last call succeeded", () => {
    const r = labelHeuristic(
      trace({
        toolCallCount: 4,
        toolErrorCount: 3,
        steps: [{ kind: "tool", name: "a", args: "", result: "ok", isError: false }],
      }),
    );
    expect(r.label).toBe("fail");
  });

  it("labels complete() with zero errors as pass above the judge threshold", () => {
    const r = labelHeuristic(trace({ completedExplicitly: true, toolCallCount: 3 }));
    expect(r).toMatchObject({ label: "pass" });
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("gives clean-but-unconfirmed runs a weak pass and no-signal runs unknown", () => {
    expect(labelHeuristic(trace({ toolCallCount: 2 })).label).toBe("pass");
    expect(labelHeuristic(trace({ toolCallCount: 2 })).confidence).toBeLessThan(0.7);
    expect(labelHeuristic(trace()).label).toBe("unknown");
    expect(labelHeuristic(trace({ isComplete: false })).label).toBe("unknown");
  });
});

describe("labelTrace with a judge", () => {
  it("does not call the judge when the heuristic is confident", async () => {
    let called = 0;
    const r = await labelTrace(trace({ endedWithError: true }), {
      judgeCall: async () => {
        called += 1;
        return "verdict: pass";
      },
    });
    expect(called).toBe(0);
    expect(r.label).toBe("fail");
  });

  it("lets the judge decide ambiguous traces", async () => {
    const r = await labelTrace(trace({ toolCallCount: 2 }), {
      judgeCall: async () => "verdict: fail",
    });
    expect(r).toMatchObject({ label: "fail", judged: true });
  });

  it("falls back to the heuristic on unparseable output or judge errors", async () => {
    const garbled = await labelTrace(trace({ toolCallCount: 2 }), {
      judgeCall: async () => "I think it went fine!",
    });
    expect(garbled).toMatchObject({ label: "pass", judged: false });
    const thrown = await labelTrace(trace({ toolCallCount: 2 }), {
      judgeCall: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(thrown).toMatchObject({ label: "pass", judged: false });
  });

  it("propagates a judge unknown as unknown", async () => {
    const r = await labelTrace(trace({ toolCallCount: 2 }), {
      judgeCall: async () => "verdict: unknown",
    });
    expect(r).toMatchObject({ label: "unknown", judged: true });
  });
});
