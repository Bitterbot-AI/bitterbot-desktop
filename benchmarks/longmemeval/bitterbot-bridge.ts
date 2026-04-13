/**
 * Bitterbot Bridge for LongMemEval
 *
 * Creates an isolated memory manager instance for benchmark evaluation.
 * This bridges the LongMemEval runner with Bitterbot's internal memory APIs.
 *
 * The bridge creates a temporary workspace and database per evaluation run,
 * ensuring no cross-contamination with the user's actual memory.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Bitterbot internal imports
import type { BitterbotConfig } from "../../src/config/types.js";
import type { MemorySearchResult } from "../../src/memory/types.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";

// ── Types ──

export interface BenchmarkBridge {
  memory: BenchmarkMemoryManager;
  llm: BenchmarkLlmProvider;
  cleanup(): Promise<void>;
}

export interface BenchmarkMemoryManager {
  search(query: string, opts?: { maxResults?: number }): Promise<MemorySearchResult[]>;
  sync(opts?: { reason?: string }): Promise<void>;
  ingestMarkdownFiles(files: string[]): Promise<void>;
  reset(): Promise<void>;
}

export interface BenchmarkLlmProvider {
  complete(params: { model: string; prompt: string; maxTokens?: number }): Promise<string>;
}

// ── Factory ──

export async function createBenchmarkMemoryManager(): Promise<BenchmarkBridge> {
  const runId = randomUUID().slice(0, 8);
  const benchDir = join(__dirname, ".bench-runs", runId);
  const workspaceDir = join(benchDir, "workspace");
  const memoryDir = join(workspaceDir, "memory");
  const storeDir = join(benchDir, "store");
  const storePath = join(storeDir, "benchmark.sqlite");

  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  // Write an empty MEMORY.md so the workspace is recognized
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Benchmark Memory\n", "utf-8");

  // Resolve API keys from env
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY env var is required for LongMemEval embeddings");
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();

  // Use the static factory — this creates the embedding provider and DB properly
  const agentId = `benchmark-${runId}`;

  // Build a BitterbotConfig that routes everything to our temp dirs.
  // The key fields: agents.defaults.workspace → our temp workspace,
  // and agents.defaults.memorySearch.store.path → our temp SQLite location.
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
            intervalMinutes: 0,
            onSearch: false,
            onStartup: false,
          },
          query: {
            maxResults: 15,
            minScore: 0.0,
            importanceWeight: 0.15,
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
  } as BitterbotConfig;

  const manager = await MemoryIndexManager.get({ cfg: config, agentId });
  if (!manager) {
    throw new Error("Failed to create MemoryIndexManager — check that OPENAI_API_KEY is set");
  }

  // Create LLM provider — supports both Anthropic and OpenAI via direct fetch
  const llmComplete = async ({
    model,
    prompt,
    maxTokens,
  }: {
    model: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<string> => {
    const isAnthropic = model.startsWith("anthropic/") || model.startsWith("claude-");
    const tokens = maxTokens ?? 256;

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

  // Poke the manager's internal dirty flag so sync scans files
  // without triggering the expensive full-reindex path.
  const markDirty = () => {
    (manager as unknown as { dirty: boolean }).dirty = true;
  };

  // Do the initial sync to index MEMORY.md and build the meta record
  markDirty();
  await manager.sync({ reason: "longmemeval-init" });

  const bridge: BenchmarkBridge = {
    memory: {
      async search(query, opts) {
        return manager.search(query, opts);
      },

      async sync(opts) {
        await manager.sync(opts);
      },

      async ingestMarkdownFiles(files: string[]) {
        // Copy files into the workspace/memory/ dir so the manager's sync picks them up
        for (const file of files) {
          const basename = file.split("/").pop()!;
          copyFileSync(file, join(memoryDir, basename));
        }
        // Set the dirty flag so sync scans files without triggering a full reindex
        markDirty();
        await manager.sync({ reason: "longmemeval-ingest" });
      },

      async reset() {
        // Remove all ingested files from workspace/memory (keep MEMORY.md)
        const entries = readdirSync(memoryDir);
        for (const f of entries) {
          if (f === "MEMORY.md") {
            continue;
          }
          rmSync(join(memoryDir, f), { force: true });
        }
        // Mark dirty so sync picks up the file deletions
        markDirty();
        await manager.sync({ reason: "longmemeval-reset" });
      },
    },

    llm: {
      complete: llmComplete,
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
