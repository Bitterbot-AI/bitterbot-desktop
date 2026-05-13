/**
 * Helper for gateway-side code that needs a SkillLifecycleStore but does not
 * already own a memory-DB connection.
 *
 * The agent runner owns a DB connection (manager-sync-ops.ts opens with WAL +
 * synchronous=NORMAL). The gateway server runs in the same process today, so
 * we open a second connection in WAL mode — multiple readers + one writer is
 * supported by SQLite's WAL journal mode. The connection is short-lived: we
 * open, query, mutate, and close per gateway call.
 *
 * If the gateway moves out of process later, this helper becomes the single
 * point we have to redirect to an RPC instead.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { SkillLifecycleStore } from "../../memory/skill-lifecycle.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agent-scope.js";

const log = createSubsystemLogger("skills/lifecycle-from-config");

function resolveAgentDbPath(cfg: BitterbotConfig, agentId: string): string {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
  const raw = overrides?.store?.path ?? defaults?.store?.path;
  if (raw) {
    const withToken = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw;
    return resolveUserPath(withToken);
  }
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "memory", `${agentId}.sqlite`);
}

/**
 * Open a DB connection for the requested agent, ensure the index schema and
 * migrations are current, and yield a SkillLifecycleStore bound to it. The
 * caller is responsible for invoking `result.close()` when done.
 */
export function openSkillLifecycleStore(params: {
  config: BitterbotConfig;
  agentId?: string;
}): { store: SkillLifecycleStore; close: () => void } | null {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  if (!agentId) {
    return null;
  }
  const dbPath = resolveAgentDbPath(params.config, agentId);
  try {
    // Synchronous mkdir so the directory exists before sqlite opens.
    // ensureDir from utils is async and we keep this helper sync to match
    // node:sqlite's own sync API.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    // Match the agent runner's pragmas so we co-exist cleanly with the
    // long-lived writer connection. WAL is required for the second
    // connection to read while the runner writes.
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;`);
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
    const store = new SkillLifecycleStore(db);
    return {
      store,
      close: () => {
        try {
          db.close();
        } catch (err) {
          log.debug(`close failed: ${String(err)}`);
        }
      },
    };
  } catch (err) {
    log.warn(`failed to open lifecycle store at ${dbPath}: ${String(err)}`);
    return null;
  }
}

/**
 * Convenience wrapper: open, run a callback, close. Logs and swallows
 * open failures so callers can degrade gracefully (the regression-baseline
 * branch of the gate is "best effort" — the schema and injection checks
 * still fire even when the lifecycle DB is unavailable).
 */
export async function withSkillLifecycleStore<T>(
  params: { config: BitterbotConfig; agentId?: string },
  fn: (store: SkillLifecycleStore | null) => Promise<T>,
): Promise<T> {
  const handle = openSkillLifecycleStore(params);
  try {
    return await fn(handle?.store ?? null);
  } finally {
    handle?.close();
  }
}
