/**
 * Tiny time-to-live cache for expensive, read-only RPC responses.
 *
 * Some gateway RPCs (notably skills.network / skills.networkHistory) run heavy
 * synchronous `node:sqlite` aggregation and best-effort IPC/HTTP fan-out on the
 * single event loop. The Control UI polls them and re-issues them on every
 * reconnect, so without caching a slow call could be re-paid back-to-back —
 * blocking the loop, starving the 30s WebSocket keepalive `tick`, and bouncing
 * the UI (1006 reconnects), which then re-triggers the same calls. A short TTL
 * collapses bursts of *sequential* identical polls into one computed result.
 *
 * The TTL alone does not stop *concurrent* misses: a reconnect fires a burst of
 * identical polls in the same tick, and because none has resolved yet they all
 * see an empty cache and independently run the full heavy computation, piling
 * onto the loop at once (the "N requests all resolve at the same instant with
 * near-identical durations" signature seen in the gateway log). `getOrCompute`
 * fixes that with single-flight coalescing: the first miss runs the work and
 * every concurrent caller for the same key awaits that one in-flight promise.
 */

type Entry<V> = { value: V; expiresAt: number };

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  /** In-flight computations, keyed like `store`, for single-flight coalescing. */
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly ttlMs: number) {}

  /** Return the cached value for `key` if present and unexpired, else undefined. */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Cache `value` under `key` for this cache's TTL. */
  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Return the cached value for `key`, or compute it via `compute` and cache the
   * result. Concurrent callers that miss while a computation is already running
   * for the same key share that single in-flight promise instead of each running
   * `compute` — collapsing a reconnect burst into one loop-blocking pass. If
   * `compute` rejects, the in-flight entry is cleared and nothing is cached, so
   * the next call retries.
   */
  getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      try {
        const value = await compute();
        this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop all entries (mainly for tests and explicit invalidation). */
  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }
}
