import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  AssistantMessageEventStream,
  type Model,
} from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { applySystemPromptOverrideToSession } from "../runtime/engines/pi/session.js";

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

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("applySystemPromptOverrideToSession", () => {
  // pi-coding-agent >= 0.73 rebuilds and re-applies its own base system prompt
  // on tool-set changes and at the start of every prompt, so the override must
  // survive both and be what the model actually receives.
  it("keeps the override through tool changes and a real prompt cycle", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bb-system-prompt-"));
    tempDirs.push(cwd);
    const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      model,
      tools: [],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
    });

    const override = "You are Bitterbot. OVERRIDE-MARKER";
    applySystemPromptOverrideToSession(session, override);
    expect(session.agent.state.systemPrompt).toBe(override);

    session.setActiveToolsByName([]);
    expect(session.agent.state.systemPrompt).toBe(override);

    const seenSystemPrompts: Array<string | undefined> = [];
    const fakeStream: StreamFn = (streamModel, context) => {
      seenSystemPrompts.push(context.systemPrompt);
      const stream = new AssistantMessageEventStream();
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
    session.agent.streamFn = fakeStream;

    await session.prompt("hello");

    expect(seenSystemPrompts).toEqual([override]);
    expect(session.agent.state.systemPrompt).toBe(override);
    session.dispose();
  });
});
