/**
 * Tool cache integration — wraps tool execute() methods to check/populate
 * the in-memory LRU cache for cacheable tools.
 */

import type { AnyAgentTool } from "./pi-tools.types.js";
import type { ToolCache } from "./tool-cache.js";

/**
 * Wrap a tool with cache-checking behavior.
 * On cache hit, returns the cached result without calling execute().
 * On cache miss, calls execute() and stores the result.
 */
export function wrapToolWithCache(tool: AnyAgentTool, cache: ToolCache): AnyAgentTool {
  if (!cache.isCacheable(tool.name)) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, params, signal?, onUpdate?) => {
      const args = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;

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
  };
}

/**
 * Wrap all cacheable tools in an array with cache-checking behavior.
 * Non-cacheable tools are returned unmodified.
 */
export function wrapToolsWithCache(tools: AnyAgentTool[], cache: ToolCache): AnyAgentTool[] {
  return tools.map((tool) => wrapToolWithCache(tool, cache));
}
