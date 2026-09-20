/**
 * Native tool search (`tool_search_tool_bm25_20251119` / `tool_search_tool_regex_20251119`).
 *
 * The registry marks every non-hot tool with a deferral flag (a plain
 * property on the AgentTool object, set by tool-registry-hot-set.ts). At
 * request time the provider sends ALL tools: hot ones as-is, the rest with
 * `defer_loading: true`, plus the search tool, never deferred. Discovered
 * tools arrive as `tool_reference` blocks inside a `tool_search_tool_result`;
 * the API expands them server-side, in the history too, so as long as the
 * assistant's `server_tool_use` + `tool_search_tool_result` blocks are sent
 * back unchanged the model keeps the discovered schemas for the rest of the
 * session without re-searching. pi-agent-core executes any `tool_use` by name
 * against the full registry, so a discovered tool is callable immediately.
 *
 * Guards (API returns 400 otherwise): never defer the search tool; at least
 * one tool must be non-deferred; a deferred tool cannot carry cache_control;
 * every `tool_reference` must name a tool present in `tools`.
 */

import type { Message, Tool } from "@mariozechner/pi-ai";
import type {
  AnthropicToolSearchVariant,
  ServerToolUseBlock,
  ToolSearchResultBlock,
  WireToolSearchTool,
} from "./types.js";

export const TOOL_SEARCH_TOOL_TYPES: Readonly<Record<AnthropicToolSearchVariant, string>> = {
  bm25: "tool_search_tool_bm25_20251119",
  regex: "tool_search_tool_regex_20251119",
};

export const TOOL_SEARCH_TOOL_NAMES: Readonly<Record<AnthropicToolSearchVariant, string>> = {
  bm25: "tool_search_tool_bm25",
  regex: "tool_search_tool_regex",
};

/** Property the registry sets on AgentTool objects; survives object spread. */
export const DEFER_LOADING_KEY = "bitterbotDeferLoading";

export function markToolDeferLoading<T extends object>(tool: T, deferred: boolean): T {
  (tool as Record<string, unknown>)[DEFER_LOADING_KEY] = deferred;
  return tool;
}

/**
 * Name-keyed deferral plans. pi-agent-core rebuilds tool definitions before
 * they reach the streamFn, so the object property above does not survive the
 * trip. The hot-set registry records "for this exact tool-name set, these
 * names are deferred"; the provider looks the plan up by the name set it
 * receives. Bounded: one entry per distinct tool set (lanes x registries).
 */
const deferralPlansByToolSet = new Map<string, Set<string>>();
const MAX_DEFERRAL_PLANS = 64;

function toolSetKey(toolNames: readonly string[]): string {
  return toolNames
    .map((n) => n.trim())
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join("\u0000");
}

export function registerDeferralPlan(
  toolNames: readonly string[],
  deferredNames: readonly string[],
): void {
  const key = toolSetKey(toolNames);
  if (deferralPlansByToolSet.size >= MAX_DEFERRAL_PLANS && !deferralPlansByToolSet.has(key)) {
    const first = deferralPlansByToolSet.keys().next().value;
    if (first !== undefined) {
      deferralPlansByToolSet.delete(first);
    }
  }
  deferralPlansByToolSet.set(key, new Set(deferredNames.map((n) => n.trim())));
}

export function lookupDeferredNames(toolNames: readonly string[]): Set<string> | undefined {
  return deferralPlansByToolSet.get(toolSetKey(toolNames));
}

export function resetDeferralPlansForTest(): void {
  deferralPlansByToolSet.clear();
}

export function isToolDeferLoading(tool: unknown): boolean {
  return (
    !!tool &&
    typeof tool === "object" &&
    (tool as Record<string, unknown>)[DEFER_LOADING_KEY] === true
  );
}

export function isToolSearchToolName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    (name === TOOL_SEARCH_TOOL_NAMES.bm25 || name === TOOL_SEARCH_TOOL_NAMES.regex)
  );
}

export function buildToolSearchToolDefinition(
  variant: AnthropicToolSearchVariant,
): WireToolSearchTool {
  return { type: TOOL_SEARCH_TOOL_TYPES[variant], name: TOOL_SEARCH_TOOL_NAMES[variant] };
}

/** Names inside a `tool_search_tool_search_result.tool_references[]` (empty on error/no match). */
export function extractToolReferenceNames(content: unknown): string[] {
  if (!content || typeof content !== "object") {
    return [];
  }
  const refs = (content as { tool_references?: unknown }).tool_references;
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs
    .map((ref) =>
      ref &&
      typeof ref === "object" &&
      typeof (ref as { tool_name?: unknown }).tool_name === "string"
        ? ((ref as { tool_name: string }).tool_name as string)
        : "",
    )
    .filter(Boolean);
}

/**
 * Drop references to tools that are no longer in the request (a policy change
 * or a demoted hot set between turns). Sending an unknown reference is a hard
 * 400 ("Tool reference 'x' not found in available tools"); an empty
 * `tool_references` array is a valid shape (a search that matched nothing).
 */
