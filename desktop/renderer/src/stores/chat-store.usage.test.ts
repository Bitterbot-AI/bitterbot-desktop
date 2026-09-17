import { describe, expect, it } from "vitest";
import { useChatStore } from "./chat-store";

describe("chat-store applyUsageEvent", () => {
  it("buffers ledger rows per run and attaches the sum to the finalized reply", () => {
    useChatStore.setState({
      sessionKey: "agent:main:main",
      messages: [
        { id: "u1", role: "user", content: "hi", timestamp: 1 },
        { id: "a0", role: "assistant", content: "earlier", timestamp: 2 },
      ],
      pendingRunCosts: {},
      runMessages: {},
      activeRun: null,
    } as never);
    const store = useChatStore.getState();
    store.startRun("run-1");
    // Two model calls in one run (tool loop) stream before the reply is finalized.
    store.applyUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      runId: "run-1",
      sessionKey: "agent:main:main",
      cost: { total: 0.003 },
      usage: { input: 2, cacheRead: 8, output: 5 },
    });
    store.applyUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      runId: "run-1",
      sessionKey: "agent:main:main",
      cost: { total: 0.001 },
      usage: { input: 1, output: 1 },
    });
    // Nothing attaches to the earlier reply.
    expect(useChatStore.getState().messages[1]!.usage?.cost).toBeUndefined();
    useChatStore
      .getState()
      .finalizeRun("run-1", { id: "a1", role: "assistant", content: "hello", timestamp: 3 });
    const msg = useChatStore.getState().messages[2]!;
    expect(msg.usage?.cost).toBeCloseTo(0.004, 9);
    expect(msg.usage?.input).toBe(11);
    expect(msg.usage?.cacheRead).toBe(8);
    // A late row for the finalized run still lands on it; other lanes and sessions are ignored.
    useChatStore.getState().applyUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      runId: "run-1",
      sessionKey: "agent:main:main",
      cost: { total: 0.002 },
      usage: { output: 1 },
    });
    useChatStore.getState().applyUsageEvent({
      kind: "chat",
      feature: "agent/compaction",
      runId: "run-1",
      sessionKey: "agent:main:main",
      cost: { total: 9 },
    });
    useChatStore.getState().applyUsageEvent({
      kind: "chat",
      feature: "agent/turn",
      runId: "run-9",
      sessionKey: "agent:other:x",
      cost: { total: 9 },
    });
    expect(useChatStore.getState().messages[2]!.usage?.cost).toBeCloseTo(0.006, 9);
  });
});
