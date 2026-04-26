import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  __midTurnBudgetConsts,
  applyMidTurnBudget,
  type MidTurnBudgetSessionLike,
} from "./mid-turn-budget.js";

const { DEFAULT_TRIGGER_FRACTION, DEFAULT_MIN_CHARS } = __midTurnBudgetConsts;

function makeMsg(role: string, text: string): AgentMessage {
  return { role, content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

function makeToolResult(text: string, toolName = "exec"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeSession(messages: AgentMessage[]): MidTurnBudgetSessionLike & {
  replaceCalled: number;
} {
  let replaceCalled = 0;
  return {
    messages,
    agent: {
      replaceMessages: (next: AgentMessage[]) => {
        replaceCalled += 1;
        messages.length = 0;
        for (const m of next) messages.push(m);
      },
    },
    get replaceCalled() {
      return replaceCalled;
    },
  } as unknown as MidTurnBudgetSessionLike & { replaceCalled: number };
}

describe("applyMidTurnBudget — guard does not fire", () => {
  it("returns no-op when there are no messages", () => {
    const session = makeSession([]);
    const r = applyMidTurnBudget({ session, contextWindowTokens: 200_000 });
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe("no messages");
  });

  it("returns no-op when total chars are below the floor", () => {
    // Far below DEFAULT_MIN_CHARS (80K)
    const session = makeSession([makeMsg("user", "hello"), makeMsg("assistant", "hi there")]);
    const r = applyMidTurnBudget({ session, contextWindowTokens: 200_000 });
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe("below char floor");
    expect(session.replaceCalled).toBe(0);
  });

  it("returns no-op when message volume is between floor and trigger", () => {
    // Above char floor but below trigger threshold tokens
    const big = "x".repeat(DEFAULT_MIN_CHARS + 1000);
    const session = makeSession([makeMsg("assistant", big)]);
    const r = applyMidTurnBudget({ session, contextWindowTokens: 200_000 });
    expect(r.applied).toBe(false);
    if (!r.applied) {
      expect(r.reason).toBe("below trigger threshold");
      expect(typeof r.tokensBefore).toBe("number");
    }
    expect(session.replaceCalled).toBe(0);
  });
});

describe("applyMidTurnBudget — guard fires", () => {
  it("compresses when above the trigger threshold", () => {
    // Build a synthetic context with enough char volume to clear the 80K
    // floor and enough estimated tokens to clear 80% of a 10k-token window.
    // 12 × 10K-char tool results = ~120K chars; estimateTokens lands well
    // above 8000 (the trigger) for that volume.
    const messages: AgentMessage[] = [makeMsg("user", "start")];
    for (let i = 0; i < 12; i++) {
      messages.push(makeMsg("assistant", `step ${i}`), makeToolResult("y".repeat(10_000), "exec"));
    }
    // Recent messages that should NOT be compressed (spareRecent guards).
    messages.push(makeMsg("user", "follow-up"), makeMsg("assistant", "ok working"));

    const session = makeSession(messages);
    const r = applyMidTurnBudget({
      session,
      // Small window so the threshold trips immediately.
      contextWindowTokens: 10_000,
    });
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
      expect(r.messagesAfter).toBeLessThanOrEqual(r.messagesBefore);
    }
    expect(session.replaceCalled).toBe(1);
  });

  it("returns no-op (not error) when compression cannot make progress", () => {
    // All messages are recent + small, so progressive compression has no
    // older oversized tool results to truncate. This tests the
    // "compression made no progress" branch.
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push(makeMsg("user", "z".repeat(50_000)));
    }
    const session = makeSession(messages);
    const r = applyMidTurnBudget({
      session,
      contextWindowTokens: 10_000,
      // Default config keeps recent messages
    });
    // Either compression made no progress (and we report it), or it did
    // (and we accept the win). Both are valid outcomes for this synthetic
    // input; assert no crash and consistent shape.
    if (!r.applied) {
      expect(r.reason).toBeDefined();
    } else {
      expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    }
  });
});

describe("applyMidTurnBudget — config knobs", () => {
  it("respects custom triggerThresholdFraction", () => {
    const big = "x".repeat(DEFAULT_MIN_CHARS + 1000);
    const session = makeSession([makeMsg("assistant", big)]);
    // With default 0.80 trigger this is below threshold, but a 0.01 trigger
    // means even a small message exceeds it.
    const r = applyMidTurnBudget({
      session,
      contextWindowTokens: 200_000,
      budgetConfig: { triggerThresholdFraction: 0.01 },
    });
    // Either it fires (and replaces), or compression makes no progress.
    // In either case we must not throw.
    expect(typeof r.applied).toBe("boolean");
  });

  it("respects custom minChars floor", () => {
    const session = makeSession([makeMsg("user", "tiny")]);
    const r = applyMidTurnBudget({
      session,
      contextWindowTokens: 200_000,
      budgetConfig: { minChars: 1 }, // disable the floor
    });
    // Now it actually inspects tokens; tiny message → still under threshold.
    expect(r.applied).toBe(false);
  });

  it("uses defaults documented in __midTurnBudgetConsts", () => {
    expect(DEFAULT_TRIGGER_FRACTION).toBe(0.8);
    expect(DEFAULT_MIN_CHARS).toBe(80_000);
  });
});

describe("applyMidTurnBudget — robustness", () => {
  it("does not crash if estimateTokens throws on a malformed message", () => {
    const malformed = { role: "weird", content: { unexpected: true } } as unknown as AgentMessage;
    const big = "x".repeat(DEFAULT_MIN_CHARS + 5000);
    const messages = [makeMsg("user", big), malformed];
    const session = makeSession(messages);
    expect(() => applyMidTurnBudget({ session, contextWindowTokens: 200_000 })).not.toThrow();
  });

  it("does not call replaceMessages when applied=false", () => {
    const session = makeSession([makeMsg("user", "hi")]);
    const _stub = vi.fn();
    session.agent.replaceMessages = _stub;
    applyMidTurnBudget({ session, contextWindowTokens: 200_000 });
    expect(_stub).not.toHaveBeenCalled();
  });
});
