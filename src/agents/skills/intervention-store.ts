/**
 * PLAN-20 Phase 2: SQLite-backed InterventionStore.
 *
 * Append-only writes against the v14 `intervention_records` table. Outcome
 * signals are backfilled later via attachOutcome(); no other columns are
 * mutated post-insert.
 */

import type { DatabaseSync } from "node:sqlite";
import type { InterventionStore } from "./intervention-record.js";
import type { InterventionRecord, OutcomeSignal } from "./intervention-record.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/skills/interventions");

export function createSqliteInterventionStore(db: DatabaseSync): InterventionStore {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO intervention_records (
      id, ts, session_key, skill, interceptor_id, channel, tool_name,
      intervention_type, action_original_json, action_final_json,
      intervention_json, state_summary_json,
      activation_latency_ms, intervention_latency_ms,
      ed25519_sig, pubkey_id, record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateOutcomeStmt = db.prepare(`
    UPDATE intervention_records
       SET outcome_tag = ?,
           outcome_evidence = ?
     WHERE id = ?
       AND outcome_tag IS NULL
  `);

  const recentStmt = db.prepare(`
    SELECT record_json
      FROM intervention_records
     ORDER BY ts DESC
     LIMIT ?
  `);

  const recentBySessionStmt = db.prepare(`
    SELECT record_json
      FROM intervention_records
     WHERE session_key = ?
     ORDER BY ts DESC
     LIMIT ?
  `);

  return {
    insert(rec: InterventionRecord): void {
      try {
        insertStmt.run(
          rec.id,
          rec.ts,
          rec.sessionKey,
          rec.skill,
          rec.interceptorId,
          rec.stateSummary.channel,
          rec.actionOriginal.toolName,
          rec.intervention.type,
          JSON.stringify(rec.actionOriginal),
          rec.actionFinal ? JSON.stringify(rec.actionFinal) : null,
          JSON.stringify(rec.intervention),
          JSON.stringify(rec.stateSummary),
          rec.metadata.activationLatencyMs,
          rec.metadata.interventionLatencyMs,
          rec.sig.ed25519,
          rec.sig.pubkeyId,
          JSON.stringify(rec),
        );
      } catch (err) {
        log.warn(`insert intervention record failed: id=${rec.id} err=${String(err)}`);
      }
    },

    attachOutcome(id: string, signal: OutcomeSignal): void {
      try {
        const evidence = signal.tag === "no-signal" ? null : signal.evidence;
        updateOutcomeStmt.run(signal.tag, evidence ?? null, id);
      } catch (err) {
        log.warn(`attach outcome failed: id=${id} err=${String(err)}`);
      }
    },

    recent(args: { limit?: number; sessionKey?: string }): InterventionRecord[] {
      const limit = Math.max(1, Math.min(1000, args.limit ?? 50));
      try {
        const rows = args.sessionKey
          ? (recentBySessionStmt.all(args.sessionKey, limit) as Array<{ record_json: string }>)
          : (recentStmt.all(limit) as Array<{ record_json: string }>);
        return rows
          .map((r) => {
            try {
              return JSON.parse(r.record_json) as InterventionRecord;
            } catch {
              return null;
            }
          })
          .filter((r): r is InterventionRecord => r !== null);
      } catch (err) {
        log.warn(`recent intervention records failed: err=${String(err)}`);
        return [];
      }
    },
  };
}
