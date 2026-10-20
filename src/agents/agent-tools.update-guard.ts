/**
 * A tool's progress callback is valid only while its call is in flight.
 *
 * The shell tool keeps streaming a command's output after it has handed the
 * command to the background and returned. Each late chunk called the progress
 * callback of a tool call that was long finished. pi-agent-core 0.73 turns
 * that callback into an agent event, and its agent throws "Agent listener
 * invoked outside active run" when no run is active; nothing awaits that
 * promise, so the unhandled rejection took the gateway down (seen on
 * 2026-10-02: `sleep 90 && echo finished`, turn ended, 90 s later the
 * gateway exited). The owned loop already ignores updates after a call
 * settles; this guard gives every engine and every tool the same rule.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { carryToolMarkers, type AnyAgentTool } from "./agent-tools.types.js";

const log = createSubsystemLogger("agents/tools");

export function wrapToolWithUpdateGuard(tool: AnyAgentTool): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return carryToolMarkers<AnyAgentTool>(tool, {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (!onUpdate) {
        return await execute(toolCallId, params, signal, onUpdate);
      }
      let settled = false;
      const guarded: typeof onUpdate = (partialResult) => {
        if (settled) {
          return;
        }
        try {
          onUpdate(partialResult);
        } catch (err) {
          // A progress update must never fail the tool call it reports on.
          log.debug(`tool "${tool.name}" progress update dropped: ${String(err)}`);
        }
      };
      try {
        return await execute(toolCallId, params, signal, guarded);
      } finally {
        settled = true;
      }
    },
  });
}
