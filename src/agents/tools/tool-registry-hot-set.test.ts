import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { isToolDeferLoading } from "../providers/anthropic/tool-search.js";
import { LIST_TOOLS_NAME, USE_TOOL_NAME } from "./tool-dispatcher-tool.js";
import {
  applyHotSetExposure,
  resolveHotSetExposure,
  estimateToolDefinitionTokens,
  HOT_SET_DEFAULT_ALWAYS,
  HOT_SET_DEFAULT_MAX,
  HOT_SET_DEFAULT_PER_LANE,
  resolveHotSetConfig,
  resolveToolLane,
  selectHotTools,
  sortToolsByName,
} from "./tool-registry-hot-set.js";

/** The live registry as measured on 2026-09-19 (pi core + bitterbot-tools). */
const LIVE_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "exec",
  "process",
  "browser",
  "computer_use",
  "network_status",
  "a2a_status",
  "canvas",
  "create_artifact",
  "code_interpreter",
  "nodes",
  "message",
  "tts",
  "gateway",
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "session_status",
  "web_search",
  "web_fetch",
  "image",
  "expand_message",
  "complete",
  "plan",
  "task_create",
  "task_update",
  "task_get",
  "task_list",
  "task_monitor",
  "task_stop",
  "task_output",
  "task_write_handoff",
  "task_read_handoff",
  "task_workspace_get",
  "task_workspace_merge",
  "task_schedule_wakeup",
  "task_resume_inline",
  "task_judge",
  "memory_search",
  "memory_get",
  "memory_expand",
  "memory_pin",
  "memory_status",
  "dream_search",
  "dream_status",
  "curiosity_state",
  "curiosity_resolve",
  "create_emotional_anchor",
  "recall_emotional_anchor",
  "deep_recall",
  "skill_seekers_ingest",
  "skill_pipeline_digest",
  "skill_manage",
  "forage",
  "circles",
  "wallet",
  "a2a_client",
];

function stub(name: string, description = `${name} does things`): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: { a: { type: "string" } } },
    execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
  } as AnyAgentTool;
}

// Shuffled on purpose: registration order must not leak into the exposure.
const registry = [...LIVE_TOOL_NAMES].toReversed().map((name) => stub(name));
const names = (tools: readonly AnyAgentTool[]) => tools.map((tool) => tool.name);
const defaults = resolveHotSetConfig({});

describe("resolveToolLane", () => {
  it("mirrors promptMode: heartbeat flag/suffix, subagent and cron key shapes, else chat", () => {
    expect(resolveToolLane({ sessionKey: "agent:main:main" })).toBe("chat");
    expect(resolveToolLane({ sessionKey: "agent:main:main", isHeartbeat: true })).toBe("heartbeat");
    expect(resolveToolLane({ sessionKey: "agent:main:main:heartbeat" })).toBe("heartbeat");
    expect(resolveToolLane({ sessionKey: "agent:main:subagent:abc" })).toBe("subagent");
    expect(resolveToolLane({ sessionKey: "agent:main:cron:job1:run:xyz" })).toBe("cron");
    expect(resolveToolLane({ sessionKey: "agent:main:cron:job1" })).toBe("cron");
    expect(resolveToolLane({ sessionKey: undefined })).toBe("chat");
    expect(resolveToolLane({ sessionKey: "agent:main:main", lane: "cron" })).toBe("cron");
  });
});

