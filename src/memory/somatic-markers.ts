/**
 * Somatic Marker Fast-Pathing: pre-retrieval emotional filtering that
 * short-circuits known-bad knowledge regions before burning tokens on
 * expensive operations (Deep Recall, skill execution).
 *
 * Uses the existing hormonal_influence columns and steering_reward data
 * to build "gut feelings" about knowledge regions.
 *
 * FIRST IMPLEMENTATION of Damasio's somatic marker hypothesis in agent memory.
 *
 * Scientific basis:
 * - Damasio, A.R. (1994). Descartes' Error: Emotion, Reason, and the Human Brain.
 *
 * PLAN-9: GAP-12 (Somatic Marker Fast-Pathing)
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/somatic-markers");

export type SomaticVerdict = "proceed" | "caution" | "trusted";

export interface SomaticAssessment {
  verdict: SomaticVerdict;
  avgCortisol: number;
  avgSteeringReward: number;
  avgDopamine: number;
  chunkCount: number;
  message?: string;
}

export interface SomaticConfig {
  enabled: boolean;
  /** Cortisol threshold for "caution" verdict */
  cortisolCautionThreshold: number;
  /** Steering reward threshold for "caution" verdict (negative = bad) */
  steeringCautionThreshold: number;
  /** Dopamine threshold for "trusted" verdict */
  dopamineTrustedThreshold: number;
  /** Steering reward threshold for "trusted" verdict */
  steeringTrustedThreshold: number;
  /** Minimum chunks in region to make assessment */
  minRegionSize: number;
}

export const DEFAULT_SOMATIC_CONFIG: SomaticConfig = {
  enabled: true,
  cortisolCautionThreshold: 0.6,
  steeringCautionThreshold: -0.3,
  dopamineTrustedThreshold: 0.6,
  steeringTrustedThreshold: 0.5,
  minRegionSize: 3,
};

/**
 * Assess a knowledge region before committing expensive compute.
 *
 * Query the aggregate emotional signature of chunks near the query
 * embedding. If the region is associated with past friction/failure,
 * return a warning. If associated with success, return a confidence boost.
 *
 * @param nearbyChunkIds - IDs of chunks near the query (from initial vector search)
 */
export function assessSomaticMarkers(
  db: DatabaseSync,
  nearbyChunkIds: string[],
  config?: Partial<SomaticConfig>,
): SomaticAssessment {
  const cfg = { ...DEFAULT_SOMATIC_CONFIG, ...config };

  if (!cfg.enabled || nearbyChunkIds.length < cfg.minRegionSize) {
    return { verdict: "proceed", avgCortisol: 0, avgSteeringReward: 0, avgDopamine: 0, chunkCount: 0 };
  }

  try {
    // Query aggregate emotional signature of the region
    const placeholders = nearbyChunkIds.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT
           AVG(COALESCE(hormonal_cortisol, 0)) as avg_cortisol,
           AVG(COALESCE(steering_reward, 0)) as avg_steering,
           AVG(COALESCE(hormonal_dopamine, 0)) as avg_dopamine,
           COUNT(*) as cnt
         FROM chunks
         WHERE id IN (${placeholders})`,
      )
      .get(...nearbyChunkIds) as {
      avg_cortisol: number;
      avg_steering: number;
      avg_dopamine: number;
      cnt: number;
    };

    const assessment: SomaticAssessment = {
      verdict: "proceed",
      avgCortisol: row.avg_cortisol,
      avgSteeringReward: row.avg_steering,
      avgDopamine: row.avg_dopamine,
      chunkCount: row.cnt,
    };

    // Check for danger markers
    if (
      row.avg_cortisol > cfg.cortisolCautionThreshold &&
      row.avg_steering < cfg.steeringCautionThreshold
    ) {
      assessment.verdict = "caution";
      assessment.message =
        "This knowledge region is associated with prior friction/failure. " +
        "Proceed with caution or try an alternative approach.";
      log.debug("somatic marker: caution", {
        cortisol: row.avg_cortisol.toFixed(2),
        steering: row.avg_steering.toFixed(2),
      });
    }
    // Check for trust markers
    else if (
      row.avg_dopamine > cfg.dopamineTrustedThreshold &&
      row.avg_steering > cfg.steeringTrustedThreshold
    ) {
      assessment.verdict = "trusted";
      assessment.message = "This knowledge region has a strong track record. High confidence path.";
      log.debug("somatic marker: trusted path");
    }

    return assessment;
  } catch (err) {
    log.debug(`somatic assessment failed: ${String(err)}`);
    return { verdict: "proceed", avgCortisol: 0, avgSteeringReward: 0, avgDopamine: 0, chunkCount: 0 };
  }
}
