/**
 * PLAN-20 Phase 2 (outcome loop): infer outcome signals for recent
 * intervention records based on subsequent user messages.
 *
 * Heuristics over the next 1-3 user turns after an intervention:
 *  - thanks / good / yes / works / great           → downstream-success
 *  - that's wrong / no / try again / again / not   → downstream-failure
 *  - confirm / yes do it / proceed                 → user-overrode-block (for block-type)
 *  - cancel / don't / stop / abort                 → user-confirmed-block (for block-type)
 *
 * Pure side-effect module. Called from the chat.send handler after the
 * user turn is recorded. Records are matched by session + recency window.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OutcomeSignal } from "./intervention-record.js";
import { loadConfig } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agent-scope.js";

const log = createSubsystemLogger("agents/skills/outcome-backfill");

const SUCCESS_RX =
  /\b(thanks|thank you|thx|nice|perfect|great|works|good|exactly|yes that|that's right|right)\b/i;
const FAILURE_RX =
  /\b(wrong|no that's not|not what I|try again|nope|that's not it|again please|huh|what)\b/i;
const OVERRIDE_BLOCK_RX = /\b(yes do it|proceed|confirm|go ahead|do it anyway|continue)\b/i;
const CONFIRM_BLOCK_RX = /\b(cancel|don't|stop|abort|skip|never mind|nvm)\b/i;

/** Window past the intervention where we accept a follow-up signal. */
const RECENCY_WINDOW_MS = 5 * 60_000;
/** Backfill at most this many records per call (DB safety). */
const MAX_BACKFILLS_PER_CALL = 6;

interface PendingRow {
  id: string;
  ts: number;
  intervention_type: string;
}

/**
 * Convenience wrapper: opens (and closes) the agent's memory DB itself,
 * so callers in the gateway don't need to know the path. Returns
 * silently on any failure.
 */
export function backfillFromUserMessage(sessionKey: string, userText: string): void {
  if (!sessionKey || !userText) return;
  const dbPath = resolveDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;`);
    backfillOutcomesFromUserMessage({ db, sessionKey, userText });
  } catch (err) {
    log.debug(`backfill open failed: ${String(err)}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}

function resolveDbPath(): string | null {
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
  } catch {
    return null;
  }
}

export function backfillOutcomesFromUserMessage(args: {
  db: DatabaseSync | null;
  sessionKey: string;
  userText: string;
  nowMs?: number;
}): void {
  if (!args.db || !args.sessionKey || !args.userText) return;
  const now = args.nowMs ?? Date.now();
  const cutoff = now - RECENCY_WINDOW_MS;
  const text = args.userText.toLowerCase();

  // Pick a single outcome tag based on first-matching rule (priority below
  // — override/confirm before success/failure since they're stronger).
  let signal: OutcomeSignal | null = null;
  if (OVERRIDE_BLOCK_RX.test(text)) {
    signal = { tag: "user-overrode-block", evidence: clip(args.userText) };
  } else if (CONFIRM_BLOCK_RX.test(text)) {
    signal = { tag: "user-confirmed-block", evidence: clip(args.userText) };
  } else if (SUCCESS_RX.test(text)) {
    signal = { tag: "downstream-success", evidence: clip(args.userText) };
  } else if (FAILURE_RX.test(text)) {
    signal = { tag: "downstream-failure", evidence: clip(args.userText) };
  }
  if (!signal) return;

  // Block-specific outcomes only apply to block-type interventions; we
  // partition the query so generic success/failure doesn't overwrite
  // block-specific outcomes.
  const isBlockSpecific =
    signal.tag === "user-overrode-block" || signal.tag === "user-confirmed-block";

  let rows: PendingRow[] = [];
  try {
    if (isBlockSpecific) {
      rows = args.db
        .prepare(
          `SELECT id, ts, intervention_type
             FROM intervention_records
            WHERE session_key = ?
              AND ts >= ?
              AND outcome_tag IS NULL
              AND intervention_type = 'block'
            ORDER BY ts DESC
            LIMIT ?`,
        )
        .all(args.sessionKey, cutoff, MAX_BACKFILLS_PER_CALL) as unknown as PendingRow[];
    } else {
      rows = args.db
        .prepare(
          `SELECT id, ts, intervention_type
             FROM intervention_records
            WHERE session_key = ?
              AND ts >= ?
              AND outcome_tag IS NULL
              AND intervention_type != 'block'
            ORDER BY ts DESC
            LIMIT ?`,
        )
        .all(args.sessionKey, cutoff, MAX_BACKFILLS_PER_CALL) as unknown as PendingRow[];
    }
  } catch (err) {
    log.debug(`backfill query failed: ${String(err)}`);
    return;
  }

  if (rows.length === 0) return;

  const update = args.db.prepare(
    `UPDATE intervention_records SET outcome_tag = ?, outcome_evidence = ? WHERE id = ? AND outcome_tag IS NULL`,
  );
  const evidence = "evidence" in signal ? signal.evidence : null;
  for (const row of rows) {
    try {
      update.run(signal.tag, evidence, row.id);
    } catch (err) {
      log.debug(`backfill update failed for id=${row.id}: ${String(err)}`);
    }
  }
  log.debug(
    `backfilled ${rows.length} intervention record(s) for session=${args.sessionKey} signal=${signal.tag}`,
  );
}

function clip(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
