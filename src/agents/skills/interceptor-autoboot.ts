/**
 * PLAN-20: lazy, idempotent bootstrap for the interceptor subsystem.
 *
 * Called from `runInterceptors` on first invocation. Self-contained — does
 * not require explicit hooks from the gateway boot path. Best-effort: if
 * any piece fails (no DB, no identity key, no memory manager), the
 * subsystem degrades gracefully and the interceptor still runs with
 * neutral state.
 *
 * What it wires:
 *  1. The 4 built-in interceptors are registered.
 *  2. A DatabaseSync handle is opened against the agent memory store and
 *     bound as the InterventionStore (records get persisted).
 *  3. The device-identity Ed25519 keypair is loaded and registered as the
 *     intervention signer (records get signed).
 *  4. Hormonal + GCCRF snapshot providers are bound to the lazy
 *     MemoryIndexManager.get() singleton.
 *  5. Channel resolution and turn-number providers are stubbed for the
 *     gateway runtime; the desktop UI fills in `internal` as the channel
 *     for direct chat sessions.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agent-scope.js";
import { bootstrapInterceptors } from "./interceptor-bootstrap.js";
import { getInterceptorRegistry } from "./interceptor-registry.js";
import {
  createSqliteInterceptorStrikesStore,
  setInterceptorStrikesStore,
} from "./interceptor-strikes-store.js";
import { getInterventionStore, setInterventionStore } from "./intervention-record.js";
import {
  getRecentTurns,
  getSessionChannel,
  getToolHistory,
  getTurnNumber,
} from "./session-context-tracker.js";

const log = createSubsystemLogger("agents/skills/interceptors");

let booted = false;
let bootedAt = 0;

function resolveAgentDbPath(): string | null {
  try {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    if (!agentId) return null;
    const defaults = cfg.agents?.defaults?.memorySearch;
    const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
    const raw = overrides?.store?.path ?? defaults?.store?.path;
    if (raw) {
      const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
      return resolveUserPath(withToken);
    }
    const stateDir = resolveStateDir(process.env, os.homedir);
    return path.join(stateDir, "memory", `${agentId}.sqlite`);
  } catch (err) {
    log.debug(`resolve agent db path failed: ${String(err)}`);
    return null;
  }
}

function tryOpenInterventionDb(): DatabaseSync | null {
  const dbPath = resolveAgentDbPath();
  if (!dbPath) return null;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;`);
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
    return db;
  } catch (err) {
    log.debug(`open intervention db failed at ${dbPath}: ${String(err)}`);
    return null;
  }
}

function buildSigner(): ((canonicalJson: string) => { ed25519: string; pubkeyId: string }) | null {
  try {
    const identity = loadOrCreateDeviceIdentity();
    const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
    return (canonical: string) => {
      const sigBytes = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);
      return {
        ed25519: sigBytes.toString("base64"),
        pubkeyId: identity.deviceId,
      };
    };
  } catch (err) {
    log.debug(`build signer failed: ${String(err)}`);
    return null;
  }
}

async function buildMemoryManagerAccessor(): Promise<() => unknown | null> {
  // Returns a cached lazy accessor — first call resolves the manager
  // singleton, subsequent calls reuse it. The manager itself owns its
  // hormonal + GCCRF state.
  let cached: unknown | null = null;
  let resolving: Promise<unknown | null> | null = null;
  return () => {
    if (cached) return cached;
    if (!resolving) {
      resolving = (async () => {
        try {
          const cfg = loadConfig();
          const agentId = resolveDefaultAgentId(cfg);
          if (!agentId) return null;
          const { MemoryIndexManager } = await import("../../memory/manager.js");
          const mgr = await MemoryIndexManager.get({
            cfg,
            agentId,
            purpose: "default",
          });
          cached = mgr ?? null;
          return cached;
        } catch (err) {
          log.debug(`resolve memory manager failed: ${String(err)}`);
          return null;
        }
      })();
    }
    // Don't await synchronously — the provider returns null until ready.
    void resolving;
    return cached;
  };
}

function readConfigDisabledList(): string[] {
  try {
    const cfg = loadConfig() as unknown as {
      interceptors?: { disabled?: unknown };
    };
    const raw = cfg.interceptors?.disabled;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

export function ensureInterceptorsAutoBoot(): void {
  if (booted) return;
  // In tests, allow callers to install their own intervention store +
  // signer before any interceptor fires. If either has been registered,
  // we still register builtins but skip the heavy device-identity /
  // memory-manager init that would clobber the test setup.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    booted = true;
    bootedAt = Date.now();
    // Builtins still need to be registered so the registry has the four
    // reference interceptors available. State providers and store stay
    // as whatever the test wired.
    void import("./builtin-interceptors/index.js").then((m) => {
      m.registerBuiltinInterceptors();
    });
    return;
  }
  booted = true;
  bootedAt = Date.now();

  const db = tryOpenInterventionDb();
  const signer = buildSigner();

  // Apply operator-level disabled list (from bitterbot.json `interceptors.disabled`).
  // Each entry can be a skill name or a specific interceptor id.
  try {
    const disabled = readConfigDisabledList();
    if (disabled.length > 0) {
      getInterceptorRegistry().setConfigDisabledList(disabled);
      log.debug(
        `interceptors: ${disabled.length} entries disabled by config: ${disabled.join(", ")}`,
      );
    }
  } catch (err) {
    log.debug(`read disabled list failed: ${String(err)}`);
  }

  // Wire the persistent strike counter (PLAN-20 follow-up). Interceptors
  // that crossed the 3-strikes threshold in a prior session stay disabled.
  if (db) {
    try {
      const strikesStore = createSqliteInterceptorStrikesStore(db);
      setInterceptorStrikesStore(strikesStore);
      const persistedDisabled = strikesStore.loadDisabled();
      if (persistedDisabled.length > 0) {
        getInterceptorRegistry().loadPersistedDisabled(persistedDisabled);
        log.debug(
          `interceptors: ${persistedDisabled.length} persisted as disabled: ${persistedDisabled.join(", ")}`,
        );
      }
    } catch (err) {
      log.debug(`wire strikes store failed: ${String(err)}`);
    }
  }

  // The memory-manager accessor is async-cached; we hand bootstrap a sync
  // getter that returns null until the lazy resolution completes.
  let mgrAccessor: () => unknown | null = () => null;
  void buildMemoryManagerAccessor().then((acc) => {
    mgrAccessor = acc;
    log.debug(`interceptors: memory manager accessor ready`);
  });

  bootstrapInterceptors({
    db,
    signer,
    hormonal: null, // resolved on each call via mgrAccessor below
    gccrfState: () => {
      const mgr = mgrAccessor();
      if (!mgr || typeof mgr !== "object") return null;
      const diag = (mgr as { gccrfDiagnostics?: () => unknown }).gccrfDiagnostics?.();
      return diag ?? null;
    },
    resolveChannel: (sessionKey) => getSessionChannel(sessionKey),
    draftReply: () => undefined,
    recentTurns: (sessionKey, limit) => getRecentTurns(sessionKey, limit) as never,
    toolHistory: (sessionKey, limit) => getToolHistory(sessionKey, limit) as never,
    turnNumber: (sessionKey) => getTurnNumber(sessionKey),
  });

  // Re-bind hormonal provider once mgrAccessor is ready (the void promise
  // above sets `cached`; we re-call bootstrapInterceptors which is
  // idempotent and just refreshes providers).
  void (async () => {
    // Wait briefly for mgrAccessor to populate; bounded loop.
    for (let i = 0; i < 40; i++) {
      const mgr = mgrAccessor();
      if (mgr) {
        bootstrapInterceptors({
          db,
          signer,
          hormonal: (mgr as { hormonalManager?: unknown }).hormonalManager as never,
          gccrfState: () => {
            const m = mgrAccessor();
            if (!m || typeof m !== "object") return null;
            const diag = (m as { gccrfDiagnostics?: () => unknown }).gccrfDiagnostics?.();
            return diag ?? null;
          },
          resolveChannel: (sessionKey) => getSessionChannel(sessionKey),
          recentTurns: (sessionKey, limit) => getRecentTurns(sessionKey, limit) as never,
          toolHistory: (sessionKey, limit) => getToolHistory(sessionKey, limit) as never,
          turnNumber: (sessionKey) => getTurnNumber(sessionKey),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  log.debug(
    `interceptors autoboot: db=${db ? "ok" : "none"} signer=${signer ? "ok" : "none"} ts=${bootedAt}`,
  );
}

export function resetInterceptorAutoBootForTest(): void {
  booted = false;
  bootedAt = 0;
}
