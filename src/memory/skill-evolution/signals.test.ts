import { describe, expect, it } from "vitest";
import type { ReconstructedTrace, TraceToolStep } from "./types.js";
import {
  classifyToolError,
  extractErrorText,
  extractTraceSignals,
  formatSignals,
} from "./signals.js";

/** Production tool-result envelope shape. */
function envelope(tool: string, error: string): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ status: "error", tool, error }, null, 1) }],
    details: { status: "error", tool },
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

function trace(steps: TraceToolStep[]): ReconstructedTrace {
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
  };
}

describe("extractErrorText", () => {
  it("unwraps the production envelope and falls back to raw text", () => {
    expect(extractErrorText(envelope("exec", "Command exited with code 1"))).toBe(
      "Command exited with code 1",
    );
    expect(extractErrorText("plain boom")).toBe("plain boom");
    expect(extractErrorText("(no result recorded — run ended before the tool returned)")).toContain(
      "no result recorded",
    );
  });
});

describe("classifyToolError (live journal signatures)", () => {
  const env: Array<[string, string]> = [
    ["dns", "getaddrinfo ENOTFOUND api.example.invalid"],
    ["connection", "fetch failed"],
    ["connection", "connect ECONNREFUSED 127.0.0.1:9100"],
    ["timeout", "curl: (28) SSL connection timeout\n\nCommand exited with code 28"],
    ["rate-limit", "Request failed with status 429: rate limit exceeded"],
    ["server", "Web fetch failed (503): Service Unavailable"],
    ["service-unavailable", "Can't reach the Bitterbot browser control service (timed out)"],
    ["service-unavailable", "x402 payments are not enabled. Set tools.wallet.x402.enabled: true"],
    ["service-unavailable", "X402ActionProvider is not a constructor"],
    ["aborted", "Command aborted by signal SIGTERM"],
    ["provider", "LLM error api_error: Internal server error (request_id: req_x)"],
  ];
  for (const [cls, text] of env) {
    it(`env: ${cls} <- ${text.slice(0, 40)}`, () => {
      expect(classifyToolError(tool("t", text))).toEqual({ cls, scope: "env" });
    });
  }
  const agent: Array<[string, string]> = [
    [
      "policy-block",
      "Security Violation [no-pipe-to-shell-from-net]: Command pipes network output",
    ],
    ["policy-block", "Blocked: resolves to private/internal IP address"],
    ["policy-block", "INTERCEPTOR: recall-before-claim: ground the assertion"],
    ["file-not-found", "ENOENT: no such file or directory, access '/tmp/x'"],
    ["file-not-found", "fatal: not a git repository (or any of the parent directories): .git"],
    ["edit-mismatch", "Could not find the exact text in /tmp/scratch.md"],
    ["http-client", "Web fetch failed (404): SECURITY NOTICE: The following content"],
    ["exit-nonzero", "Command exited with code 1"],
    ["exception", 'Traceback (most recent call last):\n File "<string>", line 1'],
    ["timeout", "Command timed out after 120000 ms"],
    ["error", "something odd"],
  ];
  for (const [cls, text] of agent) {
    it(`agent: ${cls} <- ${text.slice(0, 40)}`, () => {
      expect(classifyToolError(tool("t", text))).toEqual({ cls, scope: "agent" });
    });
  }
  it("unfinished tool calls (run died mid-call) are env aborts", () => {
    const step: TraceToolStep = {
      kind: "tool",
      name: "process",
      args: "",
      result: "(no result recorded — run ended before the tool returned)",
      isError: true,
    };
    expect(classifyToolError(step)).toEqual({ cls: "aborted", scope: "env" });
  });
});

describe("extractTraceSignals", () => {
  it("finds repeated loops, error positions, and recovery", () => {
    const sig = extractTraceSignals(
      trace([
        tool("read"),
        tool("exec", "Command exited with code 1"),
        tool("exec", "Command exited with code 1"),
        tool("exec", "Command exited with code 1"),
        tool("exec"),
        tool("write"),
      ]),
    );
    expect(sig.toolSequence).toEqual(["read", "exec", "exec", "exec", "exec", "write"]);
    expect(sig.repeated).toEqual({ block: ["exec"], repeats: 4 });
    expect(sig.errors.map((e) => e.cls)).toEqual(["exit-nonzero", "exit-nonzero", "exit-nonzero"]);
    expect(sig.agentErrorCount).toBe(3);
    expect(sig.envErrorCount).toBe(0);
    expect(sig.firstErrorIndex).toBe(1);
    expect(sig.stepsAfterFirstError).toBe(4);
    expect(sig.recoveredAfterError).toBe(true);
  });

  it("detects 2-block loops and reports no recovery when the tool never succeeded", () => {
    const sig = extractTraceSignals(
      trace([
        tool("network_status"),
        tool("exec", "fetch failed"),
        tool("network_status"),
        tool("exec", "fetch failed"),
        tool("read"),
      ]),
    );
    expect(sig.repeated).toEqual({ block: ["network_status", "exec"], repeats: 2 });
    expect(sig.envErrorCount).toBe(2);
    expect(sig.recoveredAfterError).toBe(false);
  });

  it("is safe on empty traces", () => {
    const sig = extractTraceSignals(trace([]));
    expect(sig.repeated).toBeNull();
    expect(sig.firstErrorIndex).toBeNull();
    expect(formatSignals(sig)).toContain("tool-sequence: (none)");
  });

  it("formats the block with env markers and step positions", () => {
    const text = formatSignals(
      extractTraceSignals(trace([tool("web_fetch", "getaddrinfo ENOTFOUND x"), tool("read")])),
    );
    expect(text).toContain("## Signals");
    expect(text).toContain("tool-sequence: web_fetch! > read");
    expect(text).toContain("error-classes: web_fetch:dns(env)");
    expect(text).toContain("first-error-at: tool step 1 of 2");
  });
});
