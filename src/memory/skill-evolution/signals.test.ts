import { describe, expect, it } from "vitest";
import type { ReconstructedTrace, TraceToolStep } from "./types.js";
import {
  classifyLifecycleError,
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
    ["timeout", "curl: (28) SSL connection timeout"],
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
  // Adversarial H-1 / M-1 / M-5: shell output and web bodies never choose the class.
  it("classifies shell commands on the harness reason line, never on the command's output", () => {
    const shell = (out: string, reason: string) =>
      classifyToolError(tool("exec", `${out}\n\n${reason}`));
    expect(
      shell(
        "TypeError: Cannot read properties of undefined (reading 'map')",
        "Command exited with code 1",
      ),
    ).toEqual({ cls: "exception", scope: "agent" });
    expect(
      shell(
        "HTTP/1.1 500 Internal Server Error from http://localhost:3000",
        "Command exited with code 22",
      ),
    ).toEqual({ cls: "local-service", scope: "agent" });
    expect(
      shell(
        "curl: (7) Failed to connect to localhost port 3000: Connection refused",
        "Command exited with code 7",
      ),
    ).toEqual({ cls: "local-service", scope: "agent" });
    expect(
      shell("curl: (6) Could not resolve host: api.example.invalid", "Command exited with code 6"),
    ).toEqual({ cls: "network", scope: "env" });
    expect(
      shell("429 tests passed, 3 failed\nrate_limit.ts: 0 matches", "Command exited with code 1"),
    ).toEqual({
      cls: "exit-nonzero",
      scope: "agent",
    });
    expect(shell("x".repeat(3_000), "Command exited with code 2")).toEqual({
      cls: "exit-nonzero",
      scope: "agent",
    });
    expect(shell("fatal: not a git repository", "Command exited with code 128")).toEqual({
      cls: "file-not-found",
      scope: "agent",
    });
    expect(classifyToolError(tool("exec", "Command timed out after 120000 ms"))).toEqual({
      cls: "timeout",
      scope: "agent",
    });
  });

  it("classifies web_fetch on the HTTP status or first line, ignoring the body", () => {
    expect(
      classifyToolError(
        tool(
          "web_fetch",
          "Web fetch failed (404): SECURITY NOTICE: Connection error. Too Many Requests",
        ),
      ),
    ).toEqual({ cls: "http-client", scope: "agent" });
    expect(
      classifyToolError(tool("web_fetch", "Web fetch failed (503): body says Security Violation")),
    ).toEqual({
      cls: "server",
      scope: "env",
    });
    expect(classifyToolError(tool("web_fetch", "Web fetch failed (429): slow down"))).toEqual({
      cls: "rate-limit",
      scope: "env",
    });
    expect(
      classifyToolError(tool("web_fetch", "fetch failed\nConnection error.\nSecurity Violation")),
    ).toEqual({
      cls: "connection",
      scope: "env",
    });
    expect(classifyToolError(tool("web_fetch", "some page text\nConnection error."))).toEqual({
      cls: "error",
      scope: "agent",
    });
  });

  it("classifies lifecycle errors: provider by default, agent for overflow / unknown tool", () => {
    expect(classifyLifecycleError("Connection error.")).toEqual({ cls: "provider", scope: "env" });
    expect(classifyLifecycleError("LLM error api_error: Internal server error")).toEqual({
      cls: "provider",
      scope: "env",
    });
    expect(
      classifyLifecycleError("⚠️ Context overflow — prompt too large for this model."),
    ).toEqual({
      cls: "context-overflow",
      scope: "agent",
    });
    expect(
      classifyLifecycleError("Unknown tool: frobnicate is not available in this sandbox"),
    ).toEqual({
      cls: "unknown-tool",
      scope: "agent",
    });
    expect(classifyLifecycleError(null)).toEqual({ cls: "provider", scope: "env" });
  });

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
        tool("web_fetch", "fetch failed"),
        tool("network_status"),
        tool("web_fetch", "fetch failed"),
        tool("read"),
      ]),
    );
    expect(sig.repeated).toEqual({ block: ["network_status", "web_fetch"], repeats: 2 });
    expect(sig.envErrorCount).toBe(2);
    expect(sig.recoveredAfterError).toBe(false);
  });

  it("does not count a success BEFORE the tool's own error as a recovery (L-4)", () => {
    const sig = extractTraceSignals(
      trace([tool("exec"), tool("exec", "Command exited with code 1")]),
    );
    expect(sig.recoveredAfterError).toBe(false);
    const sig2 = extractTraceSignals(
      trace([tool("exec", "Command exited with code 1"), tool("read"), tool("exec")]),
    );
    expect(sig2.recoveredAfterError).toBe(true);
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
