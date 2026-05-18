/**
 * MCP-server shared context.
 *
 * Boots a minimal `MemoryIndexManager` scoped to the agent dir
 * specified by `BITTERBOT_AGENT_DIR` (defaults to
 * `~/.bitterbot/agents/arc-agi-3`). Every default-on background
 * scheduler is explicitly disabled — cf. LongMemEval lessons about
 * trending-sweep / dream-research / digest firing uninvited during
 * benchmark runs.
 *
 * Returned context exposes the knowledge graph, curiosity engine,
 * epistemic-directive engine, hormonal state manager, and a callable
 * `sageRetrieve` over the same DB. Tools import this context.
 */

import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BitterbotConfig } from "../../../src/config/types.js";
import type { CuriosityEngine } from "../../../src/memory/curiosity-engine.js";
import type { EpistemicDirectiveEngine } from "../../../src/memory/epistemic-directives.js";
import type { HormonalStateManager } from "../../../src/memory/hormonal.js";
import type { KnowledgeGraphManager } from "../../../src/memory/knowledge-graph.js";
import { MemoryIndexManager } from "../../../src/memory/manager.js";
import { sageRetrieve, type SageConfig } from "../../../src/memory/sage-memory.js";

const DEFAULT_AGENT_DIR = "~/.bitterbot/agents/arc-agi-3";

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, p.slice(2));
  }
  return p;
}

export interface MemoryContext {
  manager: MemoryIndexManager;
  knowledgeGraph: KnowledgeGraphManager;
  curiosity: CuriosityEngine | null;
  directives: EpistemicDirectiveEngine | null;
  hormones: HormonalStateManager | null;
  db: DatabaseSync;
  agentDir: string;
  sageRetrieve: (query: string, cfg?: SageConfig) => ReturnType<typeof sageRetrieve>;
}

let _ctx: MemoryContext | null = null;

/** Get or create the shared MemoryContext. Lazy + singleton. */
export async function getMemoryContext(): Promise<MemoryContext> {
  if (_ctx) {
    return _ctx;
  }
  const rawDir = process.env.BITTERBOT_AGENT_DIR ?? DEFAULT_AGENT_DIR;
  const agentDir = expandHome(rawDir);
  const workspaceDir = path.join(agentDir, "workspace");
  const memoryDir = path.join(workspaceDir, "memory");
  const storeDir = path.join(agentDir, "store");
  const storePath = path.join(storeDir, "memory.sqlite");

  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  if (!existsSync(path.join(memoryDir, "MEMORY.md"))) {
    writeFileSync(path.join(memoryDir, "MEMORY.md"), "# ARC-AGI-3 Agent Memory\n", "utf8");
  }

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY required for embedding-backed retrieval inside the bitterbot-memory MCP server.",
    );
  }

  const agentId = "arc-agi-3";

  // Minimal config — explicitly disables every default-on scheduler so
  // the MCP server process doesn't quietly fire dream cycles, digest,
  // or skill-seekers trending sweeps in the background.
  const config: BitterbotConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          remote: { apiKey: openaiApiKey },
          sources: ["memory"],
          store: { path: storePath, vector: { enabled: true } },
          sync: { intervalMinutes: 0, onSearch: false, onStartup: false },
          query: {
            maxResults: 20,
            minScore: 0.0,
            importanceWeight: 0.2,
            hybrid: {
              enabled: true,
              mergeStrategy: "rrf",
              vectorWeight: 0.6,
              keywordWeight: 0.3,
              candidateMultiplier: 5,
            },
          },
          cache: { enabled: false },
          fts: { enabled: true },
          batch: { enabled: false },
          chunking: { tokens: 384, overlap: 48 },
        },
      },
      list: [{ id: agentId, default: true, workspace: workspaceDir }],
    },
    memory: {
      consolidation: { enabled: true, intervalMinutes: 0 },
      dream: {
        enabled: false,
        intervalMinutes: 0,
        initialDelayMinutes: 9999,
        synthesisMode: "heuristic",
      },
      emotional: {
        enabled: true,
        hormonal: {
          enabled: true,
          homeostasis: { dopamine: 0.15, cortisol: 0.02, oxytocin: 0.1 },
        },
        decayResistance: 0.5,
      },
      curiosity: { enabled: true },
      governance: { enabled: true },
      reconsolidation: { enabled: true },
      knowledgeGraph: { enabled: true },
      spacingEffect: { enabled: true },
      zeigarnik: { enabled: true },
      prospective: { enabled: true },
      digest: { enabled: false },
    },
    skills: {
      skillSeekers: { trending: { enabled: false } },
    },
  } as BitterbotConfig;

  const manager = await MemoryIndexManager.get({ cfg: config, agentId });
  if (!manager) {
    throw new Error("Failed to create MemoryIndexManager for bitterbot-memory MCP server");
  }
  // Initial sync to ensure schema is created and MEMORY.md is indexed.
  (manager as unknown as { dirty: boolean }).dirty = true;
  await manager.sync({ reason: "mcp-server-init" });

  const internal = manager as unknown as {
    db: DatabaseSync;
    knowledgeGraph: KnowledgeGraphManager;
    curiosityEngine: CuriosityEngine | null;
    epistemicDirectiveEngine: EpistemicDirectiveEngine | null;
    hormonalManager: HormonalStateManager | null;
  };
  if (!internal.knowledgeGraph) {
    throw new Error("MemoryIndexManager did not expose knowledgeGraph");
  }
  _ctx = {
    manager,
    knowledgeGraph: internal.knowledgeGraph,
    curiosity: internal.curiosityEngine ?? null,
    directives: internal.epistemicDirectiveEngine ?? null,
    hormones: internal.hormonalManager ?? null,
    db: internal.db,
    agentDir,
    sageRetrieve: (query, cfg) => sageRetrieve(internal.db, internal.knowledgeGraph, query, cfg),
  };
  return _ctx;
}

/** Visible for tests. */
export function _resetMemoryContext(): void {
  _ctx = null;
}
