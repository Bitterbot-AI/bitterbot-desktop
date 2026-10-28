/**
 * GCCRF State Persistence Layer
 *
 * Manages serialization/deserialization of GCCRF state to SQLite.
 * The reward function is stateful (normalizers, per-region EMAs, eta window)
 * and must survive restarts.
 *
 * State is stored as JSON blobs in a key-value table (gccrf_state).
 */

import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./memory-schema.js";

// ── State Types ──

export interface GCCRFNormalizerState {
  mean: number;
  variance: number;
  count: number;
}

export interface GCCRFState {
  normalizers: Record<string, GCCRFNormalizerState>;
  regionEta: Record<string, { emaLong: number; emaShort: number; sampleCount: number }>;
  recentEtas: number[];
  totalChunksProcessed: number;
  /**
   * Scoring version the normalizer statistics were accumulated under. The
   * density component changed units in v2 (shared bandwidth over raw cosine
   * distance instead of a per-query contrast stretch) and learning progress
   * stopped being EMA-normalized, so statistics from an older version are
   * discarded once on load instead of being mixed in. Absent on legacy rows.
   */
  scoringVersion?: string;
  /** FSHO order-parameter EMA, so optional alpha coupling survives a restart. */
  fshoRAvg?: number;
}

/** Bump when a component changes units; see GCCRFState.scoringVersion. */
export const GCCRF_SCORING_VERSION = "gccrf-v2";

// ── Schema ──

export function ensureGCCRFSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gccrf_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
  `);

  // Add curiosity_reward column to chunks table for per-chunk GCCRF reward storage
  ensureColumn(db, "chunks", "curiosity_reward", "REAL DEFAULT NULL");
}

// ── Save / Load ──

export function saveGCCRFState(db: DatabaseSync, state: GCCRFState): void {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO gccrf_state (key, value, updated_at) VALUES (?, ?, ?)`,
  );

  // Save normalizers as a single JSON blob
  stmt.run("normalizers", JSON.stringify(state.normalizers), now);

  // Save region ETA state as a single JSON blob
  stmt.run("region_eta", JSON.stringify(state.regionEta), now);

  // Save recent etas window
  stmt.run("recent_etas", JSON.stringify(state.recentEtas), now);

  // Save total chunks processed counter
  stmt.run("total_chunks_processed", String(state.totalChunksProcessed), now);

  // Version stamp for the normalizer statistics, and the FSHO EMA
  stmt.run("scoring_version", state.scoringVersion ?? GCCRF_SCORING_VERSION, now);
  if (typeof state.fshoRAvg === "number" && Number.isFinite(state.fshoRAvg)) {
    stmt.run("fsho_r_avg", String(state.fshoRAvg), now);
  }
}

export function loadGCCRFState(db: DatabaseSync): GCCRFState | null {
  try {
    const stmt = db.prepare(`SELECT key, value FROM gccrf_state`);
    const rows = stmt.all() as Array<{ key: string; value: string }>;

    if (rows.length === 0) {
      return null;
    }

    const map = new Map(rows.map((r) => [r.key, r.value]));

    const normalizers = map.has("normalizers")
      ? (JSON.parse(map.get("normalizers")!) as Record<string, GCCRFNormalizerState>)
      : {};

    const regionEta = map.has("region_eta")
      ? (JSON.parse(map.get("region_eta")!) as Record<
          string,
          { emaLong: number; emaShort: number; sampleCount: number }
        >)
      : {};

    const recentEtas = map.has("recent_etas")
      ? (JSON.parse(map.get("recent_etas")!) as number[])
      : [];

    const totalChunksProcessed = map.has("total_chunks_processed")
      ? Number(map.get("total_chunks_processed")!)
      : 0;

    const scoringVersion = map.get("scoring_version");
    const fshoRaw = map.has("fsho_r_avg") ? Number(map.get("fsho_r_avg")!) : NaN;

    return {
      normalizers,
      regionEta,
      recentEtas,
      totalChunksProcessed,
      ...(scoringVersion ? { scoringVersion } : {}),
      ...(Number.isFinite(fshoRaw) ? { fshoRAvg: fshoRaw } : {}),
    };
  } catch {
    return null;
  }
}