describe("selectHotTools per lane", () => {
  it("chat: always + chat list, capped at max, sorted by name", () => {
    const sel = selectHotTools({ tools: registry, lane: "chat", hotSet: defaults });
    expect(names(sel.hot)).toEqual(
      [...HOT_SET_DEFAULT_ALWAYS, ...HOT_SET_DEFAULT_PER_LANE.chat].toSorted(),
    );
    expect(sel.hot.length).toBeLessThanOrEqual(HOT_SET_DEFAULT_MAX);
    expect(names(sel.hot)).not.toContain("message");
    expect(names(sel.hot)).not.toContain("browser");
    expect(names(sel.deferred)).toContain("message");
    expect(sel.hot.length + sel.deferred.length).toBe(registry.length);
  });

  it("heartbeat: read, memory_search, message only", () => {
    const sel = selectHotTools({ tools: registry, lane: "heartbeat", hotSet: defaults });
    expect(names(sel.hot)).toEqual(["memory_search", "message", "read"]);
  });

  it("cron: chat minus browser/canvas; subagent: chat minus sessions_send", () => {
    const cron = selectHotTools({ tools: registry, lane: "cron", hotSet: defaults });
    expect(names(cron.hot)).not.toContain("browser");
    expect(names(cron.hot)).not.toContain("canvas");
    expect(names(cron.hot)).toContain("exec");
    const sub = selectHotTools({ tools: registry, lane: "subagent", hotSet: defaults });
    expect(names(sub.hot)).not.toContain("sessions_send");
    expect(names(sub.hot)).toContain("write");
  });

  it("only picks from what is registered: a policy-denied tool cannot be promoted back", () => {
    const withoutExec = registry.filter((tool) => tool.name !== "exec");
    const sel = selectHotTools({ tools: withoutExec, lane: "chat", hotSet: defaults });
    expect(names(sel.hot)).not.toContain("exec");
    expect(sel.hot.length).toBe(
      HOT_SET_DEFAULT_ALWAYS.length + HOT_SET_DEFAULT_PER_LANE.chat.length - 1,
    );
  });

  it("honours max as a priority cut (always first, then lane order)", () => {
    const sel = selectHotTools({
      tools: registry,
      lane: "chat",
      hotSet: { ...defaults, max: 3 },
    });
    expect(names(sel.hot)).toEqual(["exec", "memory_search", "read"]);
  });

  it("disabled: everything is hot (sorted), nothing deferred", () => {
    const sel = selectHotTools({
      tools: registry,
      lane: "chat",
      hotSet: { ...defaults, enabled: false },
    });
    expect(sel.deferred).toEqual([]);
    expect(names(sel.hot)).toEqual([...LIVE_TOOL_NAMES].toSorted());
  });
});

describe("resolveHotSetConfig", () => {
  it("defaults", () => {
    expect(defaults).toEqual({
      enabled: true,
      max: HOT_SET_DEFAULT_MAX,
      always: [...HOT_SET_DEFAULT_ALWAYS],
      perLane: {
        chat: [...HOT_SET_DEFAULT_PER_LANE.chat],
        heartbeat: [...HOT_SET_DEFAULT_PER_LANE.heartbeat],
        cron: [...HOT_SET_DEFAULT_PER_LANE.cron],
        subagent: [...HOT_SET_DEFAULT_PER_LANE.subagent],
      },
    });
  });

  it("agent override layers field-wise over the global block (promote a tool)", () => {
    const config = {
      tools: { hotSet: { max: 4, perLane: { chat: ["exec", "message"] } } },
      agents: {
        list: [
          { id: "main", tools: { hotSet: { always: ["Read"], perLane: { cron: ["exec"] } } } },
        ],
      },
    } as unknown as BitterbotConfig;
    const resolved = resolveHotSetConfig({ config, agentId: "main" });
    expect(resolved.max).toBe(4);
    expect(resolved.always).toEqual(["read"]);
    expect(resolved.perLane.chat).toEqual(["exec", "message"]);
    expect(resolved.perLane.cron).toEqual(["exec"]);
    expect(resolved.perLane.heartbeat).toEqual([...HOT_SET_DEFAULT_PER_LANE.heartbeat]);
    const sel = selectHotTools({ tools: registry, lane: "chat", hotSet: resolved });
    expect(names(sel.hot)).toEqual(["exec", "message", "read"]);
  });
});

