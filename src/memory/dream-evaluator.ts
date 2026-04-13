/**
 * Dream Outcome Evaluator — closes the telemetry feedback loop.
 *
 * Scores each dream cycle on a composite Dream Quality Score (DQS),
 * correlates with input signals (FSHO R, curiosity targets, GCCRF maturity),
 * and provides data for future adaptive weight tuning.
 *
 * Plan 7, Phase 5.
 */

import type { DatabaseSync } from "node:sqlite";
import type { DreamStats } from "./dream-types.js";

export interface DreamOutcomeComponents {
  crystalYield: number;
  mergeEfficiency: number;
  orphanRescue: number;
  bondStability: number;
  tokenEfficiency: number;
}

export interface DreamOutcome {
  cycleId: string;
  dqs: number;
  components: DreamOutcomeComponents;
  inputSignals: {
    fshoR?: number;
    curiosityTargets: number;
    gccrfMaturity: number;
    readinessScore: number;
  };
  modesRun: string[];
  timestamp: number;
}

const DQS_WEIGHTS = {
  crystalYield: 0.25,
  mergeEfficiency: 0.15,
  orphanRescue: 0.15,
  bondStability: 0.3,
  tokenEfficiency: 0.15,
};

/**
 * Evaluate a completed dream cycle and compute the Dream Quality Score.
 */
