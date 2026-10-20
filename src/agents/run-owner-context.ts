/**
 * Owner status of the run a tool call belongs to, carried to the runs that
 * tool call starts.
 *
 * Owner-only tools (`tool-policy.ts`) are removed for a sender who is not an
 * owner. Without this, that sender could ask the agent to spawn a sub-agent,
 * message another session, or schedule a wakeup: each of those starts a new
 * run through the gateway `agent` method, which treats its caller as the
 * operator, so the new run had every owner-only tool back.
 *
 * A tool call of a non-owner run executes inside this context, and the code
 * that starts follow-on runs marks them `senderIsOwner: false`. The flag only
 * lowers privilege: no context, or an owner context, changes nothing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { carryToolMarkers, type AnyAgentTool } from "./agent-tools.types.js";

const storage = new AsyncLocalStorage<{ senderIsOwner: boolean }>();

export function runInOwnerContext<T>(senderIsOwner: boolean, fn: () => T): T {
  return storage.run({ senderIsOwner }, fn);
}

/** True only inside a tool call of a run whose sender is not an owner. */
export function currentRunIsNonOwner(): boolean {
  return storage.getStore()?.senderIsOwner === false;
}

/**
 * Params for a gateway `agent` call made on behalf of the current tool call:
 * marked non-owner when the calling run is.
 */
export function inheritRunOwner<T extends Record<string, unknown>>(
  params: T,
): T & { senderIsOwner?: false } {
  return currentRunIsNonOwner() ? { ...params, senderIsOwner: false } : params;
}

export function wrapToolWithOwnerContext(tool: AnyAgentTool, senderIsOwner: boolean): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return carryToolMarkers<AnyAgentTool>(tool, {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      runInOwnerContext(senderIsOwner, () => execute(toolCallId, params, signal, onUpdate)),
  });
}
