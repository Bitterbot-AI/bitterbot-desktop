/**
 * PLAN-20: one-shot wiring called from the gateway boot path. After
 * bootstrap:
 *   - The 4 built-in interceptors are registered.
 *   - The intervention store is bound to the live memory DB.
 *   - State providers (hormonal + GCCRF + channel + recent turns) point at
 *     real runtime managers.
 *   - The Ed25519 signer is wired to the node identity key.
 *
 * Bootstrap is idempotent: calling it twice is a no-op past the first
 * registration. This makes safe-reload during dev simple.
 */

import type { DatabaseSync } from "node:sqlite";
import type { HormonalStateManager } from "../../memory/hormonal.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { registerBuiltinInterceptors } from "./builtin-interceptors/index.js";
import {
  setInterceptorContextProviders,
  clearInterceptorContextProviders,
} from "./interceptor-context.js";
import { setInterventionSigner, setInterventionStore } from "./intervention-record.js";
import { createSqliteInterventionStore } from "./intervention-store.js";
import { buildGCCRFSnapshot, buildHormonalSnapshot } from "./state-snapshots.js";

const log = createSubsystemLogger("agents/skills/interceptors");

interface BootstrapDeps {
  db?: DatabaseSync | null;
  hormonal?: HormonalStateManager | null;
  /**
   * Reads the current GCCRF state. Lives behind a getter so the dream
   * engine can lazily provide it after its own startup completes.
   */
  gccrfState?: () => unknown | null;
  /** Optional channel resolver — `internal` if absent. */
  resolveChannel?: (sessionKey: string) => string;
  /** Optional Ed25519 signer. Unsigned-local fallback if absent. */
  signer?: ((canonicalJson: string) => { ed25519: string; pubkeyId: string }) | null;
  /** Optional read of recent assistant draft for a session. */
  draftReply?: (sessionKey: string) => string | undefined;
  /** Optional read of recent turns (PII-redacted previews). */
  recentTurns?: (
    sessionKey: string,
    limit: number,
  ) => Array<{
    role: "user" | "assistant" | "system" | "tool";
    preview: string;
  }>;
  /** Optional read of recent tool history. */
  toolHistory?: (
    sessionKey: string,
    limit: number,
  ) => Array<{
    tool: string;
    success: boolean;
    tsDelta: number;
  }>;
  /** Optional turn-number provider. */
  turnNumber?: (sessionKey: string) => number;
}

let booted = false;

export function bootstrapInterceptors(deps: BootstrapDeps): void {
  if (booted) {
    // Updating deps mid-run is supported — we just refresh providers.
    applyProviders(deps);
    return;
  }
  booted = true;

  registerBuiltinInterceptors();

  if (deps.db) {
    setInterventionStore(createSqliteInterventionStore(deps.db));
  }

  if (deps.signer) {
    setInterventionSigner(deps.signer);
  }

  applyProviders(deps);

  log.debug(
    `interceptor bootstrap complete: builtin=true store=${deps.db ? "sqlite" : "none"} signer=${deps.signer ? "ed25519" : "none"}`,
  );
}

function applyProviders(deps: BootstrapDeps): void {
  setInterceptorContextProviders({
    hormonal: () => buildHormonalSnapshot(deps.hormonal),
    gccrf: () => buildGCCRFSnapshot(deps.gccrfState ? (deps.gccrfState() as never) : null),
    channel: (sessionKey: string) => {
      const ch = deps.resolveChannel?.(sessionKey) ?? "internal";
      return ch as never;
    },
    recentTurns: (sessionKey, limit) => (deps.recentTurns?.(sessionKey, limit) ?? []) as never,
    toolHistory: (sessionKey, limit) => deps.toolHistory?.(sessionKey, limit) ?? [],
    draftReply: (sessionKey) => deps.draftReply?.(sessionKey),
    turnNumber: (sessionKey) => deps.turnNumber?.(sessionKey) ?? 0,
  });
}

export function shutdownInterceptorsForTest(): void {
  booted = false;
  clearInterceptorContextProviders();
  setInterventionStore(null);
  setInterventionSigner(null);
}
