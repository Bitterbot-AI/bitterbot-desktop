import {
  client as createClientApp,
  methods,
  PROTOCOL_VERSION,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent, createAcpAgentApp, sessionKeysMatch } from "./translator.js";

type RecordedRequest = { method: string; params: Record<string, unknown> };

function makeGateway(recorded: RecordedRequest[]) {
  const request = vi.fn(async (method: string, params?: unknown) => {
    recorded.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (method === "sessions.list") {
      return {
        sessions: [
          {
            key: "agent:main:main",
            displayName: "Main",
            kind: "direct",
            updatedAt: 1_700_000_000_000,
          },
          { key: "agent:main:side", label: "side", kind: "group" },
        ],
      };
    }
    return {};
  });
  return { gateway: { request } as unknown as GatewayClient, request };
}

function chatEvent(payload: Record<string, unknown>): EventFrame {
  return { type: "event", event: "chat", payload };
}

async function connectHarness(agentOpts: { gatewayReady?: Promise<void> } = {}) {
  const recorded: RecordedRequest[] = [];
  const { gateway, request } = makeGateway(recorded);
  const agent = new AcpGatewayAgent(gateway, {
    sessionStore: createInMemorySessionStore(),
    ...agentOpts,
  });
  const updates: SessionNotification[] = [];
  const clientApp = createClientApp({ name: "test-client" }).onNotification(
    methods.client.session.update,
    ({ params }) => {
      updates.push(params);
    },
  );
  const connection = clientApp.connect(createAcpAgentApp(agent));
  const peer = connection.agent;

  const init = await peer.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const session = await peer.request(methods.agent.session.new, {
    cwd: "/work/project",
    mcpServers: [],
  });
  const chatSend = () => recorded.find((r) => r.method === "chat.send");
  return { agent, peer, connection, updates, recorded, request, init, session, chatSend };
}