export function filterToolReferences(
  content: unknown,
  known: ReadonlySet<string>,
): { content: unknown; dropped: string[] } {
  if (!content || typeof content !== "object") {
    return { content, dropped: [] };
  }
  const record = content as { tool_references?: unknown };
  if (!Array.isArray(record.tool_references)) {
    return { content, dropped: [] };
  }
  const dropped: string[] = [];
  const kept = record.tool_references.filter((ref) => {
    const name =
      ref && typeof ref === "object" ? (ref as { tool_name?: unknown }).tool_name : undefined;
    if (typeof name === "string" && !known.has(name)) {
      dropped.push(name);
      return false;
    }
    return true;
  });
  if (dropped.length === 0) {
    return { content, dropped };
  }
  return { content: { ...record, tool_references: kept }, dropped };
}

export type ToolSearchHistoryState = {
  /** Tool names referenced by a `tool_search_tool_result` still present in history. */
  referenced: Set<string>;
  /** Tool names the model has called in history. */
  called: Set<string>;
  /** Whether any server tool use / search result block is present at all. */
  hasSearchBlocks: boolean;
};

export function isServerToolUseBlock(block: unknown): block is ServerToolUseBlock {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "serverToolUse" &&
    typeof (block as { id?: unknown }).id === "string"
  );
}

export function isToolSearchResultBlock(block: unknown): block is ToolSearchResultBlock {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "toolSearchResult" &&
    typeof (block as { toolUseId?: unknown }).toolUseId === "string"
  );
}

export function collectToolSearchHistoryState(
  messages: readonly Message[],
): ToolSearchHistoryState {
  const referenced = new Set<string>();
  const called = new Set<string>();
  let hasSearchBlocks = false;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content as unknown[]) {
      if (isToolSearchResultBlock(block)) {
        hasSearchBlocks = true;
        for (const name of block.toolNames) {
          referenced.add(name);
        }
        for (const name of extractToolReferenceNames(block.content)) {
          referenced.add(name);
        }
      } else if (isServerToolUseBlock(block)) {
        hasSearchBlocks = true;
      } else if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "toolCall" &&
        typeof (block as { name?: unknown }).name === "string"
      ) {
        called.add((block as { name: string }).name);
      }
    }
  }
  return { referenced, called, hasSearchBlocks };
}

export type ToolDeferralPlan = {
  /** Names sent with `defer_loading: true`. */
  deferred: Set<string>;
  /** Search tool is sent iff something is deferred. */
  searchTool: WireToolSearchTool | undefined;
  /** True when every tool was flagged deferred and the guard un-deferred all of them. */
  guardTripped: boolean;
  /** Tools un-deferred on demand after the API rejected them as deferred (see forceLoaded). */
  rescued: string[];
};

/**
 * Decide the wire-level deferral for this request. A tool the model already
 * called, whose `tool_search_tool_result` is no longer in history (transcript
 * repair, a model switch), is un-deferred so the schema is visible again;
 * that changes the tools prefix once, which beats a tool the model can no
 * longer see. When the search result is still present the flags stay put and
 * the API expands the reference from history.
 */
export function planToolDeferral(params: {
  tools: readonly Tool[];
  searchEnabled: boolean;
  variant: AnthropicToolSearchVariant;
  history: ToolSearchHistoryState;
  /**
   * Names the API rejected as deferred earlier in this session (on-demand
   * rescue). Un-deferring a tool changes the tools array and therefore the
   * whole cached prefix, so it is never done preemptively: the API accepts a
   * direct `tool_use` of a deferred tool by name (observed live 2026-09-20),
   * and only a real 400 earns a rewrite.
   */
  forceLoaded?: ReadonlySet<string>;
}): ToolDeferralPlan {
  const deferred = new Set<string>();
  const rescued: string[] = [];
  if (!params.searchEnabled) {
    return { deferred, searchTool: undefined, guardTripped: false, rescued };
  }
  const registered = lookupDeferredNames(params.tools.map((tool) => tool.name));
  for (const tool of params.tools) {
    if (!isToolDeferLoading(tool) && !registered?.has(tool.name)) {
      continue;
    }
    if (params.forceLoaded?.has(tool.name)) {
      rescued.push(tool.name);
      continue;
    }
    deferred.add(tool.name);
  }
  if (deferred.size === 0) {
    return { deferred, searchTool: undefined, guardTripped: false, rescued };
  }
  if (deferred.size >= params.tools.length) {
    // Never defer everything: the API rejects it, and the search tool alone is
    // no substitute for a hot set. Fall back to loading all schemas.
    deferred.clear();
    return { deferred, searchTool: undefined, guardTripped: true, rescued };
  }
  return {
    deferred,
    searchTool: buildToolSearchToolDefinition(params.variant),
    guardTripped: false,
    rescued,
  };
}
