/**
 * PLAN-52: which agent runtime drives a session.
 *
 * `agents.list[].runtime.engine` overrides `agents.defaults.runtime.engine`;
 * the default is "pi" until the Phase 6 soak gates hold. The engine never
 * changes the transcript format, so an agent can be switched either way
 * between turns.
 */

import type { BitterbotConfig } from "../../config/config.js";
import type { AgentRuntimeEngine } from "../../config/types.agent-defaults.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export type RuntimeEngine = AgentRuntimeEngine;

export const DEFAULT_RUNTIME_ENGINE: RuntimeEngine = "pi";

function asEngine(value: unknown): RuntimeEngine | undefined {
  return value === "pi" || value === "bitterbot" ? value : undefined;
}

export function resolveRuntimeEngine(
  cfg: BitterbotConfig | undefined,
  agentId?: string,
): RuntimeEngine {
  const agents = cfg?.agents;
  if (agentId && Array.isArray(agents?.list)) {
    const id = normalizeAgentId(agentId);
    const entry = agents.list.find((candidate) => normalizeAgentId(candidate?.id) === id);
    const perAgent = asEngine(entry?.runtime?.engine);
    if (perAgent) {
      return perAgent;
    }
  }
  return asEngine(agents?.defaults?.runtime?.engine) ?? DEFAULT_RUNTIME_ENGINE;
}
