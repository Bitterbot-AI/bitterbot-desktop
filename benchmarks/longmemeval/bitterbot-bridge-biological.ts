/**
 * Bitterbot Biological Bridge for LongMemEval
 *
 * Creates a FULL MemoryIndexManager with all biological subsystems active:
 * dream engine, reconsolidation, hormonal system, curiosity, knowledge graph,
 * spacing effect, synaptic tagging, Zeigarnik, prospective memory.
 *
 * Unlike the baseline bridge, this exercises the complete pipeline per question.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { readFileSync } from "node:fs";
import type { BitterbotConfig } from "../../src/config/types.js";
import type { KnowledgeGraphManager } from "../../src/memory/knowledge-graph.js";
import type { MemorySearchResult } from "../../src/memory/types.js";
import type { MemoryChunk } from "./adapter.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";
import { extractEntitiesFromSession } from "./entity-extractor.js";

// ── Types ──

export interface BiologicalBridge {
  /** Ingest a single markdown file into memory */
  ingestFile(filepath: string): Promise<void>;
  /**
   * Ingest a session file AND kick off LLM-driven entity/relationship
   * extraction in the background. The extraction promise is queued
   * with a concurrency cap; the caller must drain it via
   * `awaitPendingExtractions()` before search (typically after all
   * sessions are ingested).
   */
  ingestFileWithExtraction(filepath: string): Promise<void>;
  /**
   * Stage a file for batch ingestion: copy it into the workspace AND
   * queue background entity extraction, but do NOT trigger a sync.
   * The caller flushes the staged files via `flushStagedIngest()`.
   * This pattern lets the haystack be sync'd in ONE pass instead of
   * 50+ serial passes, which removes the dominant ingest bottleneck.
   */
  stageFileForBatchIngest(filepath: string): void;
  /**
   * Flush all staged files: run a single manager sync to index every
   * pending file in one pass. Returns sync stats.
   */
  flushStagedIngest(): Promise<{ syncMs: number; filesStaged: number }>;
  /**
   * Wait for all in-flight background extractions to complete and
   * return aggregate stats. Always call this between the ingest loop
   * and the search/answer step.
   */
  awaitPendingExtractions(): Promise<{
    entitiesAdded: number;
    relationshipsAdded: number;
    extractionMs: number;
    extractionCalls: number;
  }>;
  /** Current knowledge-graph stats (for monitoring). */
  graphStats(): { entities: number; relationships: number; active: number };
  /** Stimulate hormones from conversation text */
  stimulate(text: string): void;
  /** Run consolidation cycle */
  consolidate(): Record<string, unknown> | null;
  /** Run a full dream cycle */
  dream(): Promise<Record<string, unknown> | null>;
  /** Search memory with full pipeline (reconsolidation, mood-congruent retrieval) */
  search(query: string, opts?: { maxResults?: number }): Promise<MemoryChunk[]>;
  /** Get current hormonal state */
  hormonalState(): { dopamine: number; cortisol: number; oxytocin: number } | null;
  /** Generate LLM completion */
  complete(params: { model: string; prompt: string; maxTokens?: number }): Promise<string>;
  /** Reset memory for next question */
  reset(): Promise<void>;
  /** Cleanup everything */
  cleanup(): Promise<void>;
}

// ── Factory ──

