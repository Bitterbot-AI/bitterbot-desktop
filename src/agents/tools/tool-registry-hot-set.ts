/**
 * Hot-set tool exposure (token-efficiency W5, research §4 item E).
 *
 * The model used to receive all ~59 tool schemas (~20k tokens) on every call,
 * heartbeats included. Anthropic's guidance is to defer at 10+ tools or over
 * 10k tokens of definitions and keep the 3 to 5 hottest tools loaded. Native
 * `defer_loading` needs the runtime to parse `tool_reference` blocks, which
 * vendored pi-ai 0.52.12 cannot, so deferral is done client-side the way
 * Cursor (names-only + lookup) and Goose Code Mode (meta-tools) do it:
 *
 * - the HOT tools for the lane are exposed with full schemas;
 * - everything else stays registered but is reached through `list_tools`
 *   (name + one-line description, or the full schema of one tool) and
 *   `use_tool({ name, input })`, which validates against the target schema
 *   and dispatches to the SAME wrapped tool object the direct call would
 *   hit (policy filter, before-tool-call hook, capability enforcer, abort,
 *   cache, result spill all preserved).
 *
 * The exposed array is sorted by name (ASCII) so the request prefix is
 * byte-stable across turns for a given lane.
 */

import type { BitterbotConfig } from "../../config/config.js";
import type { ToolHotSetConfig, ToolHotSetLane } from "../../config/types.tools.js";
import type { AnyAgentTool } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { normalizeToolName } from "../tool-policy.js";
import { createListToolsTool, createUseToolTool } from "./tool-dispatcher-tool.js";

const log = createSubsystemLogger("agents/tools/hot-set");

export const HOT_SET_DEFAULT_MAX = 10;
/** chars / 2.6 is the estimate the audit uses for tool definitions. */
export const TOOL_DEFINITION_CHARS_PER_TOKEN = 2.6;

/**
 * Defaults derived from transcript telemetry (308 session files, 4,849 tool
 * calls, 2026-09-19): exec 64.8%, read 11.9%, process 4.3%, web_search 3.1%,
 * web_fetch 2.5%, memory_search 2.1%, code_interpreter 1.9%, browser 1.3%,
 * write 1.2%, edit 1.0%; everything else under 0.7%. `message` (7.1k chars,
 * 85 properties, 0.06% of calls) is deferred in chat and hot in heartbeat,
 * where it is the delivery path. `browser` (3.2k chars) stays deferred.
 */
export const HOT_SET_DEFAULT_ALWAYS: readonly string[] = ["read", "memory_search"];
const CHAT_HOT: readonly string[] = [
  "exec",
  "process",
  "write",
  "edit",
  "web_search",
  "web_fetch",
  "code_interpreter",
  "sessions_send",
];
export const HOT_SET_DEFAULT_PER_LANE: Readonly<Record<ToolHotSetLane, readonly string[]>> = {
  chat: CHAT_HOT,
  heartbeat: ["message"],
  // Same as chat minus browser/canvas (neither is hot in chat either; kept
  // explicit so a chat promotion of browser does not leak into cron).
  cron: CHAT_HOT.filter((name) => name !== "browser" && name !== "canvas"),
  // The subagent policy already denies memory_search / sessions_send; the
  // selection only picks from what survived the policy pipeline.
  subagent: CHAT_HOT.filter((name) => name !== "sessions_send"),
};

export type ResolvedHotSet = {
  enabled: boolean;
  max: number;
  always: string[];
  perLane: Record<ToolHotSetLane, string[]>;
};

export type HotSetSelection = {
  lane: ToolHotSetLane;
  hot: AnyAgentTool[];
  deferred: AnyAgentTool[];
};

/**
 * Lane derivation mirrors promptMode in the embedded runner: heartbeat is a
 * run flag (heartbeats run on the MAIN session key) or an explicit
 * `:heartbeat` key suffix; subagent and cron come from the key shape.
 */
export function resolveToolLane(params: {
  sessionKey?: string | null;
  isHeartbeat?: boolean;
  lane?: ToolHotSetLane;
}): ToolHotSetLane {
  if (params.lane) {
    return params.lane;
  }
  const key = (params.sessionKey ?? "").trim();
  if (params.isHeartbeat === true || key.toLowerCase().endsWith(":heartbeat")) {
    return "heartbeat";
  }
  if (isSubagentSessionKey(key)) {
    return "subagent";
  }
  if (isCronSessionKey(key)) {
    return "cron";
  }
  return "chat";
}

function cleanNames(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeToolName(entry))
    .filter(Boolean);
}

