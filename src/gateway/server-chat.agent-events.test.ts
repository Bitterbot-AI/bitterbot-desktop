import { describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { createToolOutputLeases, TOOL_OUTPUT_LEASE_MS } from "./tool-output-leases.js";

describe("agent event handler", () => {
  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      handler,
    };
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 1_000,
    });
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not emit chat delta for NO_REPLY streaming text", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 1_000,
    });
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: " NO_REPLY  " },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(0);
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(0);
    nowSpy?.mockRestore();
  });

  it("does not include NO_REPLY text in chat final message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    handler({
      runId: "run-2",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as { state?: string; message?: unknown };
    expect(payload.state).toBe("final");
    expect(payload.message).toBeUndefined();
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("strips tool output when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });

  describe("tool output leases", () => {
    function harness(verboseLevel: "off" | "on" | "full") {
      let now = 1_000_000;
      const leases = createToolOutputLeases(() => now);
      const broadcastToConnIds = vi.fn();
      const toolEventRecipients = createToolEventRecipientRegistry();
      const handler = createAgentEventHandler({
        broadcast: vi.fn(),
        broadcastToConnIds,
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map<string, number>(),
        chatRunState: createChatRunState(),
        resolveSessionKeyForRun: () => "session-1",
        clearAgentRunContext: vi.fn(),
        toolEventRecipients,
        toolOutputLeases: leases,
      });
      const runId = `run-lease-${verboseLevel}`;
      registerAgentRunContext(runId, { sessionKey: "session-1", verboseLevel });
      toolEventRecipients.add(runId, "conn-pane");
      toolEventRecipients.add(runId, "conn-other");
      const emit = (seq: number) =>
        handler({
          runId,
          seq,
          stream: "tool",
          ts: now,
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "t1",
            result: { text: "SECRET-OUTPUT" },
          },
        });
      /** connId -> whether the event it received carried the output. */
      const delivered = () => {
        const out: Record<string, boolean> = {};
        for (const [event, payload, connIds] of broadcastToConnIds.mock.calls) {
          if (event !== "agent") continue;
          const hasOutput = (payload as { data?: { result?: unknown } }).data?.result !== undefined;
          for (const connId of connIds as Set<string>) out[connId] = hasOutput;
        }
        return out;
      };
      return { leases, emit, delivered, broadcastToConnIds, advance: (ms: number) => (now += ms) };
    }

    it("gives output only to the connection that holds a lease", () => {
      const h = harness("off");
      h.leases.grant("conn-pane");

      h.emit(1);

      expect(h.delivered()).toEqual({ "conn-pane": true, "conn-other": false });
      resetAgentRunContextForTest();
    });

    it("strips output for everyone when nobody holds a lease", () => {
      // The 866c6891 guarantee: no lease, no output, at any verbosity below full.
      const h = harness("on");

      h.emit(1);

      expect(h.delivered()).toEqual({ "conn-pane": false, "conn-other": false });
      resetAgentRunContextForTest();
    });

    it("stops sending output once the lease lapses", () => {
      const h = harness("off");
      h.leases.grant("conn-pane");
      h.emit(1);
      expect(h.delivered()["conn-pane"]).toBe(true);

      h.broadcastToConnIds.mockClear();
      h.advance(TOOL_OUTPUT_LEASE_MS);
      h.emit(2);

      expect(h.delivered()).toEqual({ "conn-pane": false, "conn-other": false });
      resetAgentRunContextForTest();
    });

    it("stops sending output on unsubscribe", () => {
      const h = harness("off");
      h.leases.grant("conn-pane");
      h.leases.revoke("conn-pane");

      h.emit(1);

      expect(h.delivered()["conn-pane"]).toBe(false);
      resetAgentRunContextForTest();
    });

    it("does not send output to a lease holder who is not a recipient of the run", () => {
      // A lease is not a subscription to other people's runs.
      const h = harness("off");
      h.leases.grant("conn-stranger");

      h.emit(1);

      expect(h.delivered()).toEqual({ "conn-pane": false, "conn-other": false });
      resetAgentRunContextForTest();
    });

    it("leaves verbose=full sessions as they were: everyone gets output", () => {
      const h = harness("full");

      h.emit(1);

      expect(h.delivered()).toEqual({ "conn-pane": true, "conn-other": true });
      resetAgentRunContextForTest();
    });
  });
});
