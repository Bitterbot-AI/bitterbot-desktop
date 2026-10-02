import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
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
import "./test-helpers/fast-coding-tools.js";
import { createBitterbotCodingTools } from "./agent-tools.js";
import { sessionToolAllowlist, splitSdkTools } from "./embedded-runner/tool-split.js";

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

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
) {
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
  } satisfies AssistantMessage;
}

/** First turn calls `edit` with `args`; second turn ends. Records tool results. */
function scriptedStream(args: Record<string, unknown>, toolResults: string[]): StreamFn {
  let call = 0;
  return (_model, context) => {
    call += 1;
    const stream = createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      toolResults.push(
        last.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      );
    }
    const message =
      call === 1
        ? assistant([{ type: "toolCall", id: "call_1", name: "edit", arguments: args }], "toolUse")
        : assistant([{ type: "text", text: "done" }], "stop");
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

async function runEdit(args: Record<string, unknown>) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bb-edit-shapes-"));
  tempDirs.push(workspace);
  const file = path.join(workspace, "note.txt");
  fs.writeFileSync(file, "alpha beta gamma\n", "utf8");

  const { customTools } = splitSdkTools({
    tools: createBitterbotCodingTools({ workspaceDir: workspace }),
    sandboxEnabled: false,
  });
  const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: workspace,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model,
    tools: sessionToolAllowlist(customTools),
    customTools,
    sessionManager: SessionManager.inMemory(workspace),
    settingsManager: SettingsManager.inMemory(),
  });
  const toolResults: string[] = [];
  session.agent.streamFn = scriptedStream(args, toolResults);
  await session.prompt("edit the file");
  session.dispose();
  return { content: fs.readFileSync(file, "utf8"), toolResults };
}

describe("edit tool argument shapes through a real pi session", () => {
  it("accepts Claude Code style (file_path, old_string, new_string)", async () => {
    const { content, toolResults } = await runEdit({
      file_path: "note.txt",
      old_string: "beta",
      new_string: "BETA",
    });
    expect(toolResults.join("\n")).not.toMatch(/Validation failed|Missing required/);
    expect(content).toBe("alpha BETA gamma\n");
  });

  it("accepts the legacy pi form (path, oldText, newText)", async () => {
    const { content } = await runEdit({ path: "note.txt", oldText: "gamma", newText: "GAMMA" });
    expect(content).toBe("alpha beta GAMMA\n");
  });

  it("accepts the pi 0.73 multi-edit form (path, edits[])", async () => {
    const { content } = await runEdit({
      path: "note.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ],
    });
    expect(content).toBe("ALPHA beta GAMMA\n");
  });

  it("ignores extra keys pi's strict edit schema would reject (replace_all: false)", async () => {
    const { content } = await runEdit({
      file_path: "note.txt",
      old_string: "beta",
      new_string: "BETA",
      replace_all: false,
    });
    expect(content).toBe("alpha BETA gamma\n");
    const nested = await runEdit({
      path: "note.txt",
      edits: [{ oldText: "gamma", newText: "GAMMA", replace_all: false }],
    });
    expect(nested.content).toBe("alpha beta GAMMA\n");
  });

  it("refuses replace_all: true with a clear error and leaves the file alone", async () => {
    const { content, toolResults } = await runEdit({
      file_path: "note.txt",
      old_string: "beta",
      new_string: "BETA",
      replace_all: true,
    });
    expect(content).toBe("alpha beta gamma\n");
    expect(toolResults.join("\n")).toContain("replace_all is not supported");
  });
});
