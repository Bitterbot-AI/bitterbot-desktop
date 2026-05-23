/**
 * PLAN-20: In-memory registry of pre-action interceptors.
 *
 * Keyed by interceptor id. Priority-ordered. Hot-reloadable on skill
 * activation/deactivation. Per-session fire counts are tracked here so the
 * runner can enforce `maxFiresPerEpisode` cheaply.
 */

import type {
  InterceptorOrigin,
  PreActionInterceptor,
  RegisteredInterceptor,
} from "./interceptor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/skills/interceptors");

class InterceptorRegistry {
  private readonly entries = new Map<string, RegisteredInterceptor>();
  /** sessionKey → (interceptorId → fireCount). Trimmed lazily. */
  private readonly perSessionFires = new Map<string, Map<string, number>>();
  /** Auto-disabled ids (after 3 throws on a session). */
  private readonly disabled = new Set<string>();
  /** Config-disabled ids (operator-driven, persistent across sessions). */
  private readonly configDisabled = new Set<string>();
  private cacheBust = 0;

  register(interceptor: PreActionInterceptor, origin: InterceptorOrigin = "builtin"): void {
    if (this.entries.has(interceptor.id)) {
      log.debug(`re-registering interceptor ${interceptor.id} (origin=${origin})`);
    }
    this.entries.set(interceptor.id, {
      interceptor,
      origin,
      registeredAt: Date.now(),
    });
    this.cacheBust += 1;
  }

  unregister(id: string): void {
    this.entries.delete(id);
    this.disabled.delete(id);
    this.cacheBust += 1;
  }

  unregisterBySkill(skill: string): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.interceptor.skill === skill) {
        this.entries.delete(id);
        this.disabled.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.cacheBust += 1;
    }
    return removed;
  }

  list(): RegisteredInterceptor[] {
    return [...this.entries.values()];
  }

  /** Returns enabled interceptors that might match `toolName`, priority-desc. */
  candidatesFor(toolName: string): RegisteredInterceptor[] {
    const out: RegisteredInterceptor[] = [];
    for (const entry of this.entries.values()) {
      if (this.disabled.has(entry.interceptor.id)) continue;
      if (this.configDisabled.has(entry.interceptor.id)) continue;
      if (this.configDisabled.has(entry.interceptor.skill)) continue;
      if (entry.origin === "mesh-pending") continue; // PLAN-20: gated on #21
      const tools = entry.interceptor.tools;
      if (tools && tools.length > 0 && !tools.includes(toolName)) continue;
      out.push(entry);
    }
    out.sort((a, b) => (b.interceptor.priority ?? 0) - (a.interceptor.priority ?? 0));
    return out;
  }

  /**
   * Set the operator's disabled list. Each entry can be either an
   * interceptor id ("recall-before-claim:default") or a skill name
   * ("recall-before-claim"), disabling all of that skill's interceptors.
   * Replaces the entire list — pass [] to clear.
   */
  setConfigDisabledList(ids: readonly string[]): void {
    this.configDisabled.clear();
    for (const id of ids) {
      if (id.trim()) this.configDisabled.add(id.trim());
    }
    this.cacheBust += 1;
  }

  configDisabledList(): string[] {
    return [...this.configDisabled];
  }

  recordFire(sessionKey: string, interceptorId: string): number {
    let perSession = this.perSessionFires.get(sessionKey);
    if (!perSession) {
      perSession = new Map();
      this.perSessionFires.set(sessionKey, perSession);
    }
    const next = (perSession.get(interceptorId) ?? 0) + 1;
    perSession.set(interceptorId, next);
    return next;
  }

  firesThisEpisode(sessionKey: string, interceptorId: string): number {
    return this.perSessionFires.get(sessionKey)?.get(interceptorId) ?? 0;
  }

  resetSession(sessionKey: string): void {
    this.perSessionFires.delete(sessionKey);
  }

  markFailure(interceptorId: string, totalStrikes: number): void {
    if (totalStrikes >= 3) {
      this.disabled.add(interceptorId);
      log.warn(
        `interceptor ${interceptorId} auto-disabled after ${totalStrikes} throws this session`,
      );
    }
  }

  /**
   * Apply a persistent (cross-session) disabled set, e.g. loaded from
   * the SQLite-backed strikes store at autoboot.
   */
  loadPersistedDisabled(ids: ReadonlyArray<string>): void {
    for (const id of ids) {
      if (id) this.disabled.add(id);
    }
    if (ids.length > 0) {
      this.cacheBust += 1;
    }
  }

  isDisabled(interceptorId: string): boolean {
    return this.disabled.has(interceptorId);
  }

  enableForOperator(interceptorId: string): void {
    this.disabled.delete(interceptorId);
    this.cacheBust += 1;
  }

  cacheKey(): number {
    return this.cacheBust;
  }

  clear(): void {
    this.entries.clear();
    this.perSessionFires.clear();
    this.disabled.clear();
    this.cacheBust += 1;
  }
}

let singleton: InterceptorRegistry | null = null;

export function getInterceptorRegistry(): InterceptorRegistry {
  if (!singleton) singleton = new InterceptorRegistry();
  return singleton;
}

export type { InterceptorRegistry };
