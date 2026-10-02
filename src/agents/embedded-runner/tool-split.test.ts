import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { sessionToolAllowlist, splitSdkTools } from "./tool-split.js";

function stubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} } as AgentTool["parameters"],
    execute: async () => ({ content: [], details: {} }) as AgentToolResult<unknown>,
  };
}

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

describe("sessionToolAllowlist", () => {
  it("activates exactly our custom tools in a real pi session", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tool-split-"));
    tempDirs.push(cwd);
    // "read" and "write" collide with pi built-ins on purpose: ours must win,
    // and pi's own "bash" must not appear.
    const tools = ["read", "write", "exec", "memory_search", "task_monitor"].map(stubTool);
    const { customTools } = splitSdkTools({ tools, sandboxEnabled: false });
    const authStorage = AuthStorage.inMemory();

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      model,
      tools: sessionToolAllowlist(customTools),
      customTools,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
    });

    expect(session.getActiveToolNames().toSorted()).toEqual(
      ["exec", "memory_search", "read", "task_monitor", "write"].toSorted(),
    );
    const read = session.agent.state.tools.find((tool) => tool.name === "read");
    expect(read?.description).toBe("read stub");
    session.dispose();
  });

  it("guards the pi 0.73 semantics: an empty allowlist means no tools", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tool-split-"));
    tempDirs.push(cwd);
    const { customTools } = splitSdkTools({ tools: [stubTool("exec")], sandboxEnabled: false });
    const authStorage = AuthStorage.inMemory();

    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      model,
      tools: [],
      customTools,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
    });

    expect(session.getActiveToolNames()).toEqual([]);
    session.dispose();
  });
});
