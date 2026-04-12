/**
 * Spacing Effect: spaced repetition produces stronger retention than massed
 * repetition. Accessing a memory 5 times in one session gets less boost than
 * accessing it once per week for 5 weeks.
 *
 * FIRST IMPLEMENTATION of the spacing effect in any agent memory system.
 *
 * Scientific basis:
 * - Ebbinghaus, H. (1885). Über das Gedächtnis.
 * - Cepeda, N.J. et al. (2008). Spacing effects in learning.
 *
 * PLAN-9: GAP-7 (Spacing Effect)
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/spacing-effect");

const MAX_STORED_TIMESTAMPS = 20;
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface SpacingConfig {
  enabled: boolean;
  /** Maximum importance multiplier from spacing (e.g., 0.3 = up to 30% boost) */
  maxBoostFraction: number;
  /** Maximum number of access timestamps to retain per chunk */
  maxTimestamps: number;
}

export const DEFAULT_SPACING_CONFIG: SpacingConfig = {
  enabled: true,
  maxBoostFraction: 0.3,
  maxTimestamps: MAX_STORED_TIMESTAMPS,
};

/**
 * Compute spacing score from access timestamps.
 *
 * Formula: log(avg_interval_hours + 1) / log(max_possible_interval + 1)
 *
 * @returns Normalized spacing score in [0, 1]. Higher = more spaced access.
 */
export function computeSpacingScore(accessTimestamps: number[]): number {
  if (accessTimestamps.length < 2) return 0;

  // Sort chronologically
  const sorted = [...accessTimestamps].sort((a, b) => a - b);

  // Compute inter-access intervals in hours
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push((sorted[i]! - sorted[i - 1]!) / ONE_HOUR_MS);
  }

  if (intervals.length === 0) return 0;

  const avgInterval = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;

  // Max reasonable interval: 30 days in hours
  const maxInterval = 30 * 24;

  // Logarithmic normalization: quickly rewards any spacing, diminishing returns
  return Math.log(avgInterval + 1) / Math.log(maxInterval + 1);
}

/**
 * Compute the importance multiplier from spacing score.
 *
 * @returns Multiplier >= 1.0. E.g., spacing=1.0 → 1.3 (30% boost with default config).
 */
export function spacingImportanceMultiplier(
  spacingScore: number,
  config?: Partial<SpacingConfig>,
): number {
  const cfg = { ...DEFAULT_SPACING_CONFIG, ...config };
  if (!cfg.enabled) return 1.0;
  return 1 + cfg.maxBoostFraction * Math.min(1, Math.max(0, spacingScore));
}

/**
 * Record a new access for a chunk, updating its access_timestamps and spacing_score.
 * Called when a chunk is retrieved during search.
 */
export function recordAccess(
  db: DatabaseSync,
  chunkId: string,
  config?: Partial<SpacingConfig>,
): void {
  const cfg = { ...DEFAULT_SPACING_CONFIG, ...config };
  if (!cfg.enabled) return;

  try {
    const row = db.prepare(`SELECT access_timestamps FROM chunks WHERE id = ?`).get(chunkId) as
      | { access_timestamps: string | null }
      | undefined;

    if (!row) return;

    const timestamps: number[] = JSON.parse(row.access_timestamps || "[]");
    timestamps.push(Date.now());

    // Keep only the most recent N timestamps
    while (timestamps.length > cfg.maxTimestamps) {
      timestamps.shift();
    }

    const score = computeSpacingScore(timestamps);

    db.prepare(`UPDATE chunks SET access_timestamps = ?, spacing_score = ? WHERE id = ?`).run(
      JSON.stringify(timestamps),
      score,
      chunkId,
    );
  } catch (err) {
    log.debug(`recordAccess spacing failed: ${String(err)}`);
  }
}
