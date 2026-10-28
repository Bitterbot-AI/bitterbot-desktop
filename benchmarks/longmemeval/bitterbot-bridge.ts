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
import type { DatabaseSync } from "node:sqlite";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/io.js";
import type { BitterbotConfig } from "../../src/config/types.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";
import type { MemorySearchResult } from "../../src/memory/types.js";

// ── Types ──

export interface BenchmarkBridge {
  memory: BenchmarkMemoryManager;
  llm: BenchmarkLlmProvider;
  cleanup(): Promise<void>;
}

export interface BenchmarkMemoryManager {
  /** `now` = the instant the question is asked (epoch ms); boosts measure age from it. */
  search(
    query: string,
    opts?: { maxResults?: number; now?: number },
  ): Promise<MemorySearchResult[]>;
  /**
   * Back-date the chunks of each ingested file to the time the conversation
   * happened, so age-dependent scoring sees the history's own timeline rather
   * than the ingest wall clock. Keys are file basenames as passed to ingest.
   */
  setChunkTimestamps(timestamps: Record<string, number>): number;
  sync(opts?: { reason?: string }): Promise<void>;
  ingestMarkdownFiles(files: string[]): Promise<void>;
  /** Retry embeddings for chunks a transient failure left pending; returns what is still pending. */
  drainPendingEmbeddings(maxPasses?: number): Promise<{ embedded: number; remaining: number }>;
  reset(): Promise<void>;
}

export interface BenchmarkLlmProvider {
  complete(params: {
    model: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
}

export interface BenchmarkBridgeOptions {
  /**
   * `query.postFusionBoostScale` for the run. Omitted = the legacy pin of 1
   * every saved retrieval run used; `"production"` = leave the key unset so
   * the shipped default applies (what an official-protocol run must measure).
   */
  postFusionBoostScale?: number | "production";
  /** `query.maxResults` default for searches that do not pass one. */
  maxResults?: number;
}

/**
 * API keys: environment first, then the operator's normal auth path (the same
 * resolution the gateway uses), so a benchmark never needs keys pasted into a
 * shell.
 */
async function resolveKey(provider: "openai" | "anthropic"): Promise<string | undefined> {
  const env = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (env?.trim()) {
    return env.trim();
  }
  try {
    const resolved = await resolveApiKeyForProvider({ provider, cfg: loadConfig() });
    return resolved?.apiKey ?? undefined;
  } catch {
    return undefined;
  }
}

// ── Factory ──

export async function createBenchmarkMemoryManager(
  options: BenchmarkBridgeOptions = {},
): Promise<BenchmarkBridge> {
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

  // Resolve API keys: env, else the operator's configured auth profiles.
  const openaiApiKey = await resolveKey("openai");
  if (!openaiApiKey) {
    throw new Error(
      "no OpenAI key: set OPENAI_API_KEY or configure the openai provider (embeddings need it)",
    );
  }
  const anthropicApiKey = await resolveKey("anthropic");

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
            maxResults: options.maxResults ?? 15,
            minScore: 0.0,
            importanceWeight: 0.15,
            hybrid: {
              enabled: true,
              mergeStrategy: "rrf",
              vectorWeight: 0.7,
              keywordWeight: 0.3,
              candidateMultiplier: 5,
            },
            // Legacy retrieval runs pinned the full boosts (scale 1) so every
            // saved run stays comparable. The official runner asks for
            // "production" so the shipped default is what gets measured, and
            // passes the question date as `now` so the boosts see 2023 as 2023.
            ...(options.postFusionBoostScale === "production"
              ? {}
              : { postFusionBoostScale: options.postFusionBoostScale ?? 1 }),
          },
          cache: { enabled: false },
          fts: { enabled: true },
          batch: { enabled: false },
          chunking: { tokens: 384, overlap: 48 },
        },
      },
      list: [{ id: agentId, default: true, workspace: workspaceDir }],
    },
    // Retrieval baseline = raw store + search. Without these switches the
    // manager starts the dream engine (trigger-on-start cycle, emotional
    // mini-dreams), consolidation, curiosity and the health sweep inside the
    // benchmark process: minutes per question, LLM calls on the operator's
    // key, and a score that is no longer "raw mode". The biological runner
    // has its own bridge for that comparison.
    memory: {
      dream: { enabled: false },
      consolidation: { enabled: false },
      curiosity: { enabled: false },
      emotional: { enabled: false },
      healthSweep: { enabled: false },
      coverageDiagnostics: { enabled: false },
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
    temperature,
  }: {
    model: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> => {
    const isAnthropic = model.startsWith("anthropic/") || model.startsWith("claude-");
    const tokens = maxTokens ?? 256;
    const sampling = temperature === undefined ? {} : { temperature };

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
          ...sampling,
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
        ...sampling,
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

      setChunkTimestamps(timestamps) {
        const db = (manager as unknown as { db: DatabaseSync }).db;
        const stmt = db.prepare(
          `UPDATE chunks SET created_at = ?, updated_at = ?
             WHERE source = 'memory' AND (path = ? OR path LIKE ?)`,
        );
        let changed = 0;
        for (const [basename, epochMs] of Object.entries(timestamps)) {
          const r = stmt.run(epochMs, epochMs, basename, `%/${basename}`);
          changed += Number(r.changes);
        }
        return changed;
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

      async drainPendingEmbeddings(maxPasses = 4) {
        // A transient embedding failure leaves chunks pending (model='pending');
        // left that way they are invisible to the vector channel and the run
        // measures the API's mood, not retrieval. Retry until none remain or
        // the passes run out, and report what is still pending.
        const backfill = (
          manager as unknown as {
            backfillPendingEmbeddings?: (o?: {
              limit?: number;
            }) => Promise<{ embedded: number; remaining: number }>;
          }
        ).backfillPendingEmbeddings;
        if (!backfill) {
          return { embedded: 0, remaining: -1 };
        }
        let embedded = 0;
        let remaining = -1;
        for (let pass = 0; pass < maxPasses; pass++) {
          const r = await backfill.call(manager, { limit: 5000 });
          embedded += r.embedded;
          remaining = r.remaining;
          if (remaining === 0) {
            break;
          }
        }
        return { embedded, remaining };
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
