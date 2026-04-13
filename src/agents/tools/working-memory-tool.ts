/**
 * working_memory_note tool: Agent writes timestamped observations to
 * memory/scratch.md (the Write-Ahead Log). Fast, atomic, no conflict
 * with the dream engine. The next dream cycle will incorporate these
 * notes into MEMORY.md via the RLM state update.
 *
 * Also creates a crystal from the note for immediate searchability.
 *
 * Credit: Scratch Buffer WAL concept — BitterBot
 */

import { Type } from "@sinclair/typebox";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

const WorkingMemoryNoteSchema = Type.Object({
  note: Type.String(),
  importance: Type.Optional(Type.Number()),
  type: Type.Optional(
    Type.Union([
      Type.Literal("experience"),
      Type.Literal("directive"),
      Type.Literal("world_fact"),
      Type.Literal("mental_model"),
    ]),
  ),
});

/** Map epistemic types to crystal semantic types and layers */
const EPISTEMIC_TYPE_MAP: Record<string, { semanticType: string; epistemicLayer: string }> = {
  experience: { semanticType: "episode", epistemicLayer: "experience" },
  directive: { semanticType: "preference", epistemicLayer: "directive" },
  world_fact: { semanticType: "fact", epistemicLayer: "world_fact" },
  mental_model: { semanticType: "insight", epistemicLayer: "mental_model" },
};

function resolveWorkingMemoryToolContext(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}) {
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
  return { cfg, agentId };
}

export function createWorkingMemoryNoteTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveWorkingMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;

  return {
    label: "Working Memory Note",
    name: "working_memory_note",
    description:
      "Jot down an important observation to your scratch buffer (memory/scratch.md). " +
      "Your next dream cycle will incorporate it into your Working Memory (MEMORY.md). " +
      "Use this for things you must not forget between sessions: user preferences, " +
      "key decisions, names, deadlines, emotional context.",
    parameters: WorkingMemoryNoteSchema,
    execute: async (_toolCallId, params) => {
      const note = readStringParam(params, "note", { required: true });
      const importance = readNumberParam(params, "importance") ?? 0.7;
      const clampedImportance = Math.max(0, Math.min(1, importance));
      const epistemicType = readStringParam(params, "type") ?? "experience";
      const typeMapping = EPISTEMIC_TYPE_MAP[epistemicType] ?? EPISTEMIC_TYPE_MAP.experience!;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const memoryDir = path.join(workspaceDir, "memory");
      const scratchPath = path.join(memoryDir, "scratch.md");

      // Ensure memory directory exists
      if (!existsSync(memoryDir)) {
        mkdirSync(memoryDir, { recursive: true });
      }

      // Append timestamped note to scratch.md (WAL append — atomic)
      const timestamp = new Date().toISOString();
      const entry = `\n- [${timestamp}] (importance: ${clampedImportance.toFixed(1)}) ${note}\n`;

      if (!existsSync(scratchPath)) {
        appendFileSync(
          scratchPath,
          "# Scratch Buffer (Working Memory WAL)\n\nUnsynthesized notes — will be consumed by next dream cycle.\n",
        );
      }
      appendFileSync(scratchPath, entry);

      // Also create a crystal for immediate searchability
      let crystalCreated = false;
      try {
        const { manager } = await getMemorySearchManager({ cfg, agentId });
        if (manager) {
          const mgr = manager as unknown as {
            ingestScratchNote?: (
              text: string,
              importance: number,
              semanticType?: string,
              epistemicLayer?: string,
            ) => void;
          };
          if (typeof mgr.ingestScratchNote === "function") {
            mgr.ingestScratchNote(
              note,
              clampedImportance,
              typeMapping.semanticType,
              typeMapping.epistemicLayer,
            );
            crystalCreated = true;
          }
        }
      } catch {
        // Non-critical: the note is safely in scratch.md regardless
      }

      return jsonResult({
        ok: true,
        scratchPath,
        timestamp,
        importance: clampedImportance,
        crystalCreated,
        message:
          "Note saved to scratch buffer. Will be incorporated into Working Memory on next dream cycle.",
      });
    },
  };
}
