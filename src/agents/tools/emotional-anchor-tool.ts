/**
 * Agent tools for emotional anchors: create_emotional_anchor and recall_emotional_anchor.
 * Allows the agent to consciously bookmark emotional moments and recall them later.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

const CreateAnchorSchema = Type.Object({
  label: Type.String({
    description:
      "Short label for this moment (e.g., 'GCCRF breakthrough', 'late night debugging')",
  }),
  description: Type.Optional(
    Type.String({
      description: "What made this moment significant",
    }),
  ),
});

const RecallAnchorSchema = Type.Object({
  anchor_id: Type.String({
    description: "ID of the anchor to recall",
  }),
  influence: Type.Optional(
    Type.Number({
      description: "How strongly to blend (0.0-1.0, default 0.3)",
    }),
  ),
});

function resolveAnchorToolContext(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) return null;
  if (cfg.memory?.emotional?.hormonal?.enabled === false) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;
  return { cfg, agentId };
}

export function createEmotionalAnchorTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveAnchorToolContext(options);
  if (!ctx) return null;
  const { cfg, agentId } = ctx;

  return {
    label: "Create Emotional Anchor",
    name: "create_emotional_anchor",
    description:
      "Bookmark the current emotional moment. Use when something significant happens — a breakthrough, a deep conversation, a stressful event. The anchor saves your current emotional state and can be recalled later.",
    parameters: CreateAnchorSchema,
    execute: async (_toolCallId, params) => {
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ created: false, error: error ?? "memory not available" });
      }

      try {
        if (!manager.createEmotionalAnchor) {
          return jsonResult({ created: false, error: "emotional anchors not available" });
        }

        const label = readStringParam(params as Record<string, unknown>, "label", { required: true });
        const description = readStringParam(params as Record<string, unknown>, "description");
        const anchor = manager.createEmotionalAnchor(label, description);

        if (!anchor) {
          return jsonResult({ created: false, error: "hormonal system not initialized" });
        }

        return jsonResult({
          created: true,
          anchor: { id: anchor.id, label: anchor.label },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ created: false, error: message });
      }
    },
  };
}

export function createRecallEmotionalAnchorTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveAnchorToolContext(options);
  if (!ctx) return null;
  const { cfg, agentId } = ctx;

  return {
    label: "Recall Emotional Anchor",
    name: "recall_emotional_anchor",
    description:
      "Recall a previously bookmarked emotional moment. Your current emotional state will blend with the remembered state. Use when you want to reconnect with a past emotional experience.",
    parameters: RecallAnchorSchema,
    execute: async (_toolCallId, params) => {
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ recalled: false, error: error ?? "memory not available" });
      }

      try {
        if (!manager.recallEmotionalAnchor) {
          return jsonResult({ recalled: false, error: "emotional anchors not available" });
        }

        const anchorId = readStringParam(params as Record<string, unknown>, "anchor_id", { required: true });
        const influence = readNumberParam(params as Record<string, unknown>, "influence");
        const success = manager.recallEmotionalAnchor(anchorId, influence ?? 0.3);

        if (!success) {
          return jsonResult({ recalled: false, error: "anchor not found" });
        }

        // Return the updated anchor list so the agent can see the effect
        const anchors = manager.listEmotionalAnchors?.() ?? [];
        return jsonResult({
          recalled: true,
          anchorId,
          influence: influence ?? 0.3,
          currentAnchors: anchors.slice(0, 5).map((a) => ({
            id: a.id,
            label: a.label,
            recallCount: a.recallCount,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ recalled: false, error: message });
      }
    },
  };
}
