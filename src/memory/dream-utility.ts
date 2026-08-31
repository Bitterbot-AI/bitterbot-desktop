/**
 * PLAN-40 Phase 0: the dream-utility funnel — the engine's ONLY score.
 *
 * One row per artifact a dream lane produces; a set-once consumption stamp
 * written ONLY where content provably enters a model prompt (proactive-fact
 * render in full prompt mode, memory-tool result serialization), a distilled
 * skill records an execution, or a brief is surfaced/referenced.
 *
 * Prohibited stamp sites (adversarial pass, 2026-08-10): anywhere inside
 * manager.search()/trackSearchHits (CLI and deep-recall candidacy traffic
 * would re-create the DQS vanity metric), and any selection-time path whose
 * output can be discarded before rendering (minimal prompt mode drops
 * proactive facts AFTER selection).
 *
 * This module is the single implementation both the `dream.utility` gateway
 * RPC and the doctor's dream-utility section read — the dashboard already
 * shows two divergent "insights" numbers from two implementations; the
 * funnel must not inherit that disease.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/dream-utility");

export type DreamLane = "hygiene" | "distillation" | "anticipation" | "legacy" | "evolution";
export type ConsumedKind = "retrieved" | "executed" | "surfaced" | "referenced";

function tableExists(db: DatabaseSync, table: string): boolean {
  try {
    return Boolean(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),
    );
  } catch {
    return false;
  }
}

/** Record production of a dream artifact. Idempotent per artifact_id. */
export function recordDreamArtifact(
  db: DatabaseSync,
  params: {
    lane: DreamLane;
    artifactKind: string;
    artifactId: string;
    cycleId?: string | null;
    producedAt?: number;
  },
): void {
  if (!tableExists(db, "dream_utility")) {
    return;
  }
  try {
    db.prepare(
      `INSERT OR IGNORE INTO dream_utility
         (id, lane, artifact_kind, artifact_id, produced_at, cycle_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      params.lane,
      params.artifactKind,
      params.artifactId,
      params.producedAt ?? Date.now(),
      params.cycleId ?? null,
    );
  } catch (err) {
    log.debug(`recordDreamArtifact failed: ${String(err)}`);
  }
}

/**
 * Set-once consumption stamp. A second consumption of the same artifact is
 * a no-op by design — the funnel measures "was this EVER useful", and
 * set-once semantics are what prevent double-stamp inflation across the
 * multiple render paths (adversarial F1).
 */
export function markDreamConsumption(
  db: DatabaseSync,
  artifactId: string,
  consumedKind: ConsumedKind,
  now: number = Date.now(),
): boolean {
  if (!tableExists(db, "dream_utility")) {
    return false;
  }
  try {
    const res = db
      .prepare(
        `UPDATE dream_utility
            SET first_consumed_at = ?, consumed_kind = ?
          WHERE artifact_id = ? AND first_consumed_at IS NULL`,
      )
      .run(now, consumedKind, artifactId);
    return res.changes > 0;
  } catch (err) {
    log.debug(`markDreamConsumption failed: ${String(err)}`);
    return false;
  }
}

/** Convenience: stamp many artifact ids at once (render paths batch). */
export function markDreamConsumptionMany(
  db: DatabaseSync,
  artifactIds: readonly string[],
  consumedKind: ConsumedKind,
): number {
  let stamped = 0;
  for (const id of artifactIds) {
    if (markDreamConsumption(db, id, consumedKind)) {
      stamped++;
    }
  }
  return stamped;
}

export type LaneFunnel = {
  lane: string;
  produced: number;
  consumed: number;
  /** 0..1; null when nothing was produced in the window. */
  consumedRate: number | null;
  byKind: Record<string, number>;
};

/**
 * The shared funnel query — consumed by the dream.utility RPC AND the
 * doctor. windowDays bounds production age; consumption of an in-window
 * artifact counts whenever it happened.
 */
export function getDreamUtilityFunnel(
  db: DatabaseSync,
  params: { windowDays?: number; now?: number } = {},
): LaneFunnel[] {
  if (!tableExists(db, "dream_utility")) {
    return [];
  }
  const now = params.now ?? Date.now();
  const cutoff = params.windowDays ? now - params.windowDays * 86_400_000 : 0;
  try {
    const rows = db
      .prepare(
        `SELECT lane, consumed_kind,
                COUNT(*) AS produced,
                SUM(CASE WHEN first_consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed
           FROM dream_utility
          WHERE produced_at >= ?
          GROUP BY lane, consumed_kind`,
      )
      .all(cutoff) as Array<{
      lane: string;
      consumed_kind: string | null;
      produced: number;
      consumed: number;
    }>;
    const byLane = new Map<string, LaneFunnel>();
    for (const r of rows) {
      let entry = byLane.get(r.lane);
      if (!entry) {
        entry = { lane: r.lane, produced: 0, consumed: 0, consumedRate: null, byKind: {} };
        byLane.set(r.lane, entry);
      }
      entry.produced += r.produced;
      entry.consumed += r.consumed ?? 0;
      if (r.consumed_kind && (r.consumed ?? 0) > 0) {
        entry.byKind[r.consumed_kind] = (entry.byKind[r.consumed_kind] ?? 0) + (r.consumed ?? 0);
      }
    }
    for (const entry of byLane.values()) {
      entry.consumedRate = entry.produced > 0 ? entry.consumed / entry.produced : null;
    }
    return [...byLane.values()].toSorted((a, b) => a.lane.localeCompare(b.lane));
  } catch (err) {
    log.debug(`getDreamUtilityFunnel failed: ${String(err)}`);
    return [];
  }
}

/**
 * Hold wake-up counters for the doctor (PLAN-40 §8: wake criteria must be
 * visible, not remembered).
 */
export function getDreamHoldCounters(db: DatabaseSync): Array<{
  hold: string;
  current: number;
  wakeAt: number;
}> {
  const counters: Array<{ hold: string; current: number; wakeAt: number }> = [];
  const count = (sql: string): number => {
    try {
      return (db.prepare(sql).get() as { c: number }).c;
    } catch {
      return -1;
    }
  };
  counters.push({
    hold: "harness_evolve (completed executions)",
    current: count(`SELECT COUNT(*) AS c FROM skill_executions WHERE completed_at IS NOT NULL`),
    wakeAt: 25,
  });
  counters.push({
    hold: "interceptor_harvest (outcome-tagged records)",
    current: count(`SELECT COUNT(*) AS c FROM intervention_records WHERE outcome_tag IS NOT NULL`),
    wakeAt: 10,
  });
  counters.push({
    hold: "relationship_reconsolidation (active relationships)",
    current: count(`SELECT COUNT(*) AS c FROM relationships WHERE valid_until IS NULL`),
    wakeAt: 100,
  });
  return counters;
}
