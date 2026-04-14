/**
 * Agent tool: on-demand skill-pipeline digest.
 *
 * Complements the scheduled daily fire (see src/memory/skill-pipeline-digest.ts)
 * by letting an agent answer "what did you do in the last N hours?" with
 * real data from the memory DB.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam } from "./common.js";

const DigestSchema = Type.Object({
  lookbackHours: Type.Optional(
    Type.Number({
      description: "Lookback window in hours. Default: 24. Min 1, max 168 (1 week).",
      minimum: 1,
      maximum: 168,
    }),
  ),
  deliver: Type.Optional(
    Type.Boolean({
      description:
        "If true, also deliver the digest through the configured channels (daily notes file, log, message). Default: false — just return the markdown.",
    }),
  ),
});

export function createSkillPipelineDigestTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }

  return {
    label: "Skill Pipeline Digest",
    name: "skill_pipeline_digest",
    description:
      "Render a human-readable summary of recent autonomous skill-pipeline activity: dream cycles, auto-generated skills, curiosity targets, marketplace movement, execution stats, and errors. Use this when the user asks 'what did you learn today?' or wants to know what the system has been doing in the background.",
    parameters: DigestSchema,
    execute: async (_toolCallId, params) => {
      const lookbackHours = readNumberParam(params, "lookbackHours") ?? 24;
      const deliver = params.deliver === true;

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ ok: false, error: error ?? "memory manager unavailable" });
      }

      if (typeof manager.runDigest !== "function") {
        return jsonResult({
          ok: false,
          error: "digest_unavailable",
          message: "The memory manager build does not support runDigest().",
        });
      }

      try {
        const result = await manager.runDigest({ deliver, lookbackHours });
        return jsonResult({
          ok: true,
          lookbackHours,
          delivered: deliver,
          markdown: result.markdown,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
