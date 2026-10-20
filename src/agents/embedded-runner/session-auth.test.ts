import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, ModelRegistry } from "../runtime/models/index.js";
import { AgentSession, type SessionStore } from "../runtime/session/session.js";
import { TranscriptStore } from "../runtime/transcript/store.js";
import { withSessionRequestAuth } from "./session-auth.js";

const model = {
  id: "stub-model",
  name: "stub-model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
} as Model<"anthropic-messages">;

afterEach(() => {
  vi.unstubAllEnvs();
});

function recordingStream(seen: Array<SimpleStreamOptions | undefined>): StreamFn {
  return (streamModel, _context, options) => {
    seen.push(options);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: streamModel.api,
      provider: streamModel.provider,
      model: streamModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

describe("withSessionRequestAuth", () => {
  it("delivers the runtime API key to the stream function a session turn calls", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("anthropic", "sk-runtime-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);

    const seen: Array<SimpleStreamOptions | undefined> = [];
    const session = new AgentSession({
      model,
      thinkingLevel: "off",
      systemPrompt: "auth test",
      tools: [],
      store: TranscriptStore.inMemory() as unknown as SessionStore,
      streamFn: withSessionRequestAuth(recordingStream(seen), modelRegistry),
      resolveRequestAuth: (target) => modelRegistry.getApiKeyAndHeaders(target),
    });
    await session.prompt("hello");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.apiKey).toBe("sk-runtime-key");
    session.dispose();
  });

  it("merges registry headers under explicit per-call headers and surfaces auth errors", async () => {
    const seen: Array<SimpleStreamOptions | undefined> = [];
    const registry = {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "k",
        headers: { "x-provider": "registry", "x-both": "registry" },
      })),
    } as unknown as ModelRegistry;
    const fn = withSessionRequestAuth(recordingStream(seen), registry);
    await fn(model, { messages: [] }, { headers: { "x-both": "call" } });
    expect(seen[0]?.headers).toEqual({ "x-provider": "registry", "x-both": "call" });

    const failing = {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: false as const, error: "No API key found" })),
    } as unknown as ModelRegistry;
    await expect(
      withSessionRequestAuth(recordingStream(seen), failing)(model, { messages: [] }, {}),
    ).rejects.toThrow("No API key found");
  });
});
