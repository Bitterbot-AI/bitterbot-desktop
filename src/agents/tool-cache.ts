/**
 * Tool Result Cache — in-memory LRU with TTL.
 * Adapted from Bitterbot-Core's Redis-based tool_cache.py for the
 * single-process desktop runtime.
 *
 * Caches tool execution results so repeated identical tool calls
 * (same tool name + same arguments) return cached results instead
 * of re-executing. Saves API costs, latency, and token usage.
 */

import { createHash } from "node:crypto";

export interface CacheEntry<T = unknown> {
  result: T;
  cachedAt: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
}

export interface ToolCacheConfig {
  /** LRU capacity (default: 500). */
  maxEntries?: number;
  /** Default TTL per entry in ms (default: 5 minutes). */
  defaultTtlMs?: number;
  /** Kill switch (default: true). */
  enabled?: boolean;
  /** Tool names eligible for caching. */
  cacheableTools?: string[];
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_CACHEABLE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "web_search",
  "web_fetch",
  "image",
  "memory_search",
]);

export class ToolCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly enabled: boolean;
  private readonly cacheableTools: ReadonlySet<string>;
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0 };

  constructor(config?: ToolCacheConfig) {
    this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.defaultTtlMs = config?.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.enabled = config?.enabled ?? true;
    this.cacheableTools = config?.cacheableTools
      ? new Set(config.cacheableTools)
      : DEFAULT_CACHEABLE_TOOLS;
  }

  /** Check whether a tool name is eligible for caching. */
  isCacheable(toolName: string): boolean {
    return this.enabled && this.cacheableTools.has(toolName);
  }

  /** Generate a deterministic cache key from tool name + sorted args. */
  generateKey(toolName: string, args: Record<string, unknown>): string {
    const sorted = JSON.stringify(args, Object.keys(args).toSorted());
    const hash = createHash("sha256").update(`${toolName}:${sorted}`).digest("hex").slice(0, 16);
    return `${toolName}:${hash}`;
  }

  /** Retrieve a cached result. Returns undefined on miss or expiry. */
  get<T = unknown>(toolName: string, args: Record<string, unknown>): T | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const key = this.generateKey(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }
    // LRU: move to end
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.stats.hits++;
    return entry.result as T;
  }

  /** Store a tool result in the cache. */
  set<T = unknown>(
    toolName: string,
    args: Record<string, unknown>,
    result: T,
    ttlMs?: number,
  ): void {
    if (!this.enabled) {
      return;
    }
    const key = this.generateKey(toolName, args);
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        this.cache.delete(oldest);
        this.stats.evictions++;
      }
    }
    this.cache.set(key, {
      result,
      cachedAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
    });
  }

  /**
   * Invalidate cached results.
   * If `args` is provided, invalidate the specific entry; otherwise
   * invalidate all entries for the given tool name.
   */
  invalidate(toolName: string, args?: Record<string, unknown>): void {
    if (args) {
      this.cache.delete(this.generateKey(toolName, args));
    } else {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${toolName}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /** Return cache statistics including hit rate. */
  getStats(): CacheStats & { size: number; hitRate: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /** Clear all cached entries (stats are preserved). */
  clear(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Global singleton — shared across sessions within the same process.
// ---------------------------------------------------------------------------

let globalToolCache: ToolCache | undefined;

/** Get or create the global tool cache instance. */
export function getGlobalToolCache(config?: ToolCacheConfig): ToolCache {
  if (!globalToolCache) {
    globalToolCache = new ToolCache(config);
  }
  return globalToolCache;
}

/** Replace the global tool cache (useful for testing). */
export function setGlobalToolCache(cache: ToolCache | undefined): void {
  globalToolCache = cache;
}
