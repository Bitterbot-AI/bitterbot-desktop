/**
 * Dream Ablation Bridge
 *
 * Wraps the biological benchmark bridge with:
 * 1. Variant config application (deep-merge overrides)
 * 2. Dream metrics capture (modes run, insights, LLM calls)
 * 3. Memory metrics capture (chunk count, insight count, curiosity distribution)
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import type { BitterbotConfig } from "../../src/config/types.js";
import type { MemorySearchResult } from "../../src/memory/types.js";
import type { MemoryChunk } from "../longmemeval/adapter.js";
import type { VariantConfig } from "./variants.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";

// ── Types ──

export interface DreamCycleMetrics {
  modesRun: string[];
  insightsGenerated: number;
  llmCallsUsed: number;
  chunksAnalyzed: number;
}

export interface AggregatedDreamMetrics {
  totalCycles: number;
  totalInsights: number;
  totalLlmCalls: number;
  totalChunksAnalyzed: number;
  modeFrequency: Record<string, number>;
  perCycle: DreamCycleMetrics[];
}

export interface MemoryMetrics {
  totalChunks: number;
  activeChunks: number;
  archivedChunks: number;
  dreamInsights: number;
  avgCuriosityReward: number | null;
  avgImportanceScore: number;
}

export interface AblationBridge {
  ingestFile(filepath: string): Promise<void>;
  stimulate(text: string): void;
  consolidate(): Record<string, unknown> | null;
  dream(): Promise<DreamCycleMetrics | null>;
  search(query: string, opts?: { maxResults?: number }): Promise<MemoryChunk[]>;
  hormonalState(): { dopamine: number; cortisol: number; oxytocin: number } | null;
  complete(params: { model: string; prompt: string; maxTokens?: number }): Promise<string>;
  reset(): Promise<void>;
  cleanup(): Promise<void>;
  /** Aggregated dream metrics across all cycles in this question */
  getDreamMetrics(): AggregatedDreamMetrics;
  /** Snapshot of memory state (call after ingestion + dream) */
  getMemoryMetrics(): MemoryMetrics;
  /** Variant being tested */
  readonly variantId: string;
}

// ── Deep merge ──

