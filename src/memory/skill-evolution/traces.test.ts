import { describe, expect, it } from "vitest";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import {
  formatTraceLog,
  listRunsSince,
  listRunsSinceDetailed,
  reconstructTrace,
  TRACE_LOG_MAX_CHARS,
} from "./traces.js";

describe("reconstructTrace", () => {
  it("rebuilds an ordered trajectory with paired tool calls and streak-deduped assistant text", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-basic",
      sessionKey: "agent:main:main",
      steps: [
        { kind: "assistant", texts: ["Let me", "Let me check the file."] },
        { kind: "tool", name: "read", args: { path: "/tmp/x" }, result: "file contents" },
        { kind: "assistant", texts: ["Done: the file says hi."] },
      ],
      completedExplicitly: true,
    });
    const trace = await reconstructTrace(journal, "run-basic");
    expect(trace).not.toBeNull();
    expect(trace?.steps.map((s) => s.kind)).toEqual(["assistant", "tool", "assistant"]);
    // Streamed assistant events collapse to the final cumulative text.
    expect(trace?.steps[0]).toMatchObject({ text: "Let me check the file." });
    expect(trace?.steps[1]).toMatchObject({ name: "read", isError: false });
    expect(trace?.completedExplicitly).toBe(true);
    expect(trace?.isComplete).toBe(true);
    expect(trace?.endedWithError).toBe(false);
    expect(trace?.toolCallCount).toBe(1);
  });

  it("flags lifecycle errors and unfinished tool calls", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-died",
      steps: [{ kind: "tool", name: "exec", args: { cmd: "sleep 999" }, noResult: true }],
      terminal: "error",
      errorText: "LLM request failed.",
    });
    const trace = await reconstructTrace(journal, "run-died");
    expect(trace?.endedWithError).toBe(true);
    expect(trace?.errorText).toContain("LLM request failed");
    const toolSteps = trace?.steps.filter((s) => s.kind === "tool") ?? [];
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]).toMatchObject({ isError: true });
    expect(trace?.toolErrorCount).toBe(1);
  });

  it("redacts secrets from tool args and results (the journal is unredacted)", async () => {
    const journal = makeFixtureJournal();
    const secret = "sk-abcdef1234567890abcdef";
    appendFixtureRun(journal, {
      runId: "run-secret",
      steps: [
        {
          kind: "tool",
          name: "exec",
          args: { cmd: `curl --api-key ${secret}` },
          result: `used key ${secret} successfully`,
        },
      ],
    });
    const trace = await reconstructTrace(journal, "run-secret");
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(secret);
    const log = formatTraceLog(trace!);
    expect(log).not.toContain(secret);
  });

  it("returns null for unknown runs", async () => {
    const journal = makeFixtureJournal();
    expect(await reconstructTrace(journal, "nope")).toBeNull();
  });
});

describe("formatTraceLog", () => {
  it("stays under the paper's 15k cap and preserves head + tail on elision", async () => {
    const journal = makeFixtureJournal();
    const bigResult = "z".repeat(3_000);
    appendFixtureRun(journal, {
      runId: "run-big",
      steps: [
        { kind: "assistant", texts: ["FIRST-BLOCK setup text"] },
        ...Array.from({ length: 20 }, (_, i) => ({
          kind: "tool" as const,
          name: `tool-${i}`,
          result: bigResult,
        })),
        { kind: "assistant", texts: ["LAST-BLOCK final answer"] },
      ],
    });
    const trace = await reconstructTrace(journal, "run-big");
    const log = formatTraceLog(trace!);
    expect(log.length).toBeLessThanOrEqual(TRACE_LOG_MAX_CHARS);
    expect(log).toContain("FIRST-BLOCK");
    expect(log).toContain("LAST-BLOCK");
    expect(log).toContain("steps elided");
  });

  it("includes the outcome header", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-hdr",
      steps: [{ kind: "tool", name: "read", result: "x" }],
      terminal: "error",
      errorText: "boom",
    });
    const log = formatTraceLog((await reconstructTrace(journal, "run-hdr"))!);
    expect(log).toContain("outcome: ERROR");
    expect(log).toContain("tools: 1 calls");
  });
});

