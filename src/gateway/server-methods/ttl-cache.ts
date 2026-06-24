/**
 * Tiny time-to-live cache for expensive, read-only RPC responses.
 *
 * Some gateway RPCs (notably skills.network / skills.networkHistory) run heavy
 * synchronous `node:sqlite` aggregation and best-effort IPC/HTTP fan-out on the
 * single event loop. The Control UI polls them and re-issues them on every
 * reconnect, so without caching a slow call could be re-paid back-to-back —
 * blocking the loop, starving the 30s WebSocket keepalive `tick`, and bouncing
 * the UI (1006 reconnects), which then re-triggers the same calls. A short TTL
 * collapses bursts of identical polls into one computed result.
 */

type Entry<V> = { value: V; expiresAt: number };

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();

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

  /** Drop all entries (mainly for tests and explicit invalidation). */
  clear(): void {
    this.store.clear();
  }
}
