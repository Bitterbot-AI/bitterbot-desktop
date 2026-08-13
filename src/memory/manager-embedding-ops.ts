// @ts-nocheck
// oxlint-disable eslint/no-unused-vars, typescript/no-explicit-any
import fs from "node:fs/promises";
import type { CrystalOrigin } from "./crystal-types.js";
import type { HormonalInfluence } from "./crystal-types.js";
import type { SessionFileEntry } from "./session-files.js";
import type { MemorySource } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./batch-gemini.js";
import {
  OPENAI_BATCH_ENDPOINT,
  type OpenAiBatchRequest,
  runOpenAiEmbeddingBatches,
} from "./batch-openai.js";
import { type VoyageBatchRequest, runVoyageEmbeddingBatches } from "./batch-voyage.js";
import { inferSemanticType, defaultGovernance } from "./crystal.js";
import { enforceEmbeddingMaxInputTokens } from "./embedding-chunk-limits.js";
import { estimateUtf8Bytes } from "./embedding-input-limits.js";
import { yieldToEventLoop } from "./event-loop.js";
import {
  chunkMarkdown,
  hashText,
  parseEmbedding,
  remapChunkLines,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
// Yield to the event loop every N chunk inserts during file indexing.
const INDEX_INSERT_YIELD_EVERY = 64;
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const BATCH_FAILURE_LIMIT = 2;
// After transient batch failures disable batch embedding, retry it once this
// cooldown elapses rather than staying on the slower synchronous path for the
// whole manager lifetime (sessions can run for hours).
const BATCH_REENABLE_COOLDOWN_MS = 5 * 60_000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;
// Max placeholder crystals re-embedded per sync-cycle backfill pass. Bounded so
// the pass never stalls a sync; the CLI loops it to clear a larger backlog.
const PENDING_EMBED_DEFAULT_LIMIT = 256;
// Sentinel model tag for a chunk persisted without an embedding (empty vector),
// awaiting a later backfill pass. The backfill query matches this OR an empty
// embedding, so the chunk stays discoverable as "pending" rather than masquerading
// as a successfully-embedded row.
const PENDING_EMBED_MODEL = "pending";
// Floor for graceful batch bisection. When an embedding batch fails with a
// degradable (timeout/transient) error, it is split in half and retried; once a
// sub-batch reaches this size and still fails, its items are left pending instead
// of aborting the whole sync.
const EMBEDDING_BISECT_MIN_BATCH = 16;

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

const log = createSubsystemLogger("memory");

class MemoryManagerEmbeddingOps {
  [key: string]: any;
  private buildEmbeddingBatches(chunks: MemoryChunk[]): MemoryChunk[][] {
    const batches: MemoryChunk[][] = [];
    let current: MemoryChunk[] = [];
    let currentTokens = 0;

    for (const chunk of chunks) {
      const estimate = estimateUtf8Bytes(chunk.text);
      const wouldExceed =
        current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
      if (wouldExceed) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
        batches.push([chunk]);
        continue;
      }
      current.push(chunk);
      currentTokens += estimate;
    }

    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    if (!this.cache.enabled) {
      return new Map();
    }
    if (hashes.length === 0) {
      return new Map();
    }
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const hash of hashes) {
      if (!hash) {
        continue;
      }
      if (seen.has(hash)) {
        continue;
      }
      seen.add(hash);
      unique.push(hash);
    }
    if (unique.length === 0) {
      return new Map();
    }

    const out = new Map<string, number[]>();
    const baseParams = [this.provider.id, this.provider.model, this.providerKey];
    const batchSize = 400;
    for (let start = 0; start < unique.length; start += batchSize) {
      const batch = unique.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
      for (const row of rows) {
        out.set(row.hash, parseEmbedding(row.embedding));
      }
    }
    return out;
  }

  private upsertEmbeddingCache(entries: Array<{ hash: string; embedding: number[] }>): void {
    if (!this.cache.enabled) {
      return;
    }
    if (entries.length === 0) {
      return;
    }
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
        ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
        ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
        `   embedding=excluded.embedding,\n` +
        `   dims=excluded.dims,\n` +
        `   updated_at=excluded.updated_at`,
    );
    for (const entry of entries) {
      const embedding = entry.embedding ?? [];
      stmt.run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        entry.hash,
        JSON.stringify(embedding),
        embedding.length,
        now,
      );
    }
  }

  private pruneEmbeddingCacheIfNeeded(): void {
    if (!this.cache.enabled) {
      return;
    }
    const max = this.cache.maxEntries;
    if (!max || max <= 0) {
      return;
    }
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
      | { c: number }
      | undefined;
    const count = row?.c ?? 0;
    if (count <= max) {
      return;
    }
    const excess = count - max;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE rowid IN (\n` +
          `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
          `   ORDER BY updated_at ASC\n` +
          `   LIMIT ?\n` +
          ` )`,
      )
      .run(excess);
  }

  private async embedChunksInBatches(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);

    if (missing.length === 0) {
      return embeddings;
    }

    const fromCache = chunks.length - missing.length;
    const startedAt = Date.now();
    const missingChunks = missing.map((m) => m.chunk);
    const batches = this.buildEmbeddingBatches(missingChunks);
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    let cursor = 0;
    let failed = 0;
    let splits = 0;
    for (const batch of batches) {
      const result = await this.embedBatchResilient(batch.map((chunk) => chunk.text));
      failed += result.failed;
      splits += result.splits;
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = result.embeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          // Only cache real embeddings; caching an empty placeholder would let a
          // failed item read back as a (useless) cache hit and never get retried.
          if (embedding.length > 0) {
            toCache.push({ hash: item.chunk.hash, embedding });
          }
        }
      }
      cursor += batch.length;
    }
    this.upsertEmbeddingCache(toCache);
    const embedded = missing.length - failed;
    const summary = `${embedded}/${missing.length} embedded, ${fromCache} cache hit(s), ${splits} split(s) in ${Date.now() - startedAt}ms`;
    if (failed > 0) {
      log.warn(`memory embeddings: ${summary}; ${failed} chunk(s) left pending for backfill`);
    } else {
      log.debug(`memory embeddings: ${summary}`);
    }
    return embeddings;
  }

  /**
   * Embed one batch with graceful degradation. `embedBatchWithRetry` throws on a
   * timeout or exhausted-retry failure; left unhandled that aborts the entire
   * sync (and skips the pending-embedding backfill drainer), which is how
   * placeholder embeddings used to accumulate. Instead, on a *degradable*
   * (timeout / transient transport / rate-limit) error we bisect the batch and
   * retry each half down to {@link EMBEDDING_BISECT_MIN_BATCH}; items that still
   * fail come back as `[]` (left pending) rather than throwing. A genuinely
   * non-degradable error (auth, malformed request) is rethrown so the existing
   * provider-fallback path can still activate.
   */
  private async embedBatchResilient(
    texts: string[],
  ): Promise<{ embeddings: number[][]; failed: number; splits: number }> {
    if (texts.length === 0) {
      return { embeddings: [], failed: 0, splits: 0 };
    }
    try {
      const embeddings = await this.embedBatchWithRetry(texts);
      return { embeddings, failed: 0, splits: 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.isDegradableEmbeddingError(message)) {
        throw err;
      }
      if (texts.length <= EMBEDDING_BISECT_MIN_BATCH) {
        log.warn(
          `memory embeddings: sub-batch of ${texts.length} failed after retries (${message}); leaving pending`,
        );
        return { embeddings: texts.map(() => []), failed: texts.length, splits: 0 };
      }
      const mid = Math.floor(texts.length / 2);
      log.warn(
        `memory embeddings: batch of ${texts.length} failed (${message}); bisecting into ${mid}+${texts.length - mid}`,
      );
      const left = await this.embedBatchResilient(texts.slice(0, mid));
      const right = await this.embedBatchResilient(texts.slice(mid));
      return {
        embeddings: [...left.embeddings, ...right.embeddings],
        failed: left.failed + right.failed,
        splits: 1 + left.splits + right.splits,
      };
    }
  }

  /**
   * A degradable error is transient/capacity-related (timeout, dropped socket,
   * rate limit, 5xx) — worth bisecting and retrying smaller. A non-degradable
   * error (auth, 4xx other than 429, malformed input) will fail identically at
   * any batch size, so it is rethrown to trigger provider fallback instead.
   */
  private isDegradableEmbeddingError(message: string): boolean {
    return /(timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|fetch failed|rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d)/i.test(
      message,
    );
  }

  private computeProviderKey(): string {
    if (this.provider.id === "openai" && this.openAi) {
      const entries = Object.entries(this.openAi.headers)
        .filter(([key]) => key.toLowerCase() !== "authorization")
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]);
      return hashText(
        JSON.stringify({
          provider: "openai",
          baseUrl: this.openAi.baseUrl,
          model: this.openAi.model,
          headers: entries,
        }),
      );
    }
    if (this.provider.id === "gemini" && this.gemini) {
      const entries = Object.entries(this.gemini.headers)
        .filter(([key]) => {
          const lower = key.toLowerCase();
          return lower !== "authorization" && lower !== "x-goog-api-key";
        })
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]);
      return hashText(
        JSON.stringify({
          provider: "gemini",
          baseUrl: this.gemini.baseUrl,
          model: this.gemini.model,
          headers: entries,
        }),
      );
    }
    return hashText(JSON.stringify({ provider: this.provider.id, model: this.provider.model }));
  }

  private async embedChunksWithBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    if (this.provider.id === "openai" && this.openAi) {
      return this.embedChunksWithOpenAiBatch(chunks, entry, source);
    }
    if (this.provider.id === "gemini" && this.gemini) {
      return this.embedChunksWithGeminiBatch(chunks, entry, source);
    }
    if (this.provider.id === "voyage" && this.voyage) {
      return this.embedChunksWithVoyageBatch(chunks, entry, source);
    }
    return this.embedChunksInBatches(chunks);
  }

  private collectCachedEmbeddings(chunks: MemoryChunk[]): {
    embeddings: number[][];
    missing: Array<{ index: number; chunk: MemoryChunk }>;
  } {
    const cached = this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else if (chunk) {
        missing.push({ index: i, chunk });
      }
    }

    return { embeddings, missing };
  }

  private buildBatchCustomId(params: {
    source: MemorySource;
    entry: MemoryFileEntry | SessionFileEntry;
    chunk: MemoryChunk;
    index: number;
  }): string {
    return hashText(
      `${params.source}:${params.entry.path}:${params.chunk.startLine}:${params.chunk.endLine}:${params.chunk.hash}:${params.index}`,
    );
  }

  private buildBatchRequests<T extends { custom_id: string }>(params: {
    missing: Array<{ index: number; chunk: MemoryChunk }>;
    entry: MemoryFileEntry | SessionFileEntry;
    source: MemorySource;
    build: (chunk: MemoryChunk) => Omit<T, "custom_id">;
  }): { requests: T[]; mapping: Map<string, { index: number; hash: string }> } {
    const requests: T[] = [];
    const mapping = new Map<string, { index: number; hash: string }>();

    for (const item of params.missing) {
      const chunk = item.chunk;
      const customId = this.buildBatchCustomId({
        source: params.source,
        entry: params.entry,
        chunk,
        index: item.index,
      });
      mapping.set(customId, { index: item.index, hash: chunk.hash });
      const built = params.build(chunk);
      requests.push({ custom_id: customId, ...built } as T);
    }

    return { requests, mapping };
  }

  private applyBatchEmbeddings(params: {
    byCustomId: Map<string, number[]>;
    mapping: Map<string, { index: number; hash: string }>;
    embeddings: number[][];
  }): void {
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    for (const [customId, embedding] of params.byCustomId.entries()) {
      const mapped = params.mapping.get(customId);
      if (!mapped) {
        continue;
      }
      params.embeddings[mapped.index] = embedding;
      toCache.push({ hash: mapped.hash, embedding });
    }
    this.upsertEmbeddingCache(toCache);
  }

  private buildEmbeddingBatchRunnerOptions<TRequest>(params: {
    requests: TRequest[];
    chunks: MemoryChunk[];
    source: MemorySource;
  }): {
    agentId: string | undefined;
    requests: TRequest[];
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    debug: (message: string, data: Record<string, unknown>) => void;
  } {
    const { requests, chunks, source } = params;
    return {
      agentId: this.agentId,
      requests,
      wait: this.batch.wait,
      concurrency: this.batch.concurrency,
      pollIntervalMs: this.batch.pollIntervalMs,
      timeoutMs: this.batch.timeoutMs,
      debug: (message, data) => log.debug(message, { ...data, source, chunks: chunks.length }),
    };
  }

  private async embedChunksWithVoyageBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const voyage = this.voyage;
    if (!voyage) {
      return this.embedChunksInBatches(chunks);
    }
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
    if (missing.length === 0) {
      return embeddings;
    }

    const { requests, mapping } = this.buildBatchRequests<VoyageBatchRequest>({
      missing,
      entry,
      source,
      build: (chunk) => ({
        body: { input: chunk.text },
      }),
    });
    const runnerOptions = this.buildEmbeddingBatchRunnerOptions({ requests, chunks, source });
    const batchResult = await this.runBatchWithFallback({
      provider: "voyage",
      run: async () =>
        await runVoyageEmbeddingBatches({
          client: voyage,
          ...runnerOptions,
        }),
      fallback: async () => await this.embedChunksInBatches(chunks),
    });
    if (Array.isArray(batchResult)) {
      return batchResult;
    }
    this.applyBatchEmbeddings({ byCustomId: batchResult, mapping, embeddings });
    return embeddings;
  }

  private async embedChunksWithOpenAiBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const openAi = this.openAi;
    if (!openAi) {
      return this.embedChunksInBatches(chunks);
    }
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
    if (missing.length === 0) {
      return embeddings;
    }

    const { requests, mapping } = this.buildBatchRequests<OpenAiBatchRequest>({
      missing,
      entry,
      source,
      build: (chunk) => ({
        method: "POST",
        url: OPENAI_BATCH_ENDPOINT,
        body: {
          model: this.openAi?.model ?? this.provider.model,
          input: chunk.text,
        },
      }),
    });
    const runnerOptions = this.buildEmbeddingBatchRunnerOptions({ requests, chunks, source });
    const batchResult = await this.runBatchWithFallback({
      provider: "openai",
      run: async () =>
        await runOpenAiEmbeddingBatches({
          openAi,
          ...runnerOptions,
        }),
      fallback: async () => await this.embedChunksInBatches(chunks),
    });
    if (Array.isArray(batchResult)) {
      return batchResult;
    }
    this.applyBatchEmbeddings({ byCustomId: batchResult, mapping, embeddings });
    return embeddings;
  }

  private async embedChunksWithGeminiBatch(
    chunks: MemoryChunk[],
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const gemini = this.gemini;
    if (!gemini) {
      return this.embedChunksInBatches(chunks);
    }
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
    if (missing.length === 0) {
      return embeddings;
    }

    const { requests, mapping } = this.buildBatchRequests<GeminiBatchRequest>({
      missing,
      entry,
      source,
      build: (chunk) => ({
        content: { parts: [{ text: chunk.text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }),
    });
    const runnerOptions = this.buildEmbeddingBatchRunnerOptions({ requests, chunks, source });

    const batchResult = await this.runBatchWithFallback({
      provider: "gemini",
      run: async () =>
        await runGeminiEmbeddingBatches({
          gemini,
          ...runnerOptions,
        }),
      fallback: async () => await this.embedChunksInBatches(chunks),
    });
    if (Array.isArray(batchResult)) {
      return batchResult;
    }
    this.applyBatchEmbeddings({ byCustomId: batchResult, mapping, embeddings });
    return embeddings;
  }

  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    let attempt = 0;
    let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
    while (true) {
      try {
        const timeoutMs = this.resolveEmbeddingTimeout("batch");
        log.debug("memory embeddings: batch start", {
          provider: this.provider.id,
          items: texts.length,
          timeoutMs,
        });
        return await this.withTimeout(
          this.provider.embedBatch(texts),
          timeoutMs,
          `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
          throw err;
        }
        const waitMs = Math.min(
          EMBEDDING_RETRY_MAX_DELAY_MS,
          Math.round(delayMs * (1 + Math.random() * 0.2)),
        );
        log.warn(`memory embeddings rate limited; retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        delayMs *= 2;
        attempt += 1;
      }
    }
  }

  private isRetryableEmbeddingError(message: string): boolean {
    return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare)/i.test(
      message,
    );
  }

  private resolveEmbeddingTimeout(kind: "query" | "batch"): number {
    const isLocal = this.provider.id === "local";
    if (kind === "query") {
      return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
    }
    return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
  }

  private async embedQueryWithTimeout(text: string): Promise<number[]> {
    const timeoutMs = this.resolveEmbeddingTimeout("query");
    log.debug("memory embeddings: query start", { provider: this.provider.id, timeoutMs });
    return await this.withTimeout(
      this.provider.embedQuery(text),
      timeoutMs,
      `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return (await Promise.race([promise, timeoutPromise])) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async withBatchFailureLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = this.batchFailureLock;
    this.batchFailureLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private async resetBatchFailureCount(): Promise<void> {
    await this.withBatchFailureLock(async () => {
      if (this.batchFailureCount > 0) {
        log.debug("memory embeddings: batch recovered; resetting failure count");
      }
      this.batchFailureCount = 0;
      this.batchFailureLastError = undefined;
      this.batchFailureLastProvider = undefined;
      this.batchDisabledAt = null;
    });
  }

  /**
   * If batch embedding was disabled by transient failures and the cooldown has
   * elapsed, turn it back on for another attempt. A hard disable (provider lacks
   * batch support) leaves batchDisabledAt null and is never retried. Idempotent
   * and cheap, so it is safe to call on the embedding hot path.
   */
  private maybeReenableBatchAfterCooldown(): void {
    if (this.batch.enabled || this.batchDisabledAt === null) {
      return;
    }
    if (Date.now() - this.batchDisabledAt < BATCH_REENABLE_COOLDOWN_MS) {
      return;
    }
    log.info(
      `memory embeddings: re-enabling batch after ${Math.round(
        BATCH_REENABLE_COOLDOWN_MS / 60_000,
      )}m cooldown (was disabled by transient failures)`,
    );
    this.batch.enabled = true;
    this.batchFailureCount = 0;
    this.batchDisabledAt = null;
    this.batchFailureLastError = undefined;
    this.batchFailureLastProvider = undefined;
  }

  private async recordBatchFailure(params: {
    provider: string;
    message: string;
    attempts?: number;
    forceDisable?: boolean;
  }): Promise<{ disabled: boolean; count: number }> {
    return await this.withBatchFailureLock(async () => {
      if (!this.batch.enabled) {
        return { disabled: true, count: this.batchFailureCount };
      }
      const increment = params.forceDisable
        ? BATCH_FAILURE_LIMIT
        : Math.max(1, params.attempts ?? 1);
      this.batchFailureCount += increment;
      this.batchFailureLastError = params.message;
      this.batchFailureLastProvider = params.provider;
      const disabled = params.forceDisable || this.batchFailureCount >= BATCH_FAILURE_LIMIT;
      if (disabled) {
        this.batch.enabled = false;
        // forceDisable means the provider lacks batch support — never retry it.
        // Transient failures get a cooldown so batch can recover.
        this.batchDisabledAt = params.forceDisable ? null : Date.now();
      }
      return { disabled, count: this.batchFailureCount };
    });
  }

  private isBatchTimeoutError(message: string): boolean {
    return /timed out|timeout/i.test(message);
  }

  private async runBatchWithTimeoutRetry<T>(params: {
    provider: string;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isBatchTimeoutError(message)) {
        log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
        try {
          return await params.run();
        } catch (retryErr) {
          (retryErr as { batchAttempts?: number }).batchAttempts = 2;
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async runBatchWithFallback<T>(params: {
    provider: string;
    run: () => Promise<T>;
    fallback: () => Promise<number[][]>;
  }): Promise<T | number[][]> {
    this.maybeReenableBatchAfterCooldown();
    if (!this.batch.enabled) {
      return await params.fallback();
    }
    try {
      const result = await this.runBatchWithTimeoutRetry({
        provider: params.provider,
        run: params.run,
      });
      await this.resetBatchFailureCount();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (err as { batchAttempts?: number }).batchAttempts ?? 1;
      const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
      const failure = await this.recordBatchFailure({
        provider: params.provider,
        message,
        attempts,
        forceDisable,
      });
      const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
      log.warn(
        `memory embeddings: ${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
      );
      return await params.fallback();
    }
  }

  private getIndexConcurrency(): number {
    return this.batch.enabled ? this.batch.concurrency : EMBEDDING_INDEX_CONCURRENCY;
  }

  private async indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
    const chunks = enforceEmbeddingMaxInputTokens(
      this.provider,
      chunkMarkdown(content, this.settings.chunking).filter(
        (chunk) => chunk.text.trim().length > 0,
      ),
    );
    if (options.source === "sessions" && "lineMap" in entry) {
      remapChunkLines(chunks, entry.lineMap);
    }
    // Gate the batch-vs-fallback choice through the cooldown check so a batch
    // path disabled by transient failures gets retried once the cooldown passes.
    this.maybeReenableBatchAfterCooldown();
    const embeddings = this.batch.enabled
      ? await this.embedChunksWithBatch(chunks, entry, options.source)
      : await this.embedChunksInBatches(chunks);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();
    if (vectorReady) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(entry.path, options.source);
      } catch (err) {
        // Stale vec rows can survive and cause duplicate similarity hits; not
        // fatal, but log so a recurring failure is visible.
        log.debug(`memory index: vec cleanup failed for ${entry.path}: ${String(err)}`);
      }
    }
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, options.source, this.provider.model);
      } catch (err) {
        log.debug(`memory index: FTS cleanup failed for ${entry.path}: ${String(err)}`);
      }
    }
    // PLAN-40 P1-F1 (2026-08-12): re-indexing must not resurrect chunks the
    // hygiene merge demoted. This path deletes every row for the file and
    // re-inserts it as a fresh `generated` chunk with parent_id NULL,
    // hygiene_done 0 and brand-new vec/FTS rows — which silently undid the
    // merge. Live evidence: 8 of 14 merge summaries had lost every member, and
    // one demoted chunk was back in full retrieval 14 hours later. Since ids
    // are content-derived, an unchanged chunk returns with the SAME id, so the
    // demotion is captured here and re-applied below (and its index rows are
    // NOT rewritten). A chunk whose text actually changed gets a new id, is
    // absent from this map, and is correctly indexed fresh.
    const demotedBefore = new Map<
      string,
      { lifecycle: string; lifecycle_state: string | null; parent_id: string | null }
    >();
    try {
      const rows = this.db
        .prepare(
          `SELECT id, lifecycle, lifecycle_state, parent_id FROM chunks
            WHERE path = ? AND source = ?
              AND (COALESCE(lifecycle, '') = 'consolidated' OR COALESCE(hygiene_done, 0) = 1)`,
        )
        .all(entry.path, options.source) as Array<{
        id: string;
        lifecycle: string;
        lifecycle_state: string | null;
        parent_id: string | null;
      }>;
      for (const row of rows) {
        demotedBefore.set(row.id, {
          lifecycle: row.lifecycle,
          lifecycle_state: row.lifecycle_state,
          parent_id: row.parent_id,
        });
      }
    } catch (err) {
      log.debug(`memory index: demotion capture failed for ${entry.path}: ${String(err)}`);
    }
    this.db
      .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
      .run(entry.path, options.source);
    // Stimulate global hormonal state from NEW session content only.
    // Uses sessionDeltas to avoid re-stimulating from already-indexed bytes,
    // which would cause retroactive emotional spikes on reindex.
    if (options.source === "sessions" && this.hormonalManager) {
      const delta = this.sessionDeltas.get(entry.path);
      const newContent =
        delta && delta.pendingBytes > 0 && delta.pendingBytes < content.length
          ? content.slice(content.length - delta.pendingBytes)
          : !delta
            ? content
            : ""; // First index: process all; reindex with no delta: skip
      if (newContent.length > 0) {
        const events = this.hormonalManager.stimulateFromText(newContent);
        if (events.length > 0) {
          log.debug(
            `hormonal stimulation from session delta (${delta?.pendingBytes ?? content.length}B new): ${events.join(", ")}`,
          );
        }
      }
    }
    const origin: CrystalOrigin =
      options.source === "sessions" ? "session" : options.source === "skills" ? "skill" : "indexed";
    const memoryType = options.source === "skills" ? "skill" : "plaintext";
    const lifecycle = options.source === "skills" ? "frozen" : "generated";
    let pendingCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      // A large session/memory file can carry thousands of chunks, each doing
      // several synchronous INSERTs plus a KNN curiosity assessment. Yield every
      // INDEX_INSERT_YIELD_EVERY chunks so a single big file can't freeze the
      // gateway keepalive and bounce the Control UI.
      if (i > 0 && i % INDEX_INSERT_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      // When embedding failed (graceful degradation left it empty), tag the row
      // 'pending' rather than the real model so the backfill drainer reclaims it
      // and it is never mistaken for a successfully-vectorized chunk.
      const modelForRow = embedding.length > 0 ? this.provider.model : PENDING_EMBED_MODEL;
      if (embedding.length === 0) {
        pendingCount += 1;
      }
      const id = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      const semanticType = inferSemanticType(chunk.text, options.source, origin);
      const governance = defaultGovernance(options.source);
      // Compute per-crystal hormonal influence and derive valence from it.
      // Unifies the two emotional tagging systems: the 3D hormonal influence
      // (dopamine/cortisol/oxytocin) is the source of truth, and scalar valence
      // is derived as (dopamine + oxytocin - cortisol) clamped to [-1, 1].
      const hormonal: HormonalInfluence = this.hormonalManager
        ? this.hormonalManager.computeCrystalInfluence(chunk.text, options.source)
        : { dopamine: 0, cortisol: 0, oxytocin: 0 };
      const valence = deriveValenceFromHormonal(hormonal);
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
             updated_at, emotional_valence, origin, memory_type,
             semantic_type, lifecycle, created_at, governance_json,
             hormonal_dopamine, hormonal_cortisol, hormonal_oxytocin, skill_category)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             skill_category=COALESCE(excluded.skill_category, chunks.skill_category),
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at,
             emotional_valence=excluded.emotional_valence,
             origin=excluded.origin,
             memory_type=excluded.memory_type,
             semantic_type=excluded.semantic_type,
             hormonal_dopamine=excluded.hormonal_dopamine,
             hormonal_cortisol=excluded.hormonal_cortisol,
             hormonal_oxytocin=excluded.hormonal_oxytocin`,
        )
        .run(
          id,
          entry.path,
          options.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          modelForRow,
          chunk.text,
          JSON.stringify(embedding),
          now,
          valence,
          origin,
          memoryType,
          semanticType,
          lifecycle,
          now,
          JSON.stringify({
            accessScope: governance.accessScope,
            lifespanPolicy: governance.lifespanPolicy,
            priority: governance.priority,
            sensitivity: governance.sensitivity,
          }),
          hormonal.dopamine,
          hormonal.cortisol,
          hormonal.oxytocin,
          // Audit F12, remaining path (2026-08-11): SKILL.md files indexed from
          // disk land as source='skills' chunks that the health sweep counts as
          // skill crystals — 487 of them had no skill_category, so they were
          // invisible to skills.metrics and skill_lifecycle exactly like the
          // crystal-creation paths fixed in v57. The containing folder IS the
          // canonical skill key (same rule the bootstrap uses).
          options.source === "skills" ? skillCategoryFromPath(entry.path) : null,
        );
      // Extract user preferences from session content
      if (options.source === "sessions" && this.userModelManager) {
        try {
          this.userModelManager.extractPreferences(chunk.text, id);
        } catch (err) {
          log.debug(`memory index: preference extraction failed for ${id}: ${String(err)}`);
        }
      }
      // P1-F1: restore the demotion this re-index would otherwise have erased,
      // and leave the chunk OUT of both indexes — re-indexing it is exactly
      // what put merged-away duplicates back in front of retrieval.
      const demoted = demotedBefore.get(id);
      if (demoted) {
        try {
          this.db
            .prepare(
              `UPDATE chunks SET lifecycle = ?, lifecycle_state = ?, parent_id = ?, hygiene_done = 1
                WHERE id = ?`,
            )
            .run(demoted.lifecycle, demoted.lifecycle_state, demoted.parent_id, id);
          continue;
        } catch (err) {
          // Fall through and index normally: a chunk that is searchable twice
          // is a worse outcome than one that is not searchable at all.
          log.debug(`memory index: demotion restore failed for ${id}: ${String(err)}`);
        }
      }
      if (vectorReady && embedding.length > 0) {
        try {
          this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
        } catch (err) {
          log.debug(`memory index: vec row replace failed for ${id}: ${String(err)}`);
        }
        this.db
          .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, vectorToBlob(embedding));
      }
      if (this.fts.enabled && this.fts.available) {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
              ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            id,
            entry.path,
            options.source,
            modelForRow,
            chunk.startLine,
            chunk.endLine,
          );
      }

      // Curiosity Engine: assess chunk for novelty/surprise
      if (embedding.length > 0) {
        try {
          this.assessChunkCuriosity(id, embedding, chunk.hash);
        } catch (err) {
          log.debug(`memory index: curiosity assessment failed for ${id}: ${String(err)}`);
        }
      }
    }
    if (pendingCount > 0) {
      // Not fatal: the chunks are stored + FTS-searchable and tagged 'pending';
      // the per-cycle backfill drainer will vectorize them on a later pass.
      log.warn(
        `memory index: ${entry.path} stored ${pendingCount}/${chunks.length} chunk(s) without embeddings (pending backfill)`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, options.source, entry.hash, entry.mtimeMs, entry.size);
  }

  /**
   * Re-embed crystals that were inserted with placeholder embeddings.
   *
   * Directly-inserted crystals — extracted facts (`fact_*`), scratch/notes,
   * handover briefs, peer imports — are written with `model='pending'` and
   * `embedding='[]'` on the expectation of a later embedding pass. Nothing ever
   * re-embedded them, so they were invisible to BOTH vector and FTS search
   * (reachable only by direct SQL). This pass finds them, embeds in cache-aware
   * batches, persists the embedding + real model, and indexes them into
   * chunks_vec and chunks_fts so they become searchable through both channels.
   *
   * Bounded by `limit` so it never stalls a sync cycle; the CLI
   * `memory backfill-embeddings` calls it in a loop to clear a backlog. Chunks
   * whose embedding call returns empty are left pending for the next pass.
   * Returns how many were embedded this call and how many remain pending.
   */
  async backfillPendingEmbeddings(options?: {
    limit?: number;
  }): Promise<{ embedded: number; remaining: number }> {
    const limit = Math.max(1, options?.limit ?? PENDING_EMBED_DEFAULT_LIMIT);
    const pendingWhere =
      `(model = 'pending' OR json_array_length(embedding) = 0)\n` +
      `        AND text IS NOT NULL AND length(trim(text)) > 0\n` +
      `        AND (lifecycle_state IS NULL OR lifecycle_state <> 'forgotten')\n` +
      `        AND (lifecycle IS NULL OR lifecycle <> 'expired')`;
    const countRemaining = (): number =>
      (
        this.db.prepare(`SELECT count(*) c FROM chunks WHERE ${pendingWhere}`).get() as {
          c: number;
        }
      ).c;

    const rows = this.db
      .prepare(
        `SELECT id, text, hash, start_line AS startLine, end_line AS endLine, path, source
           FROM chunks
          WHERE ${pendingWhere}
          ORDER BY importance_score DESC, updated_at DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      id: string;
      text: string;
      hash: string;
      startLine: number | null;
      endLine: number | null;
      path: string;
      source: MemorySource;
    }>;
    if (rows.length === 0) {
      return { embedded: 0, remaining: 0 };
    }

    const chunks: MemoryChunk[] = enforceEmbeddingMaxInputTokens(
      this.provider,
      rows.map((row) => ({
        startLine: row.startLine ?? 0,
        endLine: row.endLine ?? 0,
        text: row.text,
        hash: row.hash,
      })),
    );
    const embeddings = await this.embedChunksInBatches(chunks);
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();

    const updateChunk = this.db.prepare(
      `UPDATE chunks SET embedding = ?, model = ?, updated_at = ? WHERE id = ?`,
    );
    // Only prepare statements for tables that actually exist: chunks_vec is
    // absent when vectors are disabled or sqlite-vec failed to load, and
    // chunks_fts is absent when FTS is disabled. Preparing against a missing
    // table throws, so gate the prepares on availability rather than the loop.
    const vec = vectorReady
      ? {
          del: this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`),
          ins: this.db.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`),
        }
      : null;
    const ftsReady = this.fts.enabled && this.fts.available;
    const fts = ftsReady
      ? {
          del: this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`),
          ins: this.db.prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
              ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ),
        }
      : null;

    let embedded = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const embedding = embeddings[i] ?? [];
      // Embedding failed for this chunk (provider hiccup); leave it pending so
      // the next pass retries rather than persisting an empty placeholder.
      if (!row || embedding.length === 0) {
        continue;
      }
      try {
        updateChunk.run(JSON.stringify(embedding), this.provider.model, now, row.id);
        if (vec) {
          try {
            vec.del.run(row.id);
          } catch {}
          vec.ins.run(row.id, vectorToBlob(embedding));
        }
        if (fts) {
          try {
            fts.del.run(row.id);
          } catch {}
          fts.ins.run(
            row.text,
            row.id,
            row.path,
            row.source,
            this.provider.model,
            row.startLine ?? 0,
            row.endLine ?? 0,
          );
        }
        embedded += 1;
      } catch (err) {
        log.warn(`backfill-embeddings: failed to index ${row.id}: ${String(err)}`);
      }
    }

    const remaining = countRemaining();
    if (embedded > 0) {
      log.info(
        `backfill-embeddings: embedded ${embedded} pending crystal(s), ${remaining} remaining`,
      );
    }
    return { embedded, remaining };
  }
}

/**
 * Lightweight keyword-based emotional valence detection.
 * Returns a value between -1 (negative) and +1 (positive), or null if neutral.
 */
/**
 * Derive a scalar emotional valence from per-crystal hormonal influence.
 * Positive hormones (dopamine, oxytocin) contribute positive valence;
 * negative hormones (cortisol) contribute negative valence.
 * Returns null if the hormonal influence is negligible (all near zero).
 */
function deriveValenceFromHormonal(h: HormonalInfluence): number | null {
  const raw = h.dopamine + h.oxytocin - h.cortisol;
  if (Math.abs(raw) < 0.05) {
    return null;
  }
  return Math.max(-1, Math.min(1, raw));
}

/**
 * Derive the canonical skill key from an indexed SKILL.md path: the containing
 * folder name, matching `runSkillBootstrap`'s rule so a folder indexed from
 * disk and the same folder bootstrapped as a crystal group together.
 */
function skillCategoryFromPath(filePath: string): string | null {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  // .../<skillFolder>/SKILL.md  ->  <skillFolder>
  const folder = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  if (!folder || folder === "." || folder === ".." || folder === "skills") {
    return null;
  }
  return folder;
}

export const memoryManagerEmbeddingOps = MemoryManagerEmbeddingOps.prototype;