describe("listRunsSince", () => {
  it("returns distinct runs after the cursor, oldest-first, respecting maxRuns", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, { runId: "r1", steps: [{ kind: "tool", name: "a", result: "1" }] });
    appendFixtureRun(journal, { runId: "r2", steps: [{ kind: "tool", name: "b", result: "2" }] });
    appendFixtureRun(journal, { runId: "r3", steps: [{ kind: "tool", name: "c", result: "3" }] });
    const all = await listRunsSince(journal, { sinceSeq: 0 });
    expect(all.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
    // Cursor past r1's events excludes it.
    const r1Last = all[0]!.lastSeq;
    const after = await listRunsSince(journal, { sinceSeq: r1Last });
    expect(after.map((r) => r.runId)).toEqual(["r2", "r3"]);
    const capped = await listRunsSince(journal, { sinceSeq: 0, maxRuns: 2 });
    expect(capped).toHaveLength(2);
  });
});

// PLAN-44 Phase 0 — I1: the task enters the trace.
describe("task header (user stream)", () => {
  it("renders the journaled task FIRST, with origin and channel", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-task",
      sessionKey: "agent:main:main",
      task: { text: "Summarize the README and list the open TODOs", channel: "whatsapp" },
      steps: [{ kind: "tool", name: "read", result: "..." }],
    });
    const trace = await reconstructTrace(journal, "run-task");
    expect(trace?.task).toMatchObject({
      text: "Summarize the README and list the open TODOs",
      origin: "human",
      channel: "whatsapp",
      isHeartbeat: false,
    });
    const log = formatTraceLog(trace!);
    const taskLine = log.indexOf("task: Summarize the README");
    const outcomeLine = log.indexOf("outcome:");
    expect(taskLine).toBeGreaterThan(-1);
    expect(taskLine).toBeLessThan(outcomeLine);
    expect(log).toContain("task-origin: human via whatsapp");
  });

  it("says so explicitly when a run predates the user stream", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-legacy",
      steps: [{ kind: "tool", name: "read", result: "x" }],
    });
    const trace = await reconstructTrace(journal, "run-legacy");
    expect(trace?.task).toBeNull();
    expect(formatTraceLog(trace!)).toContain("task: (not journaled");
  });

  it("redacts secrets in the task and derives a third-party origin from the session key", async () => {
    const journal = makeFixtureJournal();
    const secret = "sk-abcdef1234567890abcdef";
    appendFixtureRun(journal, {
      runId: "run-circle",
      sessionKey: "agent:main:circle:abc123",
      task: { text: `use key ${secret} to post`, isHeartbeat: true },
      steps: [{ kind: "tool", name: "exec", result: "ok" }],
    });
    const trace = await reconstructTrace(journal, "run-circle");
    expect(trace?.task?.origin).toBe("circle");
    expect(trace?.task?.isHeartbeat).toBe(true);
    expect(trace?.task?.text).not.toContain(secret);
  });
});

// PLAN-44 Phase 0 — I2 (scan half): the scan reports its horizon and the
// first event of every run it saw but cut, so callers can clamp cursors.
describe("listRunsSinceDetailed", () => {
  it("reports scan-bounded lastSeq, firstSeq, hasTerminal, and deferred runs", async () => {
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, { runId: "a", steps: [{ kind: "tool", name: "t", result: "1" }] });
    appendFixtureRun(journal, { runId: "b", steps: [{ kind: "tool", name: "t", result: "2" }] });
    appendFixtureRun(journal, {
      runId: "c",
      steps: [{ kind: "tool", name: "t", result: "3" }],
      terminal: "none",
    });
    const scan = await listRunsSinceDetailed(journal, { sinceSeq: 0, maxRuns: 2 });
    expect(scan.runs.map((r) => r.runId)).toEqual(["a", "b"]);
    expect(scan.runs[0]?.hasTerminal).toBe(true);
    expect(scan.runs[0]?.firstSeq).toBe(1);
    expect(scan.deferredMinFirstSeq).toBe(scan.runs[1]!.lastSeq + 1);
    expect(scan.horizonSeq).toBeGreaterThanOrEqual(scan.deferredMinFirstSeq!);
    const full = await listRunsSinceDetailed(journal, { sinceSeq: 0 });
    expect(full.runs.find((r) => r.runId === "c")?.hasTerminal).toBe(false);
    expect(full.deferredMinFirstSeq).toBeNull();
  });
});