export function evaluateDreamOutcome(params: {
  cycleId: string;
  db: DatabaseSync;
  stats: DreamStats;
  bondValidation?: { bondDriftRatio?: number };
  tokenBudget: number;
  tokensUsed: number;
  curiosityTargets?: number;
  gccrfMaturity?: number;
}): DreamOutcome {
  const { cycleId, db, stats, bondValidation, tokenBudget, tokensUsed } = params;

  const llmCalls = stats.cycle.llmCallsUsed || 1;
  const newInsights = stats.newInsights.length;

  // Crystal yield: new insights per LLM call
  const crystalYield = Math.min(1, newInsights / llmCalls);

  // Merge efficiency: from telemetry if available
  let mergeEfficiency = 1.0;
  try {
    const mergeRow = db
      .prepare(
        `SELECT metric_value FROM dream_telemetry
         WHERE cycle_id = ? AND phase = 'snn_merge' AND metric_name = 'hints_consumed'`,
      )
      .get(cycleId) as { metric_value: number } | undefined;
    if (mergeRow && mergeRow.metric_value > 0) {
      // If hints were consumed, that's a positive signal
      mergeEfficiency = Math.min(1, mergeRow.metric_value / 5);
    }
  } catch {
    // Table may not exist
  }

  // Orphan rescue rate
  let orphanRescue = 1.0;
  try {
    const rippleRow = db
      .prepare(
        `SELECT metric_value FROM dream_telemetry
         WHERE cycle_id = ? AND phase = 'ripple' AND metric_name = 'orphan_seeds'`,
      )
      .get(cycleId) as { metric_value: number } | undefined;
    if (rippleRow) {
      orphanRescue = rippleRow.metric_value > 0 ? 1.0 : 0.5;
    }
  } catch {
    // non-critical
  }

  // Bond stability
  const bondStability =
    bondValidation?.bondDriftRatio !== undefined
      ? bondValidation.bondDriftRatio >= 0.3
        ? 1.0
        : 0.0
      : 1.0;

  // Token efficiency
  const tokenEfficiency = tokenBudget > 0 ? 1 - Math.min(1, tokensUsed / tokenBudget) : 1.0;

  // Composite DQS
  const dqs =
    DQS_WEIGHTS.crystalYield * crystalYield +
    DQS_WEIGHTS.mergeEfficiency * mergeEfficiency +
    DQS_WEIGHTS.orphanRescue * orphanRescue +
    DQS_WEIGHTS.bondStability * bondStability +
    DQS_WEIGHTS.tokenEfficiency * tokenEfficiency;

  // Retrieve FSHO R from telemetry
  let fshoR: number | undefined;
  try {
    const row = db
      .prepare(
        `SELECT metric_value FROM dream_telemetry
         WHERE cycle_id = ? AND phase = 'fsho' AND metric_name = 'order_parameter'`,
      )
      .get(cycleId) as { metric_value: number } | undefined;
    fshoR = row?.metric_value;
  } catch {
    // non-critical
  }

  // Retrieve readiness score
  let readinessScore = 0;
  try {
    const readRow = db
      .prepare(
        `SELECT metric_value FROM dream_telemetry
         WHERE cycle_id LIKE 'pre-%' AND metric_name = 'score'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { metric_value: number } | undefined;
    readinessScore = readRow?.metric_value ?? 0;
  } catch {
    // non-critical
  }

  return {
    cycleId,
    dqs,
    components: { crystalYield, mergeEfficiency, orphanRescue, bondStability, tokenEfficiency },
    inputSignals: {
      fshoR,
      curiosityTargets: params.curiosityTargets ?? 0,
      gccrfMaturity: params.gccrfMaturity ?? 0,
      readinessScore,
    },
    modesRun: stats.cycle.modesUsed ?? [],
    timestamp: Date.now(),
  };
}

/**
 * Persist a dream outcome to the database.
 */
export function persistDreamOutcome(db: DatabaseSync, outcome: DreamOutcome): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO dream_outcomes
       (cycle_id, dqs, crystal_yield, merge_efficiency, orphan_rescue, bond_stability,
        token_efficiency, fsho_r, curiosity_targets, gccrf_maturity, readiness_score,
        modes_run, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      outcome.cycleId,
      outcome.dqs,
      outcome.components.crystalYield,
      outcome.components.mergeEfficiency,
      outcome.components.orphanRescue,
      outcome.components.bondStability,
      outcome.components.tokenEfficiency,
      outcome.inputSignals.fshoR ?? null,
      outcome.inputSignals.curiosityTargets,
      outcome.inputSignals.gccrfMaturity,
      outcome.inputSignals.readinessScore,
      JSON.stringify(outcome.modesRun),
      outcome.timestamp,
    );
  } catch {
    // Table may not exist yet — non-critical
  }
}

/**
 * Analyze correlation between FSHO R and DQS across recent cycles.
 * Returns Pearson correlation coefficient.
 * If |r| > 0.3, the FSHO signal is predictive.
 */
export function analyzeSignalCorrelation(
  db: DatabaseSync,
  windowCycles: number = 20,
): { fshoCorrelation: number; sampleSize: number } {
  try {
    const rows = db
      .prepare(
        `SELECT fsho_r, dqs FROM dream_outcomes
         WHERE fsho_r IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(windowCycles) as Array<{ fsho_r: number; dqs: number }>;

    if (rows.length < 5) {
      return { fshoCorrelation: 0, sampleSize: rows.length };
    }

    const n = rows.length;
    const sumX = rows.reduce((s, r) => s + r.fsho_r, 0);
    const sumY = rows.reduce((s, r) => s + r.dqs, 0);
    const sumXY = rows.reduce((s, r) => s + r.fsho_r * r.dqs, 0);
    const sumX2 = rows.reduce((s, r) => s + r.fsho_r * r.fsho_r, 0);
    const sumY2 = rows.reduce((s, r) => s + r.dqs * r.dqs, 0);

    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return {
      fshoCorrelation: den > 0 ? num / den : 0,
      sampleSize: rows.length,
    };
  } catch {
    return { fshoCorrelation: 0, sampleSize: 0 };
  }
}

/**
 * Compute adaptive FSHO weight adjustment based on empirical correlation.
 *
 * After 10+ cycles, checks whether FSHO R actually predicts dream quality.
 * Returns a scaling factor for FSHO_W in mode selection:
 *   |r| > 0.3 → validated signal, increase weight (up to 1.5x)
 *   |r| < 0.2 after 20+ cycles → noise, decrease weight (down to 0.5x)
 *   Otherwise → neutral (1.0x)
 */
export function computeFshoWeightAdjustment(db: DatabaseSync): {
  adjustment: number;
  correlation: number;
  sampleSize: number;
} {
  const { fshoCorrelation, sampleSize } = analyzeSignalCorrelation(db, 30);

  if (sampleSize < 10) {
    // Too few samples — neutral weight, don't penalize early
    return { adjustment: 1.0, correlation: fshoCorrelation, sampleSize };
  }

  const absR = Math.abs(fshoCorrelation);

  if (absR > 0.3) {
    // Validated: FSHO predicts DQS. Scale up proportionally (max 1.5x).
    const boost = 1.0 + (absR - 0.3) * (0.5 / 0.7);
    return { adjustment: Math.min(1.5, boost), correlation: fshoCorrelation, sampleSize };
  }

  if (sampleSize >= 20 && absR < 0.2) {
    // Enough data to conclude FSHO is noise. Scale down (min 0.5x).
    const penalty = 0.5 + absR * (0.5 / 0.2);
    return { adjustment: Math.max(0.5, penalty), correlation: fshoCorrelation, sampleSize };
  }

  return { adjustment: 1.0, correlation: fshoCorrelation, sampleSize };
}
