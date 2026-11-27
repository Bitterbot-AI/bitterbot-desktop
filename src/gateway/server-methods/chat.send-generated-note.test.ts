/**
 * PLAN-64: the generated one-line note of a `chat.send` turn ("Memory
 * updated", a practice offer, "Practice saved", "Applied: ...").
 *
 * The desktop app and the browser Control UI show the reply of an agent run
 * from the agent event stream, and `chat.send` discards the final payload
 * text of such a run. The note therefore has a path of its own: persisted as
 * a short assistant message after the answer and broadcast like a
 * `chat.inject` message. Found by driving the real agent on 2026-11-27: the
 * offer was recorded and a bare "yes" answered a question nobody had seen.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATED_NOTE_FIELD } from "../../agents/generated-note.js";
import { TRANSCRIPT_VERSION } from "../../agents/runtime/transcript/types.js";
import type { ReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { GetReplyOptions } from "../../auto-reply/types.js";

type TranscriptLine = { type?: string; message?: Record<string, unknown> };
type Dispatch = (params: {
  dispatcher: ReplyDispatcher;
  replyOptions: GetReplyOptions;
}) => Promise<void>;

const state = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "",
  dispatch: null as Dispatch | null,
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(state.transcriptPath), "sessions.json"),
      entry: { sessionId: state.sessionId, sessionFile: state.transcriptPath },
      canonicalKey: "agent:main:main",
    }),
  };
});

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: async (params: Parameters<Dispatch>[0]) => {
    await state.dispatch?.(params);
    await params.dispatcher.waitForIdle();
    return {};
  },
}));

const { chatHandlers } = await import("./chat.js");

const OFFER =
  "You have asked for npm downloads after repo clone metrics twice. Include it every time? (yes / no)";
const ANSWER = "Yesterday the repo had 68 unique clones.";

async function readTranscript(): Promise<TranscriptLine[]> {
  const raw = await fs.readFile(state.transcriptPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TranscriptLine);
}

const assistantTexts = (lines: TranscriptLine[]) =>
  lines
    .filter((line) => line.message?.role === "assistant")
    .map((line) => ((line.message?.content ?? []) as Array<{ text?: string }>)[0]?.text);

function createContext() {
  return {
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map<string, string>(),
    chatDeltaSentAt: new Map<string, number>(),
    chatAbortedRuns: new Map<string, number>(),
    agentRunSeq: new Map<string, number>(),
    dedupe: new Map<string, unknown>(),
    removeChatRun: vi.fn(),
    registerToolEventRecipient: vi.fn(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
  };
}

/** Send one message and wait until the handler finished its dispatch. */
async function send(context: ReturnType<typeof createContext>, runId: string) {
  const respond = vi.fn();
  await chatHandlers["chat.send"]({
    params: { sessionKey: "main", message: "How many clones yesterday?", idempotencyKey: runId },
    respond,
    context: context as never,
    client: null,
  } as never);
  await vi.waitFor(() => expect(context.dedupe.has(`chat:${runId}`)).toBe(true));
  return respond;
}

const chatEvents = (context: ReturnType<typeof createContext>) =>
  context.broadcast.mock.calls
    .filter((call) => call[0] === "chat")
    .map(
      (call) => call[1] as { runId: string; state: string; sessionKey: string; message?: unknown },
    );

/** What the agent runtime does on a run: its own reply is already in the transcript. */
async function appendModelAnswer() {
  const { openTranscriptForAgent } = await import("../../agents/runtime/open-transcript.js");
  openTranscriptForAgent(state.transcriptPath, {}).appendMessage({
    role: "assistant",
    content: [{ type: "text", text: ANSWER }],
    timestamp: Date.now(),
    stopReason: "stop",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  } as never);
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-chat-note-"));
  state.transcriptPath = path.join(dir, "sess-main.jsonl");
  state.sessionId = "sess-main";
  state.dispatch = null;
  await fs.writeFile(
    state.transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: TRANSCRIPT_VERSION,
      id: state.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat.send generated note", () => {
  it("after an agent run: persisted once as its own assistant message after the answer, and broadcast", async () => {
    const delivered: boolean[] = [];
    state.dispatch = async ({ dispatcher, replyOptions }) => {
      replyOptions.onAgentRunStart?.("run-1");
      await appendModelAnswer();
      delivered.push((await replyOptions.deliverGeneratedNote?.(OFFER)) === true);
      // The final payload of an agent run: the model's text only (the line is
      // not appended on this surface), and chat.send discards it.
      dispatcher.sendFinalReply({ text: ANSWER });
    };
    const context = createContext();
    await send(context, "run-1");

    expect(delivered).toEqual([true]);
    const lines = await readTranscript();
    expect(assistantTexts(lines)).toEqual([ANSWER, OFFER]);
    const note = lines.at(-1)!.message!;
    expect(note).toMatchObject({
      role: "assistant",
      provider: "bitterbot",
      model: "gateway-injected",
      [GENERATED_NOTE_FIELD]: true,
    });
    // Chained after the answer, so the session context keeps both.
    const entries = lines as Array<TranscriptLine & { id?: string; parentId?: string }>;
    expect(entries.at(-1)!.parentId).toBe(entries.at(-2)!.id);

    // Live: one `final` on a run id of its own, carrying the stored message.
    const events = chatEvents(context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: "final", sessionKey: "main" });
    expect(events[0]!.runId).toMatch(/^inject-/);
    expect(events[0]!.runId).not.toBe("run-1");
    expect(events[0]!.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: OFFER }],
    });
    expect(context.nodeSendToSession).toHaveBeenCalledTimes(1);
  });

  it("a turn with no generated line persists and broadcasts nothing extra", async () => {
    state.dispatch = async ({ dispatcher, replyOptions }) => {
      replyOptions.onAgentRunStart?.("run-2");
      await appendModelAnswer();
      dispatcher.sendFinalReply({ text: ANSWER });
    };
    const context = createContext();
    await send(context, "run-2");
    expect(assistantTexts(await readTranscript())).toEqual([ANSWER]);
    expect(chatEvents(context)).toEqual([]);
  });

  it("a note that cannot be persisted is not broadcast and is reported as not delivered", async () => {
    const delivered: boolean[] = [];
    state.dispatch = async ({ replyOptions }) => {
      replyOptions.onAgentRunStart?.("run-3");
      await fs.rm(state.transcriptPath);
      delivered.push((await replyOptions.deliverGeneratedNote?.(OFFER)) === true);
      delivered.push((await replyOptions.deliverGeneratedNote?.("   ")) === true);
    };
    const context = createContext();
    await send(context, "run-3");
    expect(delivered).toEqual([false, false]);
    expect(chatEvents(context)).toEqual([]);
    expect(context.logGateway.warn).toHaveBeenCalledTimes(1);
  });

  it("without an agent run (a command reply) the final text is persisted and broadcast as before", async () => {
    state.dispatch = async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: "Session reset." });
    };
    const context = createContext();
    await send(context, "run-4");
    const lines = await readTranscript();
    expect(assistantTexts(lines)).toEqual(["Session reset."]);
    expect(lines.at(-1)!.message![GENERATED_NOTE_FIELD]).toBeUndefined();
    const events = chatEvents(context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: "run-4", state: "final" });
  });
});
