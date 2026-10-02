/**
 * Tool cache integration — wraps tool execute() methods to check/populate
 * the in-memory LRU cache for cacheable tools.
 */

import type { AnyAgentTool } from "./agent-tools.types.js";
import { carryToolMarkers } from "./agent-tools.types.js";
import type { ToolCache } from "./tool-cache.js";

/** Part of every cache key when a scope is given; not a tool argument. */
const CACHE_SCOPE_KEY = "\u0000scope";

/**
 * Wrap a tool with cache-checking behavior.
 * On cache hit, returns the cached result without calling execute().
 * On cache miss, calls execute() and stores the result.
 */
export function wrapToolWithCache(
  tool: AnyAgentTool,
  cache: ToolCache,
  /**
   * What the result depends on besides the arguments: the agent and its
   * workspace. The cache is one per process, so without it two agents asking
   * the same thing (the same relative path, the same memory query) got each
   * other's result.
   */
  scope?: string,
): AnyAgentTool {
  if (!cache.isCacheable(tool.name)) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return carryToolMarkers(tool, {
    ...tool,
    execute: async (toolCallId, params, signal?, onUpdate?) => {
      const rawArgs = (params && typeof params === "object" ? params : {}) as Record<
        string,
        unknown
      >;
      const args = scope ? { ...rawArgs, [CACHE_SCOPE_KEY]: scope } : rawArgs;

      // Check cache
      const cached = cache.get(tool.name, args);
      if (cached !== undefined) {
        return cached as Awaited<ReturnType<NonNullable<AnyAgentTool["execute"]>>>;
      }

      // Execute and cache result
      const result = await execute(toolCallId, params, signal, onUpdate);
      cache.set(tool.name, args, result);
      return result;
    },
  });
}

/**
 * Wrap all cacheable tools in an array with cache-checking behavior.
 * Non-cacheable tools are returned unmodified.
 */
export function wrapToolsWithCache(
  tools: AnyAgentTool[],
  cache: ToolCache,
  scope?: string,
): AnyAgentTool[] {
  return tools.map((tool) => wrapToolWithCache(tool, cache, scope));
}