describe("AcpGatewayAgent over the SDK app API", () => {
  it("initializes, creates a session, and pushes available commands", async () => {
    const h = await connectHarness();
    try {
      expect(h.init.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(h.init.agentInfo?.name).toBeTruthy();
      expect(h.init.agentCapabilities?.loadSession).toBe(true);
      expect(h.session.sessionId).toMatch(/[0-9a-f-]{36}/);
      await vi.waitFor(() => expect(h.updates.length).toBeGreaterThan(0));
      expect(h.updates[0]?.sessionId).toBe(h.session.sessionId);
      expect(h.updates[0]?.update.sessionUpdate).toBe("available_commands_update");
      // Exactly one handler answers each request: a request must never be
      // dispatched to two agent instances (regression for the doubled stdio server).
      expect(
        h.updates.filter((u) => u.update.sessionUpdate === "available_commands_update"),
      ).toHaveLength(1);
      expect(h.recorded.filter((r) => r.method === "sessions.resolve")).toHaveLength(0);
    } finally {
      h.connection.close();
    }
  });

  it("streams gateway chat deltas as agent_message_chunk updates and ends the turn", async () => {
    const h = await connectHarness();
    try {
      const promptPromise = h.peer.request(methods.agent.session.prompt, {
        sessionId: h.session.sessionId,
        prompt: [{ type: "text", text: "hello there" }],
      });
      await vi.waitFor(() => expect(h.chatSend()).toBeDefined());
      const send = h.chatSend()!;
      const sessionKey = send.params.sessionKey as string;
      const runId = send.params.idempotencyKey as string;
      expect(sessionKey).toBe(`acp:${h.session.sessionId}`);
      expect(send.params.message).toBe("[Working directory: /work/project]\n\nhello there");

      // The gateway emits events under the canonical key, not the raw one we sent.
      const canonicalKey = `agent:main:${sessionKey}`;
      const delta = (text: string) =>
        h.agent.handleGatewayEvent(
          chatEvent({
            sessionKey: canonicalKey,
            runId,
            state: "delta",
            message: { content: [{ type: "text", text }] },
          }),
        );
      await delta("Hel");
      await delta("Hello world");
      // A delta for a different run must be ignored.
      await h.agent.handleGatewayEvent(
        chatEvent({
          sessionKey: canonicalKey,
          runId: "other-run",
          state: "delta",
          message: { content: [{ type: "text", text: "WRONG" }] },
        }),
      );
      // An event for a different session must be ignored even with the same prefix.
      await h.agent.handleGatewayEvent(
        chatEvent({ sessionKey: "agent:main:acp:someone-else", runId, state: "final" }),
      );
      await h.agent.handleGatewayEvent(
        chatEvent({ sessionKey: canonicalKey, runId, state: "final" }),
      );

      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");

      const chunks = h.updates
        .map((u) => u.update)
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u.content.type === "text" ? u.content.text : ""));
      expect(chunks).toEqual(["Hel", "lo world"]);
    } finally {
      h.connection.close();
    }
  });

  it("maps gateway tool events to tool_call and tool_call_update", async () => {
    const h = await connectHarness();
    try {
      const promptPromise = h.peer.request(methods.agent.session.prompt, {
        sessionId: h.session.sessionId,
        prompt: [{ type: "text", text: "read a file" }],
      });
      await vi.waitFor(() => expect(h.chatSend()).toBeDefined());
      const sessionKey = h.chatSend()!.params.sessionKey as string;
      const runId = h.chatSend()!.params.idempotencyKey as string;
      const toolEvent = (data: Record<string, unknown>): EventFrame => ({
        type: "event",
        event: "agent",
        payload: { stream: "tool", sessionKey, data },
      });
      await h.agent.handleGatewayEvent(
        toolEvent({ phase: "start", name: "read", toolCallId: "tc-1", args: { path: "a.ts" } }),
      );
      // Duplicate start for the same tool call id is de-duplicated.
      await h.agent.handleGatewayEvent(
        toolEvent({ phase: "start", name: "read", toolCallId: "tc-1", args: { path: "a.ts" } }),
      );
      await h.agent.handleGatewayEvent(
        toolEvent({ phase: "result", toolCallId: "tc-1", result: "contents", isError: false }),
      );
      await h.agent.handleGatewayEvent(chatEvent({ sessionKey, runId, state: "final" }));
      await promptPromise;

      const tool = h.updates
        .map((u) => u.update)
        .filter((u) => u.sessionUpdate.startsWith("tool_call"));
      expect(tool).toHaveLength(2);
      expect(tool[0]).toMatchObject({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        status: "in_progress",
        kind: "read",
      });
      expect(tool[1]).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        rawOutput: "contents",
      });
    } finally {
      h.connection.close();
    }
  });

  it("cancels an in-flight prompt via session/cancel and aborts on the gateway", async () => {
    const h = await connectHarness();
    try {
      const promptPromise = h.peer.request(methods.agent.session.prompt, {
        sessionId: h.session.sessionId,
        prompt: [{ type: "text", text: "long task" }],
      });
      await vi.waitFor(() => expect(h.chatSend()).toBeDefined());
      await h.peer.notify(methods.agent.session.cancel, { sessionId: h.session.sessionId });
      const response = await promptPromise;
      expect(response.stopReason).toBe("cancelled");
      const abort = h.recorded.find((r) => r.method === "chat.abort");
      expect(abort?.params.sessionKey).toBe(`acp:${h.session.sessionId}`);
    } finally {
      h.connection.close();
    }
  });

  it("lists gateway sessions through session/list", async () => {
    const h = await connectHarness();
    try {
      const list = await h.peer.request(methods.agent.session.list, { cwd: "/work/project" });
      expect(list.sessions.map((s) => s.sessionId)).toEqual(["agent:main:main", "agent:main:side"]);
      expect(list.sessions[0]?.title).toBe("Main");
      expect(list.sessions[1]?.title).toBe("side");
      expect(list.sessions[0]?.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());
      expect(h.recorded.find((r) => r.method === "sessions.list")?.params.limit).toBe(100);
    } finally {
      h.connection.close();
    }
  });

  it("fails in-flight prompts when the ACP connection closes", async () => {
    const h = await connectHarness();
    const promptPromise = h.peer.request(methods.agent.session.prompt, {
      sessionId: h.session.sessionId,
      prompt: [{ type: "text", text: "never answered" }],
    });
    await vi.waitFor(() => expect(h.chatSend()).toBeDefined());
    h.connection.close();
    await expect(promptPromise).rejects.toThrow();
  });

  it("rejects prompts for unknown sessions with a JSON-RPC error", async () => {
    const h = await connectHarness();
    try {
      await expect(
        h.peer.request(methods.agent.session.prompt, {
          sessionId: "missing",
          prompt: [{ type: "text", text: "x" }],
        }),
      ).rejects.toThrow(/not found/);
    } finally {
      h.connection.close();
    }
  });

  it("holds initialize until the gateway handshake completes", async () => {
    let release!: () => void;
    const gatewayReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorded: RecordedRequest[] = [];
    const { gateway } = makeGateway(recorded);
    const agent = new AcpGatewayAgent(gateway, {
      sessionStore: createInMemorySessionStore(),
      gatewayReady,
    });
    const connection = createClientApp().connect(createAcpAgentApp(agent));
    try {
      let settled = false;
      const init = connection.agent
        .request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        .then((res) => {
          settled = true;
          return res;
        });
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false);
      release();
      const res = await init;
      expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
    } finally {
      connection.close();
    }
  });

  it("surfaces gateway send failures with their reason", async () => {
    const h = await connectHarness();
    try {
      h.request.mockImplementationOnce(async () => {
        throw new Error("gateway not connected");
      });
      await expect(
        h.peer.request(methods.agent.session.prompt, {
          sessionId: h.session.sessionId,
          prompt: [{ type: "text", text: "x" }],
        }),
      ).rejects.toThrow(/gateway not connected/);
    } finally {
      h.connection.close();
    }
  });
});

describe("sessionKeysMatch", () => {
  it("matches raw keys against their gateway-canonical form", () => {
    expect(sessionKeysMatch("agent:main:acp:abc", "acp:abc")).toBe(true);
    expect(sessionKeysMatch("acp:abc", "agent:main:acp:abc")).toBe(true);
    expect(sessionKeysMatch("Agent:Main:ACP:abc", "acp:ABC")).toBe(true);
    expect(sessionKeysMatch("agent:main:main", "agent:main:main")).toBe(true);
  });

  it("rejects different sessions and bare prefixes", () => {
    expect(sessionKeysMatch("agent:main:acp:abc", "acp:abd")).toBe(false);
    expect(sessionKeysMatch("agent:main:main", "acp:abc")).toBe(false);
    expect(sessionKeysMatch("agent:other:acp:abc", "agent:main:acp:abc")).toBe(false);
    expect(sessionKeysMatch("agent:main", "main")).toBe(false);
    expect(sessionKeysMatch("", "acp:abc")).toBe(false);
  });
});
