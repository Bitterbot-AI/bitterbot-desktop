/**
 * Agent tool for on-demand Skill Seekers ingestion.
 *
 * Surfaces the SkillSeekersAdapter.ingestFromSource() capability so an agent
 * can explicitly generate a skill from a documentation URL mid-session — for
 * example when it encounters a library it has never seen before and wants to
 * learn before continuing.
 *
 * This is the complement to the dream engine's background exploration path:
 * the dream engine scrapes during sleep; this tool scrapes on demand.
 *
 * Built on Skill Seekers (https://github.com/yusufkaraaslan/Skill_Seekers) by
 * Yusuf Karaaslan, MIT License.
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readStringParam } from "./common.js";

const SkillSeekersIngestSchema = Type.Object({
  url: Type.String({
    description:
      "Documentation URL to scrape and convert into a skill. Must point to an authoritative source (official docs, GitHub repo, etc.).",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "Optional display name for the generated skill. Inferred from SKILL.md if omitted.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Optional one-line description. Pass this when the URL alone doesn't disambiguate the library (e.g. version-specific docs).",
    }),
  ),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("docs"),
        Type.Literal("github"),
        Type.Literal("pdf"),
        Type.Literal("video"),
        Type.Literal("codebase"),
      ],
      {
        description: "Source type hint for the scraper. Default: inferred from URL.",
      },
    ),
  ),
});

function resolveSkillSeekersToolContext(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  // Adapter is auto-loaded by the memory manager. If the user hasn't disabled
  // skill-seekers in config, the tool should be exposed — availability is
  // checked at execute-time and surfaced as an error payload if the CLI/MCP
  // isn't installed.
  if (cfg.skills?.skillSeekers?.enabled === false) {
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

export function createSkillSeekersIngestTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveSkillSeekersToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;

  return {
    label: "Skill Seekers: Ingest URL",
    name: "skill_seekers_ingest",
    description:
      "Generate a new skill on demand by scraping a documentation URL through Skill Seekers. Use this when you encounter an unfamiliar library, API, or tool and want to learn it before continuing. The generated skill is signed, enters quarantine by default, and expires according to your config's TTL. Respects the per-cycle budget shared with the dream engine.",
    parameters: SkillSeekersIngestSchema,
    execute: async (_toolCallId, params) => {
      const url = readStringParam(params, "url", { required: true });
      const name = readStringParam(params, "name");
      const description = readStringParam(params, "description");
      const typeHint = readStringParam(params, "type");

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        return jsonResult({ ok: false, error: error ?? "memory manager unavailable" });
      }

      const adapter = manager.getSkillSeekersAdapter?.();
      if (!adapter) {
        return jsonResult({
          ok: false,
          error: "skill_seekers_adapter_not_ready",
          message:
            "Skill Seekers adapter has not initialized yet. Retry in a moment, or check skills.skillSeekers.enabled in config.",
        });
      }

      try {
        const available = await adapter.isAvailable();
        if (!available) {
          return jsonResult({
            ok: false,
            error: "skill_seekers_disabled",
            message:
              "Skill Seekers is disabled in config. Set skills.skillSeekers.enabled = true to enable. For PDF/video/Jupyter/Confluence/Notion sources, also install the CLI (`pip install skill-seekers`) or configure skills.skillSeekers.mcpEndpoint.",
          });
        }

        const result = await adapter.ingestFromSource({
          url,
          name: name || undefined,
          description: description || undefined,
          type:
            (typeHint as "docs" | "github" | "pdf" | "video" | "codebase" | undefined) || undefined,
        });

        return jsonResult({
          ok: result.ok,
          error: result.error,
          transport: result.transport,
          elapsedMs: result.elapsedMs,
          skillsIngested: result.ingested.length,
          actions: result.ingested.map((r: { action: string; skillName?: string }) => ({
            action: r.action,
            name: r.skillName,
          })),
          conflicts: result.conflicts.length,
          highSeverityConflicts: result.conflicts.filter(
            (c: { severity: string }) => c.severity === "high",
          ).length,
          budgetRemaining: adapter.budgetRemaining(),
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
