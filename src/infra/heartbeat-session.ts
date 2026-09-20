/**
 * Heartbeat session resolution: which store key a tick runs in, how the main
 * entry's idle clock is preserved, and the isolated `<base>:heartbeat` session
 * used by schedule-driven ticks (token-efficiency build, 2026-09-19).
 */

import fs from "node:fs/promises";
import type { BitterbotConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
  updateSessionStore,
} from "../config/sessions.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

export const HEARTBEAT_SESSION_SUFFIX = "heartbeat";

export function resolveHeartbeatSession(
  cfg: BitterbotConfig,
  agentId?: string,
  heartbeat?: HeartbeatConfig,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: resolvedAgentId });
  const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const store = loadSessionStore(storePath);
  const mainEntry = store[mainSessionKey];

  if (scope === "global") {
    return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed) {
    return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "main" || normalized === "global") {
    return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    requestKey: trimmed,
    mainKey: cfg.session?.mainKey,
  });
  const canonical = canonicalizeMainSessionAlias({
    cfg,
    agentId: resolvedAgentId,
    sessionKey: candidate,
  });
  if (canonical !== "global") {
    const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
    if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
      return {
        sessionKey: canonical,
        storePath,
        store,
        entry: store[canonical],
        explicitSession: canonical !== mainSessionKey,
      };
    }
  }

  return { sessionKey: mainSessionKey, storePath, store, entry: mainEntry };
}

export async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") {
    return;
  }
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
  if (entry.updatedAt === nextUpdatedAt) {
    return;
  }
  await updateSessionStore(storePath, (nextStore) => {
    const nextEntry = nextStore[sessionKey] ?? entry;
    if (!nextEntry) {
      return;
    }
    const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
    if (nextEntry.updatedAt === resolvedUpdatedAt) {
      return;
    }
    nextStore[sessionKey] = { ...nextEntry, updatedAt: resolvedUpdatedAt };
  });
}

// ── Isolated session ──

export function resolveIsolatedHeartbeatSessionKey(baseSessionKey: string): string {
  return `${baseSessionKey}:${HEARTBEAT_SESSION_SUFFIX}`;
}

export function isIsolatedHeartbeatSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  const rest = parsed.rest.toLowerCase();
  return rest === HEARTBEAT_SESSION_SUFFIX || rest.endsWith(`:${HEARTBEAT_SESSION_SUFFIX}`);
}

/**
 * Whether this tick may run isolated: the flag is on, the operator did not pin
 * `heartbeat.session` to a specific (non-main) session, the base key is a real
 * `agent:<id>:...` key (a `global` scope has no agent-scoped store key), and
 * nothing is queued for the base session. Queued system events are drained by
 * the session that runs, so a tick that must surface them stays in the main
 * session where they were enqueued.
 */
export function shouldRunHeartbeatIsolated(params: {
  heartbeat?: HeartbeatConfig;
  baseSessionKey: string;
  pendingEventCount: number;
  /** True when `heartbeat.session` resolved to a non-main session (operator wants that context). */
  explicitSession?: boolean;
}): boolean {
  if (params.heartbeat?.isolatedSession === false) {
    return false;
  }
  if (params.explicitSession) {
    return false;
  }
  if (!parseAgentSessionKey(params.baseSessionKey)) {
    return false;
  }
  return params.pendingEventCount === 0;
}

/**
 * Give the isolated heartbeat session a fresh transcript: drop its store entry
 * (so the next run mints a new sessionId) and unlink the previous transcript
 * file. The transcript only ever held heartbeat prompt / HEARTBEAT_OK pairs,
 * which are noise for memory extraction and never part of the main history.
 * Best-effort: any failure leaves the old entry in place and the run proceeds.
 */
export async function resetIsolatedHeartbeatSession(params: {
  storePath: string;
  sessionKey: string;
  agentId: string;
}): Promise<void> {
  const { storePath, sessionKey, agentId } = params;
  let previous: { sessionId?: string; sessionFile?: string } | undefined;
  try {
    previous = loadSessionStore(storePath)[sessionKey];
  } catch {
    return;
  }
  if (!previous) {
    return;
  }
  try {
    await updateSessionStore(storePath, (store) => {
      delete store[sessionKey];
    });
  } catch {
    return;
  }
  if (!previous.sessionId) {
    return;
  }
  try {
    const transcriptPath = resolveSessionFilePath(
      previous.sessionId,
      previous,
      resolveSessionFilePathOptions({ agentId, storePath }),
    );
    await fs.unlink(transcriptPath);
  } catch {
    // Missing transcript is the common case (a tick that never wrote one).
  }
}