export async function createBiologicalBenchmarkBridge(_opts: {
  model?: string;
}): Promise<BiologicalBridge> {
  const runId = randomUUID().slice(0, 8);
  const benchDir = join(__dirname, ".bench-runs-bio", runId);
  const workspaceDir = join(benchDir, "workspace");
  const memoryDir = join(workspaceDir, "memory");
  const storeDir = join(benchDir, "store");
  const storePath = join(storeDir, "benchmark.sqlite");
  const agentId = `bio-bench-${runId}`;

  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  // Write empty MEMORY.md
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Benchmark Memory\n", "utf-8");

  // Write a minimal GENOME.md for hormonal baseline calibration
  writeFileSync(
    join(workspaceDir, "GENOME.md"),
    `---
name: benchmark-agent
homeostasis:
  dopamine: 0.15
  cortisol: 0.02
  oxytocin: 0.10
---

# Benchmark Agent Genome

This agent is running a memory benchmark. It should be attentive, analytical, and detail-oriented.
`,
    "utf-8",
  );

  // Resolve API keys
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY env var is required for embeddings");
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();

  // Build a FULL BitterbotConfig with all subsystems enabled
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
          store: {
            path: storePath,
            vector: { enabled: true },
          },
          sync: {
            intervalMinutes: 0, // Manual sync only
            onSearch: false,
            onStartup: false,
          },
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
          // PLAN-18 benchmark refactor: batch embedding ON so manager.sync()
          // processes the 53-session haystack in batched OpenAI calls
          // instead of one embed-per-file. Removes the dominant ingest
          // bottleneck in the biological runner.
          batch: { enabled: true, wait: true },
          chunking: { tokens: 384, overlap: 48 },
        },
      },
      list: [{ id: agentId, default: true, workspace: workspaceDir }],
    },
    memory: {
      // Enable all biological subsystems
      consolidation: {
        enabled: true,
        intervalMinutes: 0, // Manual only
        decayRate: 0.05,
        forgetThreshold: 0.02,
        mergeOverlapThreshold: 0.92,
      },
      dream: {
        enabled: true,
        intervalMinutes: 0, // Manual only — we trigger dreams explicitly
        initialDelayMinutes: 9999, // Prevent auto-trigger
        maxLlmCallsPerCycle: 5,
        maxInsightsPerMode: 3,
        synthesisMode: "heuristic", // No LLM for dream synthesis (save API calls)
      },
      emotional: {
        enabled: true,
        hormonal: {
          enabled: true,
          homeostasis: {
            dopamine: 0.15,
            cortisol: 0.02,
            oxytocin: 0.1,
          },
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
    },
  } as BitterbotConfig;

  // Create the full manager with all subsystems
  const manager = await MemoryIndexManager.get({ cfg: config, agentId });
  if (!manager) {
    throw new Error("Failed to create MemoryIndexManager — check OPENAI_API_KEY");
  }

  // Initial sync to build meta record
  const markDirty = () => {
    (manager as unknown as { dirty: boolean }).dirty = true;
  };
  markDirty();
  await manager.sync({ reason: "bio-bench-init" });

  // LLM completion via direct fetch (same as baseline bridge)
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
        const body = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      return data.content?.[0]?.text ?? "";
    }

    // Fallback: OpenAI
    const modelName = model.replace("openai/", "");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: prompt }],
        max_tokens: tokens,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  };

  // ── Bridge interface ──

  // Reach into the manager for the knowledge graph instance — we need
  // direct write access for benchmark-time entity extraction.
  const getKnowledgeGraph = (): KnowledgeGraphManager | null => {
    return (manager as unknown as { knowledgeGraph: KnowledgeGraphManager | null }).knowledgeGraph;
  };

  // Concurrency-controlled background extraction state. Bounded at
  // EXTRACTION_CONCURRENCY parallel Haiku calls — keeps API throughput
  // up without saturating rate limits. Per-question stats reset on
  // `awaitPendingExtractions`.
  const EXTRACTION_CONCURRENCY = Number(process.env.LME_EXTRACTION_CONCURRENCY) || 5;
  let extractionSlotsInUse = 0;
  let pendingExtractions: Promise<void>[] = [];
  let extractionStats = {
    entitiesAdded: 0,
    relationshipsAdded: 0,
    extractionMs: 0,
    extractionCalls: 0,
  };
  let stagedFileCount = 0;

  const bridge: BiologicalBridge = {
    async ingestFile(filepath: string) {
      const basename = filepath.split("/").pop()!;
      copyFileSync(filepath, join(memoryDir, basename));
      markDirty();
      await manager.sync({ reason: "bio-bench-ingest" });
    },

    async ingestFileWithExtraction(filepath: string): Promise<void> {
      const basename = filepath.split("/").pop()!;
      copyFileSync(filepath, join(memoryDir, basename));
      markDirty();
      await manager.sync({ reason: "bio-bench-ingest" });

      const text = readFileSync(filepath, "utf-8");
      if (text.length <= 200) {
        return;
      }
      // Queue background extraction with a concurrency cap. The runner
      // drains via `awaitPendingExtractions` between ingest and search,
      // so all extractions finish before retrieval depends on them.
      const promise = (async () => {
        while (extractionSlotsInUse >= EXTRACTION_CONCURRENCY) {
          await new Promise((r) => setTimeout(r, 10));
        }
        extractionSlotsInUse++;
        const t0 = Date.now();
        try {
          const { entities, relationships } = await extractEntitiesFromSession(text, llmComplete);
          const kg = getKnowledgeGraph();
          if (kg && entities.length > 0) {
            const r = kg.ingestExtraction(entities, relationships, []);
            extractionStats.entitiesAdded += r.entitiesUpserted;
            extractionStats.relationshipsAdded += r.relationshipsUpserted;
          }
        } catch {
          // Extraction failures must not break the benchmark.
        } finally {
          extractionStats.extractionMs += Date.now() - t0;
          extractionStats.extractionCalls++;
          extractionSlotsInUse--;
        }
      })();
      pendingExtractions.push(promise);
    },

    stageFileForBatchIngest(filepath: string): void {
      const basename = filepath.split("/").pop()!;
      copyFileSync(filepath, join(memoryDir, basename));
      stagedFileCount++;
      // Kick off extraction immediately — it can run in parallel with
      // the deferred sync. The extraction doesn't depend on chunk IDs.
      const text = readFileSync(filepath, "utf-8");
      if (text.length <= 200) {
        return;
      }
      const promise = (async () => {
        while (extractionSlotsInUse >= EXTRACTION_CONCURRENCY) {
          await new Promise((r) => setTimeout(r, 10));
        }
        extractionSlotsInUse++;
        const t0 = Date.now();
        try {
          const { entities, relationships } = await extractEntitiesFromSession(text, llmComplete);
          const kg = getKnowledgeGraph();
          if (kg && entities.length > 0) {
            const r = kg.ingestExtraction(entities, relationships, []);
            extractionStats.entitiesAdded += r.entitiesUpserted;
            extractionStats.relationshipsAdded += r.relationshipsUpserted;
          }
        } catch {
          // Extraction failures must not break the benchmark.
        } finally {
          extractionStats.extractionMs += Date.now() - t0;
          extractionStats.extractionCalls++;
          extractionSlotsInUse--;
        }
      })();
      pendingExtractions.push(promise);
    },

    async flushStagedIngest() {
      const t0 = Date.now();
      const filesStaged = stagedFileCount;
      stagedFileCount = 0;
      if (filesStaged === 0) {
        return { syncMs: 0, filesStaged: 0 };
      }
      markDirty();
      await manager.sync({ reason: "bio-bench-batch-ingest" });
      return { syncMs: Date.now() - t0, filesStaged };
    },

    async awaitPendingExtractions() {
      if (pendingExtractions.length === 0) {
        return { ...extractionStats };
      }
      await Promise.all(pendingExtractions);
      pendingExtractions = [];
      const snapshot = { ...extractionStats };
      extractionStats = {
        entitiesAdded: 0,
        relationshipsAdded: 0,
        extractionMs: 0,
        extractionCalls: 0,
      };
      return snapshot;
    },

    graphStats() {
      const kg = getKnowledgeGraph();
      if (!kg) return { entities: 0, relationships: 0, active: 0 };
      const s = kg.getStats();
      return {
        entities: s.entityCount,
        relationships: s.relationshipCount,
        active: s.activeRelationships,
      };
    },

    stimulate(text: string) {
      try {
        (
          manager as unknown as { stimulateFromLiveMessage(t: string): void }
        ).stimulateFromLiveMessage(text);
      } catch {
        // Hormonal system may not be initialized — skip
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

    async dream() {
      try {
        return await (
          manager as unknown as { dream(): Promise<Record<string, unknown> | null> }
        ).dream();
      } catch {
        return null;
      }
    },

    async search(query: string, opts?: { maxResults?: number }) {
      // Retry with backoff — embedding API connections can break after heavy ingestion
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
      // Remove all session files (keep MEMORY.md and GENOME.md)
      const entries = readdirSync(memoryDir);
      for (const f of entries) {
        if (f === "MEMORY.md") {
          continue;
        }
        rmSync(join(memoryDir, f), { force: true });
      }
      markDirty();
      await manager.sync({ reason: "bio-bench-reset" });
    },

    async cleanup() {
      try {
        await manager.close();
      } catch {
        // ignore
      }
      rmSync(benchDir, { recursive: true, force: true });
    },
  };

  return bridge;
}
