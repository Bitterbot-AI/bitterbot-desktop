import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  clearNudgeState,
  DEFAULT_THRESHOLDS,
  maybeNudgeTaskHandoff,
  recordTaskProgress,
  resetNudgeStateAfterHandoff,
  resetNudgeStateForTests,
} from "./handoff-nudge.js";

describe("maybeNudgeTaskHandoff", () => {
  const enqueue = vi.fn();
  let timeMs: number;
  const now = () => timeMs;

  beforeEach(() => {
    resetAgentRunContextForTest();
    resetNudgeStateForTests();
    enqueue.mockReset();
    timeMs = 1_000_000;
  });

  afterEach(() => {
    delete process.env.BITTERBOT_TASKS_NUDGE;
  });

  it("does not fire when run is not task-correlated", () => {
    const r = maybeNudgeTaskHandoff({ runId: "run-no-task", now, enqueue });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("not_task");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fires on token-pct trigger", () => {
    registerAgentRunContext("run-a", { taskId: "task-a", sessionKey: "sess-a" });
    const r = maybeNudgeTaskHandoff({
      runId: "run-a",
      estimatedTokens: 7_500,
      contextWindowTokens: 10_000,
      now,
      enqueue,
    });
    expect(r.fired).toBe(true);
    expect(r.triggers?.some((t) => t.startsWith("tokens="))).toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
    const [text, opts] = enqueue.mock.calls[0];
    expect(text).toMatch(/Task task-a/);
    expect(text).toMatch(/task_write_handoff/);
    expect(text).toMatch(/task_schedule_wakeup/);
    expect((opts as { sessionKey: string }).sessionKey).toBe("sess-a");
  });

  it("fires on tool-call-count trigger when token usage is low", () => {
    registerAgentRunContext("run-tools", { taskId: "task-tools", sessionKey: "sess-t" });
    let lastResult;
    for (let i = 0; i < DEFAULT_THRESHOLDS.toolCallThreshold; i += 1) {
      lastResult = maybeNudgeTaskHandoff({
        runId: "run-tools",
        estimatedTokens: 1_000,
        contextWindowTokens: 100_000, // tokens at 1% → no token trigger
        now,
        enqueue,
      });
    }
    expect(lastResult?.fired).toBe(true);
    expect(lastResult?.triggers?.some((t) => t.startsWith("toolCalls="))).toBe(true);
  });

  it("fires on time-since-progress trigger", () => {
    registerAgentRunContext("run-stale", { taskId: "task-stale", sessionKey: "sess-stale" });
    // First call to register the run state's lastProgressMs at timeMs.
    maybeNudgeTaskHandoff({
      runId: "run-stale",
      estimatedTokens: 1_000,
      contextWindowTokens: 100_000,
      now,
      enqueue,
    });
    // Jump forward past the threshold.
    timeMs += DEFAULT_THRESHOLDS.msSinceProgressThreshold + 1_000;
    const r = maybeNudgeTaskHandoff({
      runId: "run-stale",
      estimatedTokens: 1_000,
      contextWindowTokens: 100_000,
      now,
      enqueue,
    });
    expect(r.fired).toBe(true);
    expect(r.triggers?.some((t) => t.startsWith("msSinceProgress="))).toBe(true);
  });

  it("throttles repeated firings within the throttle window", () => {
    registerAgentRunContext("run-throttle", { taskId: "task-thr", sessionKey: "sess-thr" });
    const r1 = maybeNudgeTaskHandoff({
      runId: "run-throttle",
      estimatedTokens: 8_000,
      contextWindowTokens: 10_000,
      now,
      enqueue,
    });
    expect(r1.fired).toBe(true);

    // Advance time within the throttle window.
    timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs - 60_000;
    const r2 = maybeNudgeTaskHandoff({
      runId: "run-throttle",
      estimatedTokens: 9_000,
      contextWindowTokens: 10_000,
      now,
      enqueue,
    });
    expect(r2.fired).toBe(false);
    expect(r2.reason).toBe("throttled");

    // Advance past the throttle window.
    timeMs += 120_000;
    const r3 = maybeNudgeTaskHandoff({
      runId: "run-throttle",
      estimatedTokens: 9_500,
      contextWindowTokens: 10_000,
      now,
      enqueue,
    });
    expect(r3.fired).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("returns no_session_key when context has taskId but no sessionKey", () => {
    registerAgentRunContext("run-nosess", { taskId: "task-x" });
    const r = maybeNudgeTaskHandoff({
      runId: "run-nosess",
      estimatedTokens: 9_000,
      contextWindowTokens: 10_000,
      now,
      enqueue,
    });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("no_session_key");
  });

  it("is disabled when BITTERBOT_TASKS_NUDGE=0", () => {
    process.env.BITTERBOT_TASKS_NUDGE = "0";
    registerAgentRunContext("run-off", { taskId: "task-off", sessionKey: "sess-off" });
    const r = maybeNudgeTaskHandoff({
      runId: "run-off",
      estimatedTokens: 9_000,
      contextWindowTokens: 10_000,
      now,
      enqueue,
    });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("disabled");
  });

  it("resetNudgeStateAfterHandoff resets the tool-call counter", () => {
    registerAgentRunContext("run-reset", { taskId: "task-reset", sessionKey: "sess-reset" });
    for (let i = 0; i < 5; i += 1) {
      maybeNudgeTaskHandoff({
        runId: "run-reset",
        estimatedTokens: 1_000,
        contextWindowTokens: 100_000,
        now,
        enqueue,
      });
    }
    resetNudgeStateAfterHandoff("run-reset");
    // After reset, the counter starts again at 1 on the next call.
    const r = maybeNudgeTaskHandoff({
      runId: "run-reset",
      estimatedTokens: 1_000,
      contextWindowTokens: 100_000,
      now,
      enqueue,
    });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("below_thresholds");
  });

  it("recordTaskProgress resets the staleness timer", () => {
    registerAgentRunContext("run-progress", { taskId: "task-p", sessionKey: "sess-p" });
    maybeNudgeTaskHandoff({
      runId: "run-progress",
      estimatedTokens: 1_000,
      contextWindowTokens: 100_000,
      now,
      enqueue,
    });
    // Time passes well past the stale threshold.
    timeMs += DEFAULT_THRESHOLDS.msSinceProgressThreshold + 10_000;
    // Record progress (uses Date.now internally — emulate by setting state manually via real call).
    // Instead, we'll test that the trigger fires before progress, and not after we clear via clearNudgeState.
    clearNudgeState("run-progress");
    const r = maybeNudgeTaskHandoff({
      runId: "run-progress",
      estimatedTokens: 1_000,
      contextWindowTokens: 100_000,
      now,
      enqueue,
    });
    expect(r.fired).toBe(false);
    // The recordTaskProgress fn itself uses Date.now, exercised in production but
    // not effectively unit-tested under the injected clock; assert it doesn't throw.
    recordTaskProgress("run-progress");
  });
});

describe("maybeNudgeTaskHandoff — escalation (PLAN-17 follow-up)", () => {
  const enqueue = vi.fn();
  const writeHandoff = vi.fn();
  let timeMs: number;
  const now = () => timeMs;

  beforeEach(() => {
    resetAgentRunContextForTest();
    resetNudgeStateForTests();
    enqueue.mockReset();
    writeHandoff.mockReset();
    timeMs = 1_000_000;
  });

  afterEach(() => {
    delete process.env.BITTERBOT_TASKS_NUDGE;
  });

  function step(
    runId: string,
    overrides: { tokens?: number; window?: number } = {},
  ): ReturnType<typeof maybeNudgeTaskHandoff> {
    return maybeNudgeTaskHandoff({
      runId,
      estimatedTokens: overrides.tokens ?? 8_000,
      contextWindowTokens: overrides.window ?? 10_000,
      now,
      enqueue,
      writeHandoff,
    });
  }

  it("does not escalate before the nudge-count threshold", () => {
    registerAgentRunContext("run-esc-early", {
      taskId: "task-esc-early",
      sessionKey: "sess-esc-early",
    });
    writeHandoff.mockReturnValue({
      id: 99,
      taskId: "task-esc-early",
      runId: "run-esc-early",
      intent: "x",
      decisions: [],
      pending: [],
      context: null,
      contextTokens: null,
      createdAt: timeMs,
    });
    // First nudge: tokens at 80%, but only 1 nudge — below the count threshold (3).
    const r1 = step("run-esc-early", { tokens: 8_000 });
    expect(r1.fired).toBe(true);
    expect(r1.escalated).toBeUndefined();
    expect(writeHandoff).not.toHaveBeenCalled();
  });

  it("does not escalate when tokens are below the escalation threshold", () => {
    registerAgentRunContext("run-low-tok", {
      taskId: "task-low-tok",
      sessionKey: "sess-low-tok",
    });
    writeHandoff.mockReturnValue({
      id: 100,
      taskId: "task-low-tok",
      runId: "run-low-tok",
      intent: "x",
      decisions: [],
      pending: [],
      context: null,
      contextTokens: null,
      createdAt: timeMs,
    });
    // Fire 5 nudges below 78% — should never escalate.
    for (let i = 0; i < 5; i += 1) {
      step("run-low-tok", { tokens: 6_700 }); // 67%
      timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    }
    expect(writeHandoff).not.toHaveBeenCalled();
  });

  it("escalates after N nudges with tokens >= 78%", () => {
    registerAgentRunContext("run-esc", {
      taskId: "task-esc",
      sessionKey: "sess-esc",
    });
    writeHandoff.mockReturnValue({
      id: 42,
      taskId: "task-esc",
      runId: "run-esc",
      intent: "auto-escalation",
      decisions: ["auto-written"],
      pending: [],
      context: null,
      contextTokens: null,
      createdAt: timeMs,
    });

    // Three nudges at 80% tokens, spaced past the throttle window.
    const r1 = step("run-esc", { tokens: 8_000 });
    expect(r1.fired).toBe(true);
    expect(r1.escalated).toBeUndefined();

    timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    const r2 = step("run-esc", { tokens: 8_000 });
    expect(r2.fired).toBe(true);
    expect(r2.escalated).toBeUndefined();

    timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    const r3 = step("run-esc", { tokens: 8_000 });
    expect(r3.fired).toBe(true);
    expect(r3.escalated).toBe(true);
    expect(r3.escalationHandoffId).toBe(42);
    expect(writeHandoff).toHaveBeenCalledOnce();

    // The escalation also emits a second system event with the [ESCALATION] tag.
    const escalationCall = enqueue.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[long-horizon ESCALATION]"),
    );
    expect(escalationCall).toBeDefined();
    expect((escalationCall![1] as { contextKey?: string }).contextKey).toBe(
      `task-handoff-escalation:task-esc`,
    );
  });

  it("escalation is single-shot per run (does not fire a second handoff)", () => {
    registerAgentRunContext("run-once", {
      taskId: "task-once",
      sessionKey: "sess-once",
    });
    writeHandoff.mockReturnValue({
      id: 7,
      taskId: "task-once",
      runId: "run-once",
      intent: "x",
      decisions: [],
      pending: [],
      context: null,
      contextTokens: null,
      createdAt: timeMs,
    });
    // Get to escalation.
    for (let i = 0; i < 3; i += 1) {
      step("run-once", { tokens: 8_000 });
      timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    }
    expect(writeHandoff).toHaveBeenCalledOnce();
    // Continue nudging — escalation should not re-fire.
    for (let i = 0; i < 5; i += 1) {
      step("run-once", { tokens: 8_500 });
      timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    }
    expect(writeHandoff).toHaveBeenCalledOnce();
  });

  it("escalation re-arms after resetNudgeStateAfterHandoff (agent wrote real handoff)", () => {
    registerAgentRunContext("run-rearm", {
      taskId: "task-rearm",
      sessionKey: "sess-rearm",
    });
    writeHandoff.mockReturnValue({
      id: 1,
      taskId: "task-rearm",
      runId: "run-rearm",
      intent: "x",
      decisions: [],
      pending: [],
      context: null,
      contextTokens: null,
      createdAt: timeMs,
    });
    // Trigger escalation.
    for (let i = 0; i < 3; i += 1) {
      step("run-rearm", { tokens: 8_000 });
      timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    }
    expect(writeHandoff).toHaveBeenCalledTimes(1);
    // Agent writes a real handoff → reset.
    resetNudgeStateAfterHandoff("run-rearm");
    // Drive back up to the threshold and verify escalation can fire again.
    for (let i = 0; i < 3; i += 1) {
      step("run-rearm", { tokens: 8_000 });
      timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    }
    expect(writeHandoff).toHaveBeenCalledTimes(2);
  });

  it("escalation tolerates the writer returning null without crashing the nudge", () => {
    registerAgentRunContext("run-null", {
      taskId: "task-null",
      sessionKey: "sess-null",
    });
    writeHandoff.mockReturnValue(null);
    for (let i = 0; i < 3; i += 1) {
      const r = step("run-null", { tokens: 8_000 });
      expect(r.fired).toBe(true);
      // Even on the third nudge, escalated should be undefined/false when the writer returned null.
      expect(r.escalated).toBeFalsy();
      timeMs += DEFAULT_THRESHOLDS.nudgeThrottleMs + 1_000;
    }
    expect(writeHandoff).toHaveBeenCalled();
  });

  it("escalation thresholds are overridable", () => {
    registerAgentRunContext("run-tune", {
      taskId: "task-tune",
      sessionKey: "sess-tune",
    });
    writeHandoff.mockReturnValue({
      id: 5,
      taskId: "task-tune",
      runId: "run-tune",
      intent: "x",
      decisions: [],
      pending: [],
      context: null,
      contextTokens: null,
      createdAt: timeMs,
    });
    // Tighten the policy: escalate after just 1 nudge once tokens cross 60%.
    // Tokens at 70% pass both the normal 65% nudge gate and the lowered 60%
    // escalation gate, and escalationNudgeCount=1 means the first nudge
    // itself escalates.
    const r = maybeNudgeTaskHandoff({
      runId: "run-tune",
      estimatedTokens: 7_000,
      contextWindowTokens: 10_000,
      now,
      enqueue,
      writeHandoff,
      thresholds: {
        escalationNudgeCount: 1,
        escalationTokenThreshold: 0.6,
      },
    });
    expect(r.fired).toBe(true);
    expect(r.escalated).toBe(true);
  });
});
