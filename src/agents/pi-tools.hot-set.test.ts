/**
 * Hot-set exposure through the REAL tool factory (token-efficiency W5).
 *
 * Proves, on the production pipeline: the exposed list per lane, the token
 * estimate, byte-stable ordering, and that use_tool dispatches into the same
 * gated objects as a direct call (a policy-denied tool is unreachable, the
 * exec security gate fires through the dispatcher).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { BitterbotConfig } from "../config/config.js";
import { isToolWrappedWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { createBitterbotCodingTools } from "./pi-tools.js";
import { LIST_TOOLS_NAME, USE_TOOL_NAME } from "./tools/tool-dispatcher-tool.js";
import {
  estimateToolDefinitionTokens,
  HOT_SET_DEFAULT_ALWAYS,
  HOT_SET_DEFAULT_PER_LANE,
} from "./tools/tool-registry-hot-set.js";

let ws: string;
beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "hot-set-"));
});
afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

const HOT_BUDGET_TOKENS = 5000;

function build(extra: Parameters<typeof createBitterbotCodingTools>[0] = {}) {
  return createBitterbotCodingTools({
    sessionKey: "agent:main:main",
    workspaceDir: ws,
    agentDir: path.join(ws, "agents", "main", "agent"),
    config: {} as BitterbotConfig,
    ...extra,
  });
}

const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);

describe("createBitterbotCodingTools hot-set exposure", () => {
  it("chat lane: hot tools + list_tools + use_tool, sorted, under the token budget", () => {
    const tools = build();
    const exposed = names(tools);
    expect(exposed).toEqual([...exposed].toSorted());
    expect(exposed).toContain(LIST_TOOLS_NAME);
    expect(exposed).toContain(USE_TOOL_NAME);
    // The fast stubs drop web_search/web_fetch (null), so the hot set is the
    // registered subset of the defaults.
    const wanted = [...HOT_SET_DEFAULT_ALWAYS, ...HOT_SET_DEFAULT_PER_LANE.chat];
    for (const name of exposed) {
      if (name === LIST_TOOLS_NAME || name === USE_TOOL_NAME) {
        continue;
      }
      expect(wanted).toContain(name);
    }
    expect(exposed).not.toContain("message");
    expect(exposed).not.toContain("browser");
    expect(exposed).not.toContain("task_create");
    const estimate = estimateToolDefinitionTokens(tools);
    // Printed on purpose: the number the research doc asks us to report.
    console.log(
      `[hot-set] chat lane exposes ${tools.length} tools: ${exposed.join(", ")} ` +
        `(${estimate.chars} chars, ~${estimate.tokens} tokens at chars/2.6)`,
    );
    expect(estimate.tokens).toBeLessThan(HOT_BUDGET_TOKENS);
  });

  it("heartbeat lane (flag on the main session key): read, memory_search, message + meta", () => {
    const tools = build({ isHeartbeat: true });
    expect(names(tools)).toEqual(
      ["memory_search", "message", "read", LIST_TOOLS_NAME, USE_TOOL_NAME].toSorted(),
    );
    const estimate = estimateToolDefinitionTokens(tools);
    console.log(`[hot-set] heartbeat lane: ${estimate.chars} chars, ~${estimate.tokens} tokens`);
    expect(estimate.tokens).toBeLessThan(HOT_BUDGET_TOKENS);
  });

  it("subagent and cron lanes derive from the session key", () => {
    const sub = names(build({ sessionKey: "agent:main:subagent:child-1" }));
    expect(sub).not.toContain("sessions_send");
    expect(sub).toContain("exec");
    expect(sub).toContain(USE_TOOL_NAME);
    const cron = names(build({ sessionKey: "agent:main:cron:nightly:run:1" }));
    expect(cron).toContain("exec");
    expect(cron).toContain("memory_search");
    expect(cron).not.toContain("browser");
  });

  it("byte-stable across two builds of the same lane", () => {
    const bytes = (tools: ReturnType<typeof build>) =>
      JSON.stringify(
        tools.map((tool) => ({ n: tool.name, d: tool.description, p: tool.parameters })),
      );
    expect(bytes(build())).toBe(bytes(build()));
  });

  it("tools.hotSet.enabled=false restores the full sorted registry with no meta-tools", () => {
    const tools = build({ config: { tools: { hotSet: { enabled: false } } } as BitterbotConfig });
    const exposed = names(tools);
    expect(exposed).toEqual([...exposed].toSorted());
    expect(exposed).not.toContain(LIST_TOOLS_NAME);
    expect(exposed).toContain("message");
    expect(exposed).toContain("task_create");
  });

  it("every exposed tool, meta-tools included, carries the before-tool-call marker", () => {
    for (const tool of build()) {
      expect(isToolWrappedWithBeforeToolCallHook(tool), tool.name).toBe(true);
    }
  });
});

describe("use_tool goes through the same gates as a direct call", () => {
  const details = (r: unknown) => (r as { details?: Record<string, unknown> }).details ?? {};

  it("a tools.deny'd tool is neither listed nor reachable (policy pipeline preserved)", async () => {
    const tools = build({ config: { tools: { deny: ["task_create"] } } as BitterbotConfig });
    const list = tools.find((tool) => tool.name === LIST_TOOLS_NAME)!;
    const use = tools.find((tool) => tool.name === USE_TOOL_NAME)!;
    const listed = details(await list.execute("l1", {})) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).not.toContain("task_create");
    expect(listed.tools.map((t) => t.name)).toContain("task_update");
    const out = details(await use.execute("u1", { name: "task_create", input: { title: "x" } }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/unknown tool/);
  });

  it("the exec security gate fires when exec is dispatched through use_tool", async () => {
    // Demote exec to the deferred set so the dispatcher is the only route,
    // and deny it at the security gate that the direct call would hit.
    const tools = build({
      config: {
        tools: {
          exec: { security: "deny", host: "gateway" },
          hotSet: { always: ["read"], perLane: { chat: ["read"] } },
        },
      } as BitterbotConfig,
    });
    expect(names(tools)).not.toContain("exec");
    const use = tools.find((tool) => tool.name === USE_TOOL_NAME)!;
    await expect(
      use.execute("u2", { name: "exec", input: { command: "echo hi" } }),
    ).rejects.toThrow(/exec denied: host=gateway security=deny/);
  });

  it("schema validation for the target is the same ajv path the loop uses", async () => {
    const tools = build();
    const use = tools.find((tool) => tool.name === USE_TOOL_NAME)!;
    const out = details(await use.execute("u3", { name: "task_get", input: {} }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/Validation failed for tool "task_get"/);
  });
});

describe("native tool search exposure through the real factory", () => {
  it("Anthropic API-key + Opus 4.8: full registry with deferral flags, no meta-tools", async () => {
    const { isToolDeferLoading } = await import("./providers/anthropic/tool-search.js");
    const tools = build({
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
      modelAuthMode: "api-key",
    });
    const exposed = names(tools);
    expect(exposed).toEqual([...exposed].toSorted());
    expect(exposed).not.toContain(LIST_TOOLS_NAME);
    expect(exposed).not.toContain(USE_TOOL_NAME);
    expect(exposed).toContain("message");
    const hot = new Set([...HOT_SET_DEFAULT_ALWAYS, ...HOT_SET_DEFAULT_PER_LANE.chat]);
    for (const tool of tools) {
      expect(isToolDeferLoading(tool)).toBe(!hot.has(tool.name));
    }
    // Every object still carries the gate wrappers.
    expect(tools.every((tool) => isToolWrappedWithBeforeToolCallHook(tool))).toBe(true);
  });

  it("OAuth, a non-Anthropic provider, or runtime=vendored keep the dispatcher", () => {
    for (const extra of [
      { modelProvider: "anthropic", modelId: "claude-opus-4-8", modelAuthMode: "oauth" as const },
      { modelProvider: "openai", modelId: "gpt-5" },
      {
        modelProvider: "anthropic",
        modelId: "claude-opus-4-8",
        modelAuthMode: "api-key" as const,
        config: { agents: { defaults: { anthropic: { runtime: "vendored" } } } } as BitterbotConfig,
      },
    ]) {
      const exposed = names(build(extra));
      expect(exposed).toContain(LIST_TOOLS_NAME);
      expect(exposed).toContain(USE_TOOL_NAME);
    }
  });
});