/** Global `tools.hotSet` with the agent's `tools.hotSet` layered field-wise on top. */
export function resolveHotSetConfig(params: {
  config?: BitterbotConfig;
  agentId?: string;
}): ResolvedHotSet {
  const global: ToolHotSetConfig | undefined = params.config?.tools?.hotSet;
  const agent: ToolHotSetConfig | undefined =
    params.config && params.agentId
      ? resolveAgentConfig(params.config, params.agentId)?.tools?.hotSet
      : undefined;
  const maxRaw = agent?.max ?? global?.max;
  const max =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw >= 1
      ? Math.floor(maxRaw)
      : HOT_SET_DEFAULT_MAX;
  const always = cleanNames(agent?.always) ??
    cleanNames(global?.always) ?? [...HOT_SET_DEFAULT_ALWAYS];
  const perLane = {} as Record<ToolHotSetLane, string[]>;
  for (const lane of ["chat", "heartbeat", "cron", "subagent"] as const) {
    perLane[lane] = cleanNames(agent?.perLane?.[lane]) ??
      cleanNames(global?.perLane?.[lane]) ?? [...HOT_SET_DEFAULT_PER_LANE[lane]];
  }
  return {
    enabled: agent?.enabled ?? global?.enabled ?? true,
    max,
    always,
    perLane,
  };
}

/** ASCII (UTF-16 code unit) sort by name; returns a new array, input untouched. */
export function sortToolsByName<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Split the registered tools into the lane's hot set and the deferred rest.
 * Priority is list order (`always` first, then the lane list); the first
 * `max` matches win. Names not registered for this session are skipped, so
 * a policy-denied tool can never be promoted back by the hot-set config.
 */
export function selectHotTools(params: {
  tools: readonly AnyAgentTool[];
  lane: ToolHotSetLane;
  hotSet: ResolvedHotSet;
}): HotSetSelection {
  const { tools, lane, hotSet } = params;
  if (!hotSet.enabled) {
    return { lane, hot: sortToolsByName(tools), deferred: [] };
  }
  const wanted: string[] = [];
  for (const name of [...hotSet.always, ...hotSet.perLane[lane]]) {
    if (!wanted.includes(name)) {
      wanted.push(name);
    }
  }
  const byName = new Map<string, AnyAgentTool>();
  for (const tool of tools) {
    const key = normalizeToolName(tool.name);
    if (!byName.has(key)) {
      byName.set(key, tool);
    }
  }
  const hot: AnyAgentTool[] = [];
  const hotKeys = new Set<string>();
  for (const name of wanted) {
    if (hot.length >= hotSet.max) {
      break;
    }
    const tool = byName.get(name);
    if (tool && !hotKeys.has(name)) {
      hot.push(tool);
      hotKeys.add(name);
    }
  }
  const deferred = tools.filter((tool) => !hotKeys.has(normalizeToolName(tool.name)));
  return { lane, hot: sortToolsByName(hot), deferred: sortToolsByName(deferred) };
}

/** Size of the definitions as the provider sees them (name + description + schema). */
export function estimateToolDefinitionTokens(tools: readonly AnyAgentTool[]): {
  chars: number;
  tokens: number;
} {
  let chars = 0;
  for (const tool of tools) {
    chars += JSON.stringify({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? {},
    }).length;
  }
  return { chars, tokens: Math.ceil(chars / TOOL_DEFINITION_CHARS_PER_TOKEN) };
}

/**
 * Final exposure: hot tools + the two meta-tools, sorted by name. When the
 * hot set is disabled, or nothing is deferred (a validation/A2A session
 * whose whole policy-filtered list is hot), the full sorted list is returned
 * unchanged and no meta-tools are added.
 */
export function applyHotSetExposure(params: {
  tools: readonly AnyAgentTool[];
  lane: ToolHotSetLane;
  config?: BitterbotConfig;
  agentId?: string;
  /** Applied to the meta-tools so they carry the same wrapper markers as the rest. */
  wrapMetaTool?: (tool: AnyAgentTool) => AnyAgentTool;
}): AnyAgentTool[] {
  const hotSet = resolveHotSetConfig({ config: params.config, agentId: params.agentId });
  const selection = selectHotTools({ tools: params.tools, lane: params.lane, hotSet });
  if (!hotSet.enabled || selection.deferred.length === 0) {
    return sortToolsByName(params.tools);
  }
  const wrap = params.wrapMetaTool ?? ((tool: AnyAgentTool) => tool);
  const registry = sortToolsByName(params.tools);
  const exposed = [
    ...selection.hot,
    wrap(
      createListToolsTool({
        lane: selection.lane,
        hot: selection.hot,
        deferred: selection.deferred,
      }),
    ),
    wrap(createUseToolTool({ registry })),
  ];
  const estimate = estimateToolDefinitionTokens(exposed);
  log.debug("hot-set exposure", {
    lane: selection.lane,
    hot: selection.hot.map((tool) => tool.name),
    deferredCount: selection.deferred.length,
    estimatedTokens: estimate.tokens,
  });
  return sortToolsByName(exposed);
}