describe("applyHotSetExposure", () => {
  it("exposes hot tools + list_tools + use_tool, sorted by name, byte-stable across calls", () => {
    const first = applyHotSetExposure({ tools: registry, lane: "chat" });
    const second = applyHotSetExposure({ tools: [...registry].toReversed(), lane: "chat" });
    expect(names(first)).toEqual([...names(first)].toSorted());
    expect(names(first)).toContain(LIST_TOOLS_NAME);
    expect(names(first)).toContain(USE_TOOL_NAME);
    expect(first.length).toBe(
      HOT_SET_DEFAULT_ALWAYS.length + HOT_SET_DEFAULT_PER_LANE.chat.length + 2,
    );
    const bytes = (tools: AnyAgentTool[]) =>
      JSON.stringify(
        tools.map((tool) => ({ n: tool.name, d: tool.description, p: tool.parameters })),
      );
    expect(bytes(first)).toBe(bytes(second));
  });

  it("adds no meta-tools when nothing is deferred (validation / A2A floors)", () => {
    const small = ["read", "write", "edit", "exec"].map((name) => stub(name));
    const exposed = applyHotSetExposure({ tools: small, lane: "chat" });
    expect(names(exposed)).toEqual(["edit", "exec", "read", "write"]);
  });

  it("disabled via config returns the whole sorted registry", () => {
    const config = { tools: { hotSet: { enabled: false } } } as unknown as BitterbotConfig;
    const exposed = applyHotSetExposure({ tools: registry, lane: "chat", config });
    expect(names(exposed)).toEqual([...LIVE_TOOL_NAMES].toSorted());
  });

  it("wraps the meta-tools through the provided wrapper", () => {
    const wrapped: string[] = [];
    applyHotSetExposure({
      tools: registry,
      lane: "chat",
      wrapMetaTool: (tool) => {
        wrapped.push(tool.name);
        return tool;
      },
    });
    expect(wrapped.toSorted()).toEqual([LIST_TOOLS_NAME, USE_TOOL_NAME]);
  });
});

describe("sortToolsByName / estimate", () => {
  it("ASCII order (code units), input untouched", () => {
    const input = [stub("b"), stub("B"), stub("a_x"), stub("a")];
    const sorted = sortToolsByName(input);
    expect(names(sorted)).toEqual(["B", "a", "a_x", "b"]);
    expect(names(input)).toEqual(["b", "B", "a_x", "a"]);
  });

  it("estimate uses chars/2.6 over name+description+schema", () => {
    const tool = stub("x", "desc");
    const chars = JSON.stringify({
      name: "x",
      description: "desc",
      parameters: tool.parameters,
    }).length;
    expect(estimateToolDefinitionTokens([tool])).toEqual({
      chars,
      tokens: Math.ceil(chars / 2.6),
    });
  });
});

describe("native-deferred exposure (in-tree Anthropic runtime + tool search)", () => {
  const registry = () => LIVE_TOOL_NAMES.map((name) => stub(name));

  it("returns the FULL registry sorted by name, hot tools plain, the rest flagged, no meta-tools", () => {
    const exposure = resolveHotSetExposure({
      tools: registry(),
      lane: "chat",
      nativeToolSearch: true,
    });
    expect(exposure.mode).toBe("native-deferred");
    const names = exposure.tools.map((t) => t.name);
    expect(names).toEqual([...LIVE_TOOL_NAMES].toSorted());
    expect(names).not.toContain(LIST_TOOLS_NAME);
    expect(names).not.toContain(USE_TOOL_NAME);
    const hot = new Set([...HOT_SET_DEFAULT_ALWAYS, ...HOT_SET_DEFAULT_PER_LANE.chat]);
    for (const tool of exposure.tools) {
      expect(isToolDeferLoading(tool)).toBe(!hot.has(tool.name));
    }
    expect(exposure.hot.toSorted()).toEqual([...hot].toSorted());
    expect(exposure.deferred.length).toBe(LIVE_TOOL_NAMES.length - hot.size);
  });

  it("dispatcher mode is unchanged when the native flag is off", () => {
    const exposure = resolveHotSetExposure({ tools: registry(), lane: "chat" });
    expect(exposure.mode).toBe("dispatcher");
    expect(exposure.tools.map((t) => t.name)).toContain(LIST_TOOLS_NAME);
    expect(exposure.tools.some((t) => isToolDeferLoading(t))).toBe(false);
  });

  it("guard: an empty hot set never defers everything", () => {
    const exposure = resolveHotSetExposure({
      tools: registry(),
      lane: "chat",
      nativeToolSearch: true,
      config: { tools: { hotSet: { always: [], perLane: { chat: [] } } } } as BitterbotConfig,
    });
    expect(exposure.mode).toBe("all");
    expect(exposure.tools.some((t) => isToolDeferLoading(t))).toBe(false);
  });

  it("clears stale flags when a session moves back to the dispatcher", () => {
    const tools = registry();
    resolveHotSetExposure({ tools, lane: "chat", nativeToolSearch: true });
    expect(tools.some((t) => isToolDeferLoading(t))).toBe(true);
    resolveHotSetExposure({ tools, lane: "chat", nativeToolSearch: false });
    expect(tools.some((t) => isToolDeferLoading(t))).toBe(false);
  });
});
