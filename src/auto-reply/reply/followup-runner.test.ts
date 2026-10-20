import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../agents/embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

// PLAN-55 Phase 1 review (item 9): the correction capture hook; null = no line.
const correctionLineMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown): Promise<string | null> => null),
);
vi.mock("./agent-runner-memory.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-runner-memory.js")>(
    "./agent-runner-memory.js",
  );
  return {
    ...actual,
    runCorrectionCaptureAfterTurn: (params: unknown) => correctionLineMock(params),
  };
});

import { createFollowupRunner } from "./followup-runner.js";

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  ({
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    originatingTo: "channel:C1",
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider,
      agentAccountId: "primary",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  }) as FollowupRun;

describe("createFollowupRunner compaction", () => {
  it("adds verbose auto-compaction notice and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "bitterbot-compaction-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
      }) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: true },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "on",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as FollowupRun;

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    expect(onBlockReply.mock.calls[0][0].text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });

  it("updates totalTokens after auto-compaction using lastCallUsage", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "bitterbot-followup-compaction-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 180_000,
      compactionCount: 0,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);
    const onBlockReply = vi.fn(async () => {});

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
      }) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        });
        return {
          payloads: [{ text: "done" }],
          meta: {
            agentMeta: {
              // Accumulated usage across pre+post compaction calls.
              usage: { input: 190_000, output: 8_000, total: 198_000 },
              // Last call usage reflects post-compaction context.
              lastCallUsage: { input: 11_000, output: 2_000, total: 13_000 },
              model: "claude-opus-4-5",
              provider: "anthropic",
            },
          },
        };
      },
    );

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 200_000,
    });

    await runner(baseQueuedRun());

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.compactionCount).toBe(1);
    expect(store[sessionKey]?.totalTokens).toBe(11_000);
    // We only keep the total estimate after compaction.
    expect(store[sessionKey]?.inputTokens).toBeUndefined();
    expect(store[sessionKey]?.outputTokens).toBeUndefined();
  });
});

describe("createFollowupRunner messaging tool dedupe", () => {
  it("drops payloads already sent via messaging tool", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["hello world!"],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers payloads when not duplicates", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses replies when a messaging tool sent via the same provider + target", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun("slack"));

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("persists usage even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "bitterbot-followup-usage-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 1_000, output: 50 },
          lastCallUsage: { input: 400, output: 20 },
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun("slack"));

    expect(onBlockReply).not.toHaveBeenCalled();
    const store = loadSessionStore(storePath, { skipCache: true });
    // totalTokens should reflect the last call usage snapshot, not the accumulated input.
    expect(store[sessionKey]?.totalTokens).toBe(400);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(store[sessionKey]?.inputTokens).toBe(1_000);
    expect(store[sessionKey]?.outputTokens).toBe(50);
  });
});

describe("createFollowupRunner correction capture (PLAN-55 Phase 1 review, item 9)", () => {
  function makeRunner(onBlockReply: ReturnType<typeof vi.fn>) {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    return createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
    });
  }
  const queued = (userBody: string) =>
    ({
      prompt: "[Replying to Alice]\nx\n[/Replying]\n\n" + userBody,
      userBody,
      summaryLine: userBody,
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        verboseLevel: "off",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    }) as unknown as FollowupRun;

  it("runs the hook with the queued message's raw body and appends the line to the reply", async () => {
    correctionLineMock.mockReset();
    correctionLineMock.mockResolvedValue("Memory updated: deploy endpoint = api2.acme.com");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [{ text: "Got it." }], meta: {} });
    const onBlockReply = vi.fn(async () => {});
    await makeRunner(onBlockReply)(queued("No, the deploy endpoint is api2.acme.com"));
    const params = correctionLineMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((params.followupRun as FollowupRun).userBody).toBe(
      "No, the deploy endpoint is api2.acme.com",
    );
    expect(params.replyText).toBe("Got it.");
    expect(params.isHeartbeat).toBe(false);
    expect(typeof params.runStartedAt).toBe("number");
    const texts = onBlockReply.mock.calls.map((c) => (c[0] as { text?: string }).text);
    expect(texts).toEqual(["Got it.", "Memory updated: deploy endpoint = api2.acme.com"]);
  });

  it("delivers the line on its own when the queued turn produced no payload", async () => {
    correctionLineMock.mockReset();
    correctionLineMock.mockResolvedValue("Memory updated: deploy endpoint = api2.acme.com");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const onBlockReply = vi.fn(async () => {});
    await makeRunner(onBlockReply)(queued("No, the deploy endpoint is api2.acme.com"));
    const texts = onBlockReply.mock.calls.map((c) => (c[0] as { text?: string }).text);
    expect(texts).toEqual(["Memory updated: deploy endpoint = api2.acme.com"]);
  });

  it("sends nothing extra when the hook has nothing to say", async () => {
    correctionLineMock.mockReset();
    correctionLineMock.mockResolvedValue(null);
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [{ text: "Got it." }], meta: {} });
    const onBlockReply = vi.fn(async () => {});
    await makeRunner(onBlockReply)(queued("thanks"));
    const texts = onBlockReply.mock.calls.map((c) => (c[0] as { text?: string }).text);
    expect(texts).toEqual(["Got it."]);
  });
});