function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object"
    ) {
      result[key] = deepMerge(
        base[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Baseline config (matches bitterbot-bridge-biological.ts) ──

function buildBaselineMemoryConfig(): Record<string, unknown> {
  return {
    consolidation: {
      enabled: true,
      intervalMinutes: 0,
      decayRate: 0.05,
      forgetThreshold: 0.02,
      mergeOverlapThreshold: 0.92,
    },
    dream: {
      enabled: true,
      intervalMinutes: 0,
      initialDelayMinutes: 9999,
      maxLlmCallsPerCycle: 5,
      maxInsightsPerMode: 3,
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
  };
}

// ── Factory ──

export async function createAblationBridge(
  variant: VariantConfig,
  opts: { model?: string } = {},
): Promise<AblationBridge> {
  const runId = randomUUID().slice(0, 8);
  const benchDir = join(__dirname, ".bench-runs", `${variant.id}-${runId}`);
  const workspaceDir = join(benchDir, "workspace");
  const memoryDir = join(workspaceDir, "memory");
  const storeDir = join(benchDir, "store");
  const storePath = join(storeDir, "benchmark.sqlite");
  const agentId = `ablation-${variant.id}-${runId}`;

  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  writeFileSync(join(memoryDir, "MEMORY.md"), "# Benchmark Memory\n", "utf-8");
  writeFileSync(
    join(workspaceDir, "GENOME.md"),
    `---\nname: benchmark-agent\nhomeostasis:\n  dopamine: 0.15\n  cortisol: 0.02\n  oxytocin: 0.10\n---\n\n# Benchmark Agent\n`,
    "utf-8",
  );

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY required");
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();

  // Deep-merge variant overrides with baseline memory config
  const baselineMemory = buildBaselineMemoryConfig();
  const mergedMemory = deepMerge(baselineMemory, variant.memoryOverrides);

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
            maxResults: 15,
            minScore: 0.0,
            importanceWeight: 0.2,
            hybrid: {
              enabled: true,
              mergeStrategy: "rrf",
              vectorWeight: 0.7,
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
    memory: mergedMemory,
  } as BitterbotConfig;

  const manager = await MemoryIndexManager.get({ cfg: config, agentId });
  if (!manager) {
    throw new Error("Failed to create MemoryIndexManager");
  }

  const markDirty = () => {
    (manager as unknown as { dirty: boolean }).dirty = true;
  };
  markDirty();
  await manager.sync({ reason: "ablation-init" });

  // Dream metrics accumulator
  let dreamMetrics: AggregatedDreamMetrics = {
    totalCycles: 0,
    totalInsights: 0,
    totalLlmCalls: 0,
    totalChunksAnalyzed: 0,
    modeFrequency: {},
    perCycle: [],
  };

  // LLM completion (same as biological bridge)
  const llmComplete = async ({
    model,
    prompt,
    maxTokens,
  }: {
    model: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<string> => {
    const tokens = maxTokens ?? 256;
    const isAnthropic = model.startsWith("anthropic/") || model.startsWith("claude-");

    if (isAnthropic && anthropicApiKey) {
      const modelName = model.replace("anthropic/", "");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: tokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      return data.content?.[0]?.text ?? "";
    }

    const modelName = model.replace("openai/", "");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiApiKey}` },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: prompt }],
        max_tokens: tokens,
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  };

  const bridge: AblationBridge = {
    variantId: variant.id,

    async ingestFile(filepath: string) {
      const basename = filepath.split("/").pop()!;
      copyFileSync(filepath, join(memoryDir, basename));
      markDirty();
      await manager.sync({ reason: "ablation-ingest" });
    },

    stimulate(text: string) {
      try {
        (
          manager as unknown as { stimulateFromLiveMessage(t: string): void }
        ).stimulateFromLiveMessage(text);
      } catch {
        /* skip */
      }
    },

    consolidate() {
      try {
        return (
          manager as unknown as { consolidate(): Record<string, unknown> | null }
        ).consolidate();
      } catch {
        return null;
      }
    },

    async dream(): Promise<DreamCycleMetrics | null> {
      try {
        const stats = await (
          manager as unknown as { dream(): Promise<Record<string, unknown> | null> }
        ).dream();
        if (!stats) {
          return null;
        }

        const cycle = stats.cycle as
          | { modesUsed?: string[]; llmCallsUsed?: number; chunksAnalyzed?: number }
          | undefined;
        const insights = stats.newInsights as unknown[] | undefined;

        const metrics: DreamCycleMetrics = {
          modesRun: cycle?.modesUsed ?? [],
          insightsGenerated: insights?.length ?? 0,
          llmCallsUsed: cycle?.llmCallsUsed ?? 0,
          chunksAnalyzed: cycle?.chunksAnalyzed ?? 0,
        };

        // Accumulate
        dreamMetrics.totalCycles++;
        dreamMetrics.totalInsights += metrics.insightsGenerated;
        dreamMetrics.totalLlmCalls += metrics.llmCallsUsed;
        dreamMetrics.totalChunksAnalyzed += metrics.chunksAnalyzed;
        for (const mode of metrics.modesRun) {
          dreamMetrics.modeFrequency[mode] = (dreamMetrics.modeFrequency[mode] ?? 0) + 1;
        }
        dreamMetrics.perCycle.push(metrics);

        return metrics;
      } catch {
        return null;
      }
    },

    async search(query: string, opts?: { maxResults?: number }): Promise<MemoryChunk[]> {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
          const results: MemorySearchResult[] = await manager.search(query, opts);
          return results.map((r) => ({
            id: `${r.path}:${r.startLine}-${r.endLine}`,
            text: r.snippet,
            score: r.score,
            path: r.path,
            startLine: r.startLine,
            endLine: r.endLine,
            source: r.source,
          }));
        } catch (err) {
          if (attempt === 2) {
            throw err;
          }
        }
      }
      return [];
    },

    hormonalState() {
      try {
        return (
          manager as unknown as {
            hormonalState(): { dopamine: number; cortisol: number; oxytocin: number } | null;
          }
        ).hormonalState();
      } catch {
        return null;
      }
    },

    complete: llmComplete,

    async reset() {
      const entries = readdirSync(memoryDir);
      for (const f of entries) {
        if (f === "MEMORY.md") {
          continue;
        }
        rmSync(join(memoryDir, f), { force: true });
      }
      markDirty();
      await manager.sync({ reason: "ablation-reset" });

      // Reset dream metrics for next question
      dreamMetrics = {
        totalCycles: 0,
        totalInsights: 0,
        totalLlmCalls: 0,
        totalChunksAnalyzed: 0,
        modeFrequency: {},
        perCycle: [],
      };
    },

    async cleanup() {
      try {
        manager.close();
      } catch {
        /* ignore */
      }
      rmSync(benchDir, { recursive: true, force: true });
    },

    getDreamMetrics(): AggregatedDreamMetrics {
      return { ...dreamMetrics };
    },

    getMemoryMetrics(): MemoryMetrics {
      try {
        const db = (manager as unknown as { db: import("node:sqlite").DatabaseSync }).db;

        const totalRow = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
        const activeRow = db
          .prepare(
            `SELECT COUNT(*) as c FROM chunks WHERE COALESCE(lifecycle_state, 'active') = 'active'`,
          )
          .get() as { c: number };
        const archivedRow = db
          .prepare(`SELECT COUNT(*) as c FROM chunks WHERE lifecycle_state = 'archived'`)
          .get() as { c: number };

        let dreamInsights = 0;
        try {
          dreamInsights =
            (db.prepare(`SELECT COUNT(*) as c FROM dream_insights`).get() as { c: number })?.c ?? 0;
        } catch {
          /* table may not exist */
        }

        let avgCuriosityReward: number | null = null;
        try {
          const row = db
            .prepare(
              `SELECT AVG(curiosity_reward) as avg FROM chunks WHERE curiosity_reward IS NOT NULL`,
            )
            .get() as { avg: number | null };
          avgCuriosityReward = row?.avg ?? null;
        } catch {
          /* column may not exist */
        }

        const avgImportance =
          (
            db
              .prepare(
                `SELECT AVG(importance_score) as avg FROM chunks WHERE COALESCE(lifecycle_state, 'active') = 'active'`,
              )
              .get() as { avg: number }
          )?.avg ?? 0;

        return {
          totalChunks: totalRow.c,
          activeChunks: activeRow.c,
          archivedChunks: archivedRow.c,
          dreamInsights,
          avgCuriosityReward,
          avgImportanceScore: avgImportance,
        };
      } catch {
        return {
          totalChunks: 0,
          activeChunks: 0,
          archivedChunks: 0,
          dreamInsights: 0,
          avgCuriosityReward: null,
          avgImportanceScore: 0,
        };
      }
    },
  };

  return bridge;
}
