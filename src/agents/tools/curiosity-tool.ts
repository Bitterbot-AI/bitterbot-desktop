/**
 * Agent tools for the Curiosity Engine: curiosity_state and curiosity_resolve.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readStringParam } from "./common.js";

const CuriosityStateSchema = Type.Object({});

const CuriosityResolveSchema = Type.Object({
  targetId: Type.String(),
});

function resolveCuriosityToolContext(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  if (!cfg.memory?.curiosity?.enabled) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export function createCuriosityStateTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveCuriosityToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;

  return {
    label: "Curiosity State",
    name: "curiosity_state",
    description:
      "View the Curiosity Engine's knowledge gaps, exploration targets, learning progress, and recent surprise assessments. Use to discover what should be investigated next.",
    parameters: CuriosityStateSchema,
    execute: async (_toolCallId, _params) => {
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ state: null, disabled: true, error });
      }

      try {
        if (!manager.curiosityState) {
          return jsonResult({ state: null, error: "curiosity engine not available" });
        }
        const state = manager.curiosityState();
        return jsonResult({ state });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ state: null, error: message });
      }
    },
  };
}

export function createCuriosityResolveTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveCuriosityToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;

  return {
    label: "Curiosity Resolve",
    name: "curiosity_resolve",
    description:
      "Mark an exploration target as resolved/addressed. Use after investigating a knowledge gap, contradiction, or frontier identified by the Curiosity Engine.",
    parameters: CuriosityResolveSchema,
    execute: async (_toolCallId, params) => {
      const targetId = readStringParam(params, "targetId", { required: true });

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ resolved: false, disabled: true, error });
      }

      try {
        if (!manager.curiosityResolve) {
          return jsonResult({ resolved: false, error: "curiosity engine not available" });
        }
        const resolved = manager.curiosityResolve(targetId);
        return jsonResult({ resolved, targetId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ resolved: false, error: message });
      }
    },
  };
}
