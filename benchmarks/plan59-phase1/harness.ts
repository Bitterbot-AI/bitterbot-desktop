/**
 * PLAN-59 Phase 1: the manager-side harness.
 *
 * Opens a fork through the normal MemoryIndexManager under the frozen scoring
 * settings benchmarks/live-recall/evidence-gate.mts established (every
 * background engine off, recency boost off, hormonal state off, evidence
 * telemetry off, wall clock frozen for the duration of a query batch) and
 * turns each search into a QueryOutcome. Query embeddings are memoised
 * in-process by text, so every arm scores the same question with the same
 * vector and the embedding bill is one call per distinct question.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../../src/config/config.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../../src/memory/embeddings.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";
import type { MemorySearchResult } from "../../src/memory/types.js";
import { type Question, sha256 } from "./common.js";
import type { EmbedFn } from "./operations.js";
import { channelRanks, type QueryOutcome, type RankedResult, rankOf } from "./scoring.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";

/** In-process memo shared by every manager and by the operation embedder. */
export class EmbeddingMemo {
  private readonly cache = new Map<string, Promise<number[]>>();
  calls = 0;
  /** characters sent to the provider (cache misses only), for the token estimate */
  chars = 0;
  wrap(embed: (text: string) => Promise<number[]>): (text: string) => Promise<number[]> {
    return (text: string) => {
      const hit = this.cache.get(text);
      if (hit) return hit;
      this.calls += 1;
      this.chars += text.length;
      const p = embed(text).catch((err: unknown) => {
        this.cache.delete(text);
        throw err;
      });
      this.cache.set(text, p);
      return p;
    };
  }
  get size(): number {
    return this.cache.size;
  }
}

export async function makeEmbedder(params: {
  liveConfig: BitterbotConfig;
  apiKey: string;
  memo: EmbeddingMemo;
}): Promise<EmbedFn> {
  const result = await createEmbeddingProvider({
    config: params.liveConfig,
    provider: "openai",
    remote: { apiKey: params.apiKey },
    model: EMBEDDING_MODEL,
    fallback: "none",
  });
  const provider = result.provider;
  return params.memo.wrap((text) => provider.embedQuery(text, { feature: "plan59-phase1" }));
}

export function frozenConfig(params: {
  storePath: string;
  workspaceDir: string;
  agentId: string;
  apiKey: string;
  maxResults: number;
}): BitterbotConfig {
  return {
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: EMBEDDING_MODEL,
          remote: { apiKey: params.apiKey },
          sources: ["memory", "sessions"],
          store: { path: params.storePath, vector: { enabled: true } },
          sync: {
            intervalMinutes: 0,
            onSearch: false,
            onStartup: false,
            watch: false,
            onSessionStart: false,
          },
          query: {
            maxResults: params.maxResults,
            minScore: 0,
            hybrid: { enabled: true, mergeStrategy: "rrf", candidateMultiplier: 5 },
            recency: { enabled: false },
          },
        },
      },
      list: [{ id: params.agentId, default: false, workspace: params.workspaceDir }],
    },
    memory: {
      dream: { enabled: false },
      consolidation: { enabled: false },
      curiosity: { enabled: false, evidence: { mode: "off" } },
      emotional: { enabled: false, hormonal: { enabled: false } },
      healthSweep: { enabled: false },
      coverageDiagnostics: { enabled: false },
    },
  } as unknown as BitterbotConfig;
}

export type OpenStore = {
  manager: MemoryIndexManager;
  close: () => Promise<void>;
};

export async function openFrozenStore(params: {
  storePath: string;
  workDir: string;
  agentId: string;
  apiKey: string;
  maxResults: number;
  memo: EmbeddingMemo;
}): Promise<OpenStore> {
  const workspaceDir = join(params.workDir, "workspace", params.agentId);
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(join(workspaceDir, "memory", "MEMORY.md"), "# plan59 phase 1\n");
  const manager = await MemoryIndexManager.get({
    cfg: frozenConfig({ ...params, workspaceDir }),
    agentId: params.agentId,
  });
  if (!manager) {
    throw new Error("MemoryIndexManager.get returned null");
  }
  // Route this manager's query embeddings through the shared memo.
  const inner = manager as unknown as { provider: EmbeddingProvider };
  const original = inner.provider.embedQuery.bind(inner.provider);
  inner.provider.embedQuery = params.memo.wrap((text) => original(text));
  return { manager, close: () => manager.close() };
}

/**
 * Resolve search results to chunk ids the way the evidence gate and the
 * supersession tagger do: (path, start_line, end_line), disambiguated by the
 * snippet when a path holds several chunks on the same span (extracted facts
 * sit at 0/0). Returns null when still ambiguous.
 */
export function makeIdResolver(db: DatabaseSync): (r: MemorySearchResult) => string | null {
  const stmt = db.prepare(
    `SELECT id, text FROM chunks WHERE path = ? AND start_line = ? AND end_line = ? LIMIT 20`,
  );
  return (r) => {
    const rows = stmt.all(r.path, r.startLine, r.endLine) as unknown as Array<{
      id: string;
      text: string;
    }>;
    if (rows.length === 1) return rows[0]!.id;
    if (rows.length === 0) return null;
    const probe = r.snippet
      .replace(/^\.\.\.|\.\.\.$/g, "")
      .trim()
      .slice(0, 80);
    const match = rows.filter((row) => probe.length > 0 && row.text.includes(probe));
    return match.length === 1 ? match[0]!.id : null;
  };
}

export function parentMap(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(`SELECT id, parent_id FROM chunks WHERE parent_id IS NOT NULL`)
    .all() as unknown as Array<{ id: string; parent_id: string }>;
  return new Map(rows.map((r) => [r.id, r.parent_id]));
}

/**
 * Run a question batch against an open store with the wall clock frozen at
 * `now`. Latency is measured with performance.now(), which the freeze does not
 * touch.
 */
export async function runQueries(params: {
  store: OpenStore;
  storePath: string;
  questions: readonly Question[];
  now: number;
  maxResults: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<QueryOutcome[]> {
  const reader = new DatabaseSync(params.storePath, { readOnly: true });
  const resolve = makeIdResolver(reader);
  const parents = parentMap(reader);
  const realNow = Date.now;
  Date.now = () => params.now;
  const out: QueryOutcome[] = [];
  try {
    for (let i = 0; i < params.questions.length; i++) {
      const q = params.questions[i]!;
      const t0 = performance.now();
      const results = await params.store.manager.search(q.question, {
        maxResults: params.maxResults,
        now: params.now,
        observe: false,
        caller: "plan59_phase1",
      });
      const latencyMs = performance.now() - t0;
      const ranked: RankedResult[] = results.map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        id: resolve(r),
        channels: r.channels,
      }));
      const parentId = parents.get(q.chunkId) ?? null;
      const { raw, mapped } = rankOf(ranked, q, parentId);
      out.push({
        chunkId: q.chunkId,
        family: q.path,
        rawRank: raw,
        mappedRank: mapped,
        channelRanks: channelRanks(ranked, q, parentId),
        topTenIds: ranked
          .slice(0, 10)
          .map(
            (r) =>
              r.id ?? `unresolved_${sha256(`${r.path}:${r.startLine}:${r.endLine}`).slice(0, 16)}`,
          ),
        topOneFamily: ranked[0]?.path ?? null,
        returned: ranked.length,
        latencyMs,
      });
      params.onProgress?.(i + 1, params.questions.length);
    }
  } finally {
    Date.now = realNow;
    reader.close();
  }
  return out;
}
