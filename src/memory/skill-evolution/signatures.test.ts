import { describe, expect, it } from "vitest";
import type { ReconstructedTrace, TraceLabelResult, TraceToolStep } from "./types.js";
import { computeRunOutcome } from "./outcome.js";
import { extractTraceSignals } from "./signals.js";
import {
  deriveFailureSignature,
  rankFailureSignatures,
  REPEATED_CALL_BLOCK_MARKER,
} from "./signatures.js";

function envelope(error: string): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ status: "error", error }, null, 1) }],
  });
}

function tool(name: string, error?: string, extra: Partial<TraceToolStep> = {}): TraceToolStep {
  return {
    kind: "tool",
    name,
    args: "{}",
    result: error ? envelope(error) : "ok",
    isError: Boolean(error),
    ...extra,
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
    model: null,
    sessionKey: null,
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

const failLabel: TraceLabelResult = { label: "fail", confidence: 0.8, reason: "x", judged: false };

function sig(t: ReconstructedTrace, extras: Parameters<typeof computeRunOutcome>[1] = {}) {
  return deriveFailureSignature(t, extractTraceSignals(t), failLabel, computeRunOutcome(t, extras));
}

describe("deriveFailureSignature (B6)", () => {
  it("human rejection and failed verification name the mechanism directly", () => {
    const t = trace([tool("write")]);
    expect(
      sig(t, { feedback: { runId: "r", verdict: "rejected", note: null, by: "op", ts: 1 } }),
    ).toMatchObject({
      mechanism: "human-rejected",
      agentCausal: true,
      key: "human-rejected|agent|human-rejected",
    });
    expect(
      sig(t, {
        taskVerdict: {
          verdict: "fail",
          level: 1,
          checksPassed: 0,
          checksTotal: 2,
          judgeModel: null,
          runId: "r",
          ts: 1,
        },
      }),
    ).toMatchObject({ cause: "checks-failed", mechanism: "verification-failed" });
  });

  it("a run the runtime guard blocked is a repeated-unsuccessful-retry", () => {
    const t = trace([
      tool("exec", "ENOENT: no such file"),
      tool("exec", "ENOENT: no such file"),
      tool("exec", "ENOENT: no such file"),
      tool(
        "exec",
        `${REPEATED_CALL_BLOCK_MARKER}: exec was called 3 times with identical arguments`,
      ),
    ]);
    expect(sig(t)).toMatchObject({ mechanism: "repeated-unsuccessful-retry", agentCausal: true });
  });

  it("complete() over unresolved errors is premature completion; pending approval is its own mechanism", () => {
    const early = trace([tool("write", "permission denied")], { completedExplicitly: true });
    expect(sig(early)).toMatchObject({ mechanism: "premature-completion", agentCausal: true });
    const pending = trace([tool("exec", undefined, { pending: true })]);
    expect(sig(pending)).toMatchObject({ mechanism: "approval-never-granted", agentCausal: false });
  });

  it("environment errors are not agent-causal; agent errors map to a mechanism by class", () => {
    const env = trace([tool("web_fetch", "ECONNREFUSED 127.0.0.1:1")], {
      endedWithError: false,
    });
    const s = sig(env);
    expect(s.agentCausal).toBe(extractTraceSignals(env).errors.at(-1)?.scope === "agent");
    const provider = trace([], { endedWithError: true, errorText: "Connection error." });
    expect(sig(provider)).toMatchObject({
      mechanism: "environment-outage",
      agentCausal: false,
      key: "provider|env|environment-outage",
    });
  });

  it("ranks clusters across iterations by total count", () => {
    const ranked = rankFailureSignatures([
      { "a|agent|invalid-parameter": 2, "b|env|environment-outage": 1 },
      null,
      { "a|agent|invalid-parameter": 1 },
    ]);
    expect(ranked[0]).toEqual({ key: "a|agent|invalid-parameter", count: 3, iterations: 2 });
    expect(ranked[1]).toEqual({ key: "b|env|environment-outage", count: 1, iterations: 1 });
  });
});
