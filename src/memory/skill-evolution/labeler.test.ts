import { describe, expect, it } from "vitest";
import type { ReconstructedTrace, TraceToolStep } from "./types.js";
import { labelHeuristic, labelTrace, parseJudgeVerdict } from "./labeler.js";

function envelope(tool: string, error: string): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ status: "error", tool, error }, null, 1) }],
  });
}

function tool(name: string, error?: string): TraceToolStep {
  return {
    kind: "tool",
    name,
    args: "{}",
    result: error ? envelope(name, error) : "ok",
    isError: Boolean(error),
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
    lastSeq: 1,
    ...overrides,
  };
}

describe("labelHeuristic (PLAN-44 I3: environment is not the agent)", () => {
  it("labels lifecycle errors as env-fail (the LLM call itself failed)", () => {
    const r = labelHeuristic(
      trace([tool("read")], { endedWithError: true, errorText: "Connection error." }),
    );
    expect(r).toMatchObject({ label: "env-fail", judged: false });
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.reason).toContain("provider");
  });

  it("labels a terminal DNS / connection / 5xx tool failure as env-fail", () => {
    for (const err of [
      "getaddrinfo ENOTFOUND api.example.invalid",
      "fetch failed",
      "Web fetch failed (503): upstream unavailable",
      "Request failed with status 429: rate limit exceeded",
    ]) {
      const r = labelHeuristic(trace([tool("read"), tool("web_fetch", err)]));
      expect(r.label, err).toBe("env-fail");
      expect(r.reason).toContain("web_fetch");
    }
  });

  it("labels a terminal agent-side tool failure as fail", () => {
    const r = labelHeuristic(trace([tool("read"), tool("exec", "Command exited with code 1")]));
    expect(r.label).toBe("fail");
    expect(r.reason).toContain("exec:exit-nonzero");
  });

  it("uses AGENT error density, so a run peppered with outages is not an agent failure", () => {
    const agentDense = labelHeuristic(
      trace([
        tool("exec", "Command exited with code 1"),
        tool("exec", "Command exited with code 1"),
        tool("exec", "Traceback (most recent call last): boom"),
        tool("read"),
      ]),
    );
    expect(agentDense.label).toBe("fail");
    const envDense = labelHeuristic(
      trace([
        tool("web_fetch", "fetch failed"),
        tool("web_fetch", "fetch failed"),
        tool("web_fetch", "getaddrinfo ENOTFOUND x"),
        tool("read"),
      ]),
    );
    expect(envDense.label).not.toBe("fail");
  });

  it("labels a run where every call failed on the environment as env-fail", () => {
    const r = labelHeuristic(
      trace([tool("web_fetch", "fetch failed"), tool("web_fetch", "connect ECONNREFUSED 1.2.3.4")]),
    );
    expect(r.label).toBe("env-fail");
  });

  it("labels complete() with zero agent errors as pass above the judge threshold", () => {
    const r = labelHeuristic(
      trace([tool("read"), tool("exec"), tool("complete")], { completedExplicitly: true }),
    );
    expect(r).toMatchObject({ label: "pass" });
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("gives clean-but-unconfirmed runs a weak pass and no-signal runs unknown", () => {
    expect(labelHeuristic(trace([tool("read"), tool("read")])).label).toBe("pass");
    expect(labelHeuristic(trace([tool("read"), tool("read")])).confidence).toBeLessThan(0.7);
    expect(labelHeuristic(trace()).label).toBe("unknown");
    expect(labelHeuristic(trace([tool("read")], { isComplete: false })).label).toBe("unknown");
  });

  it("treats recovery from an environment error as a weak pass", () => {
    const r = labelHeuristic(
      trace([tool("web_fetch", "fetch failed"), tool("web_fetch"), tool("read")]),
    );
    expect(r.label).toBe("pass");
    expect(r.confidence).toBeLessThan(0.7);
    expect(r.reason).toContain("recovered");
  });
});

describe("parseJudgeVerdict (PLAN-44 I3: anchored)", () => {
  it("accepts a verdict line and rejects the echoed format line", () => {
    expect(parseJudgeVerdict("verdict: fail")).toBe("fail");
    expect(parseJudgeVerdict("  Verdict: PASS  ")).toBe("pass");
    expect(parseJudgeVerdict("Sure!\nverdict: unknown\n")).toBe("unknown");
    expect(parseJudgeVerdict("verdict: pass|fail|unknown")).toBeNull();
    expect(parseJudgeVerdict("the verdict: pass was hard")).toBeNull();
    expect(parseJudgeVerdict("I think it went fine!")).toBeNull();
  });
});

describe("labelTrace with a judge", () => {
  it("does not call the judge when the heuristic is confident", async () => {
    let called = 0;
    const r = await labelTrace(trace([tool("read")], { endedWithError: true }), {
      judgeCall: async () => {
        called += 1;
        return "verdict: pass";
      },
    });
    expect(called).toBe(0);
    expect(r.label).toBe("env-fail");
  });

  it("lets the judge decide ambiguous traces and shows it the signals block", async () => {
    let prompt = "";
    const r = await labelTrace(trace([tool("read"), tool("read")]), {
      judgeCall: async (p) => {
        prompt = p;
        return "verdict: fail";
      },
    });
    expect(r).toMatchObject({ label: "fail", judged: true });
    expect(prompt).toContain("## Signals");
  });

  it("falls back to the heuristic on unparseable output, the echoed format line, or judge errors", async () => {
    const garbled = await labelTrace(trace([tool("read"), tool("read")]), {
      judgeCall: async () => "I think it went fine!",
    });
    expect(garbled).toMatchObject({ label: "pass", judged: false });
    const echoed = await labelTrace(trace([tool("read"), tool("read")]), {
      judgeCall: async () => "verdict: pass|fail|unknown",
    });
    expect(echoed).toMatchObject({ label: "pass", judged: false });
    const thrown = await labelTrace(trace([tool("read"), tool("read")]), {
      judgeCall: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(thrown).toMatchObject({ label: "pass", judged: false });
  });

  it("propagates a judge unknown as unknown", async () => {
    const r = await labelTrace(trace([tool("read"), tool("read")]), {
      judgeCall: async () => "verdict: unknown",
    });
    expect(r).toMatchObject({ label: "unknown", judged: true });
  });
});
