/**
 * The compaction policy and offload settings in effect for one agent:
 * `agents.list[].compaction` layered field-wise over
 * `agents.defaults.compaction`. Lets one agent run the `offload` policy while
 * the others stay on `summary` (and the reverse).
 */

import type { BitterbotConfig } from "../../../config/config.js";
import type {
  AgentCompactionOffloadConfig,
  AgentCompactionPolicy,
} from "../../../config/types.agent-defaults.js";
import { normalizeAgentId } from "../../../routing/session-key.js";

export type ResolvedAgentCompaction = {
  policy: AgentCompactionPolicy;
  offload: AgentCompactionOffloadConfig;
};

export function resolveAgentCompaction(
  cfg: BitterbotConfig | undefined,
  agentId?: string | null,
): ResolvedAgentCompaction {
  const defaults = cfg?.agents?.defaults?.compaction;
  const wanted = agentId ? normalizeAgentId(agentId) : undefined;
  const entry = wanted
    ? (cfg?.agents?.list ?? []).find((agent) => normalizeAgentId(agent.id) === wanted)?.compaction
    : undefined;
  return {
    policy: entry?.policy ?? defaults?.policy ?? "summary",
    offload: { ...defaults?.offload, ...entry?.offload },
  };
}
