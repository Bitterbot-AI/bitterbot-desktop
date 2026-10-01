import type { AgentTool } from "@mariozechner/pi-agent-core";

// oxlint-disable-next-line typescript/no-explicit-any
export type AnyAgentTool = AgentTool<any, unknown>;

/**
 * Carry wrapper markers across a rebuilt tool object.
 *
 * Tool wrappers tag their output with a non-enumerable symbol property
 * (`BEFORE_TOOL_CALL_WRAPPED`, `ENFORCER_WRAPPED`) so a later stage can ask
 * "was this already wrapped?". Object spread does NOT copy non-enumerable
 * symbols, so every wrapper that rebuilds the tool with `{ ...tool }` silently
 * erased those tags.
 *
 * That is not cosmetic: with the before-tool-call tag erased,
 * `toToolDefinitions` believed the tool was unwrapped and ran the hook itself
 * WITHOUT the session context — so every PLAN-20 interceptor fired under
 * sessionKey `"__anon__"` (and fired twice), and the outcome backfill, which
 * matches records by session key, could never tag a single record.
 */
export function carryToolMarkers<T extends object>(source: object, target: T): T {
  for (const sym of Object.getOwnPropertySymbols(source)) {
    if (Object.prototype.hasOwnProperty.call(target, sym)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, sym);
    if (descriptor) {
      Object.defineProperty(target, sym, descriptor);
    }
  }
  return target;
}
