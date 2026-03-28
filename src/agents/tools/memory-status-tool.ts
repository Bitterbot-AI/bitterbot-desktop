/**
 * Agent tool for introspecting the full memory pipeline status.
 * Exposes: crystal lifecycle counts, hormonal state, dream engine state,
 * curiosity summary, active goals, scheduler budgets, governance stats,
 * and user profile summary — all via a single `memory_status` call.
 *
 * Also supports a "sync" action to force re-index memory files.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult } from "./common.js";

const MemoryStatusSchema = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("sync")], {
      default: "status",
      description:
        "Action to perform: 'status' for pipeline introspection, 'sync' to force re-index memory files.",
    }),
  ),
});

function resolveMemoryStatusContext(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;
  return { cfg, agentId };
}

export function createMemoryStatusTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryStatusContext(options);
  if (!ctx) return null;
  const { cfg, agentId } = ctx;

  return {
    label: "Memory Status",
    name: "memory_status",
    description:
      "Introspect the full memory pipeline or force a re-sync. Actions: 'status' (default) returns crystal lifecycle counts, hormonal levels, dream engine state, curiosity targets, active goals, scheduler budgets, governance stats, and user profile. 'sync' forces re-indexing of all memory files.",
    parameters: MemoryStatusSchema,
    execute: async (_toolCallId, params) => {
      const action = params?.action ?? "status";

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ status: null, disabled: true, error });
      }

      if (action === "sync") {
        if (!manager.sync) {
          return jsonResult({ synced: false, error: "sync not supported by this memory backend" });
        }
        try {
          await manager.sync({ reason: "manual", force: true });
          const status = manager.status();
          return jsonResult({ synced: true, status });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ synced: false, error: message });
        }
      }

      try {
        const status = manager.status();
        return jsonResult({ status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ status: null, error: message });
      }
    },
  };
}
