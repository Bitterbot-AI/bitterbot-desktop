/**
 * PLAN-52: which agent runtime drives a session.
 *
 * Since Phase 6 there is one: the owned runtime under `src/agents/runtime/`
 * ("bitterbot"). The config keys `agents.defaults.runtime.engine` and
 * `agents.list[].runtime.engine` are still accepted so existing configs
 * parse; a value of "pi" is ignored with one warning per process.
 */

import type { BitterbotConfig } from "../../config/config.js";
import type { AgentRuntimeEngine } from "../../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export type RuntimeEngine = AgentRuntimeEngine;

export const DEFAULT_RUNTIME_ENGINE: RuntimeEngine = "bitterbot";

const log = createSubsystemLogger("agents/runtime");

const warnedScopes = new Set<string>();

function warnPiRemoved(scope: string): void {
  if (warnedScopes.has(scope)) {
    return;
  }
  warnedScopes.add(scope);
  log.warn(`the pi engine was removed; ${scope} runs the owned runtime`);
}

/** @internal test seam */
export function __resetRuntimeEngineWarningsForTest(): void {
  warnedScopes.clear();
}

/**
 * Always the owned runtime. Reads the legacy keys only to warn once when a
 * config still names the removed engine.
 */
export function resolveRuntimeEngine(
  cfg: BitterbotConfig | undefined,
  agentId?: string,
): RuntimeEngine {
  const agents = cfg?.agents;
  if (agentId && Array.isArray(agents?.list)) {
    const id = normalizeAgentId(agentId);
    const entry = agents.list.find((candidate) => normalizeAgentId(candidate?.id) === id);
    if (entry?.runtime?.engine === "pi") {
      warnPiRemoved(`agent ${id}`);
      return DEFAULT_RUNTIME_ENGINE;
    }
  }
  if (agents?.defaults?.runtime?.engine === "pi") {
    warnPiRemoved("agents.defaults");
  }
  return DEFAULT_RUNTIME_ENGINE;
}
