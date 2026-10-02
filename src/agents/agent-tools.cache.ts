/**
 * Tool cache integration — wraps tool execute() methods to check/populate
 * the in-memory LRU cache for cacheable tools.
 */

import type { AnyAgentTool } from "./agent-tools.types.js";
import { carryToolMarkers } from "./agent-tools.types.js";
import type { ToolCache } from "./tool-cache.js";

/**
 * A tool that returns its failure instead of throwing (`{ error }`,
 * `{ status: "error" }`, `{ disabled: true }`). Caching that would repeat a
 * transient failure for the whole TTL.
 */
function reportsFailure(result: unknown): boolean {
  const details = (result as { details?: unknown } | null | undefined)?.details;
  if (!details || typeof details !== "object") {
    return false;
  }
  const record = details as Record<string, unknown>;
  return Boolean(record.error) || record.status === "error" || record.disabled === true;
}

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
   * What the result depends on besides the arguments: the agent, its
   * workspace, the session, and whether the session is sandboxed. The cache
   * is one per process, so without it two agents asking the same thing got
   * each other's result, and a sandboxed session could be served what an
   * unsandboxed one computed.
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
      if (!reportsFailure(result)) {
        cache.set(tool.name, args, result);
      }
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
