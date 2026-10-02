import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool, StreamFn } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@mariozechner/pi-ai";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { sessionToolAllowlist, splitSdkTools } from "../../../embedded-runner/tool-split.js";
import { ensurePiCompactionReserveTokens } from "./settings.js";
import { applyToolLoopCompat, STEERING_SKIP_REASON } from "./tool-loop-compat.js";

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

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tool-loop-"));
  tempDirs.push(dir);
  return dir;
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/** Turn 1 calls tools a, b, c in one message; later turns end. */
function threeToolCallsThenStop(toolResults: string[]): StreamFn {
  let call = 0;
  return (_model, context) => {
    call += 1;
    for (const message of context.messages) {
      if (message.role === "toolResult" && call === 2) {
        toolResults.push(
          `${message.toolName}:${message.content.map((b) => (b.type === "text" ? b.text : "")).join("")}`,
        );
      }
    }
    const message =
      call === 1
        ? assistant(
            ["a", "b", "c"].map((name) => ({
              type: "toolCall" as const,
              id: `call_${name}`,
              name,
              arguments: {},
            })),
            "toolUse",
          )
        : assistant([{ type: "text", text: "done" }], "stop");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
    });
    return stream;
  };
}

async function sessionWithTools(
  tools: AgentTool[],
  settingsManager = SettingsManager.inMemory(),
): Promise<AgentSession> {
  const cwd = tempDir();
  const { customTools } = splitSdkTools({ tools, sandboxEnabled: false });
  const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model,
    tools: sessionToolAllowlist(customTools),
    customTools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  return session;
}

function trackingTool(name: string, log: string[], onRun?: () => void): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} } as AgentTool["parameters"],
    execute: async () => {
      log.push(`start:${name}`);
      onRun?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`end:${name}`);
      return { content: [{ type: "text", text: `${name} ok` }], details: {} };
    },
  };
}

describe("applyToolLoopCompat", () => {
  it("runs tool calls from one message sequentially", async () => {
    const log: string[] = [];
    const session = await sessionWithTools(["a", "b", "c"].map((n) => trackingTool(n, log)));
    applyToolLoopCompat(session);
    session.agent.streamFn = threeToolCallsThenStop([]);
    await session.prompt("go");
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    session.dispose();
  });

  it("skips the rest of the batch once a steering message is queued", async () => {
    const log: string[] = [];
    const results: string[] = [];
    let session: AgentSession | undefined;
    const tools = [
      trackingTool("a", log, () => {
        void session?.steer("stop please");
      }),
      trackingTool("b", log),
      trackingTool("c", log),
    ];
    session = await sessionWithTools(tools);
    applyToolLoopCompat(session);
    session.agent.streamFn = threeToolCallsThenStop(results);
    await session.prompt("go");
    expect(log).toEqual(["start:a", "end:a"]);
    expect(results).toContain("a:a ok");
    expect(results.filter((r) => r.includes(STEERING_SKIP_REASON))).toHaveLength(2);
    session.dispose();
  });
});

describe("compaction reserve-token floor", () => {
  it("is dropped by session creation and must be applied afterwards (pi >= 0.73)", async () => {
    const cwd = tempDir();
    const settingsManager = SettingsManager.create(cwd, cwd);
    ensurePiCompactionReserveTokens({ settingsManager, minReserveTokens: 20_000 });
    expect(settingsManager.getCompactionReserveTokens()).toBe(20_000);

    const session = await sessionWithTools([], settingsManager);
    expect(settingsManager.getCompactionReserveTokens()).toBeLessThan(20_000);

    ensurePiCompactionReserveTokens({ settingsManager, minReserveTokens: 20_000 });
    expect(settingsManager.getCompactionReserveTokens()).toBe(20_000);
    session.dispose();
  });
});
