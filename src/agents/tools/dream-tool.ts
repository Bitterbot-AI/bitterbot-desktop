/**
 * Agent tools for the Dream Engine: dream_search and dream_status.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const DreamSearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const DreamStatusSchema = Type.Object({});

function resolveDreamToolContext(options: { config?: BitterbotConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) return null;
  if (!cfg.memory?.dream?.enabled) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;
  return { cfg, agentId };
}

export function createDreamSearchTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveDreamToolContext(options);
  if (!ctx) return null;
  const { cfg, agentId } = ctx;

  return {
    label: "Dream Search",
    name: "dream_search",
    description:
      "Search synthesized cross-domain insights from the Dream Engine. Returns pattern connections discovered across accumulated memories during offline dream cycles.",
    parameters: DreamSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 10;
      const minScore = readNumberParam(params, "minScore") ?? 0.3;

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ results: [], disabled: true, error });
      }

      try {
        if (!manager.dreamSearch) {
          return jsonResult({ results: [], error: "dream engine not available" });
        }
        const results = await manager.dreamSearch(query, { maxResults, minScore });
        return jsonResult({ results });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message });
      }
    },
  };
}

export function createDreamStatusTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveDreamToolContext(options);
  if (!ctx) return null;
  const { cfg, agentId } = ctx;

  return {
    label: "Dream Status",
    name: "dream_status",
    description:
      "Check the Dream Engine's current state, cycle history, and insight count. Use for observability into the dream synthesis process.",
    parameters: DreamStatusSchema,
    execute: async (_toolCallId, _params) => {
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ status: null, disabled: true, error });
      }

      try {
        if (!manager.dreamStatus) {
          return jsonResult({ status: null, error: "dream engine not available" });
        }
        const status = manager.dreamStatus();
        return jsonResult({ status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ status: null, error: message });
      }
    },
  };
}
