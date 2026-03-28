/**
 * SkillVersionResolver: CRDT-inspired conflict resolution for P2P skill versions.
 *
 * When two nodes independently dream-mutate the same skill and publish
 * conflicting versions, this module resolves the conflict locally using
 * fitness-weighted selection — no global consensus required.
 *
 * Design principles:
 *   1. Divergence is natural, not an error (both mutations are valid branches)
 *   2. Resolution is lazy and local (each node picks its own winner)
 *   3. Fitness = execution success × peer trust (natural selection for skills)
 *   4. Losers aren't deleted — they decay naturally via Ebbinghaus forgetting
 *   5. Winners propagate because nodes that use them successfully republish
 *
 * Lineage hash = sha256(stable_skill_id + parent_content_hash + author_pubkey)
 * This makes each branch uniquely identifiable even at the same version number.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/skill-version-resolver");

// ── Types ──────────────────────────────────────────────────────────────────

export type SkillVariant = {
  crystalId: string;
  stableSkillId: string;
  version: number;
  contentHash: string;
  parentContentHash: string | null;
  authorPubkey: string;
  lineageHash: string;
  fitnessScore: number;
  createdAt: number;
};

export type ConflictResolution = {
  action: "accept_new" | "keep_existing" | "keep_both";
  winner: SkillVariant;
  loser?: SkillVariant;
  reason: string;
};

export type FitnessInput = {
  /** Execution success rate from SkillExecutionTracker (0–1). null = never executed. */
  executionSuccessRate: number | null;
  /** Number of times this variant has been executed. */
  executionCount: number;
  /** Peer trust score from PeerReputationManager (0–1). */
  peerTrust: number;
  /** Age in milliseconds since creation. */
  ageMs: number;
};

// ── Fitness weights ────────────────────────────────────────────────────────

const WEIGHT_EXECUTION = 0.45;
const WEIGHT_TRUST = 0.35;
const WEIGHT_RECENCY = 0.20;

/** Minimum executions before success rate is considered reliable. */
const MIN_EXECUTIONS_FOR_CONFIDENCE = 3;

/** After this age (ms), recency contributes 0. */
const RECENCY_HALFLIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Core ───────────────────────────────────────────────────────────────────

export class SkillVersionResolver {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Compute a deterministic lineage hash for a skill variant.
   * Two independent mutations of the same parent will produce different hashes.
   */
  static lineageHash(
    stableSkillId: string,
    parentContentHash: string | null,
    authorPubkey: string,
  ): string {
    return createHash("sha256")
      .update(`${stableSkillId}:${parentContentHash ?? "genesis"}:${authorPubkey}`)
      .digest("hex")
      .slice(0, 16); // 16 hex chars = 64 bits — collision-safe for skill population sizes
  }

  /**
   * Calculate fitness score for a skill variant.
   * Returns 0–1 where 1 is maximally fit.
   */
  static fitness(input: FitnessInput): number {
    // Execution component: Bayesian smoothing — assume 50% prior until we have data
    let execScore: number;
    if (input.executionCount === 0 || input.executionSuccessRate === null) {
      execScore = 0.5; // uninformed prior
    } else if (input.executionCount < MIN_EXECUTIONS_FOR_CONFIDENCE) {
      // Blend prior with observed rate, weighted by sample size
      const confidence = input.executionCount / MIN_EXECUTIONS_FOR_CONFIDENCE;
      execScore = 0.5 * (1 - confidence) + input.executionSuccessRate * confidence;
    } else {
      execScore = input.executionSuccessRate;
    }

    // Trust component: direct passthrough (already 0–1 from PeerReputationManager)
    const trustScore = input.peerTrust;

    // Recency component: exponential decay
    const recencyScore = Math.exp((-Math.LN2 * input.ageMs) / RECENCY_HALFLIFE_MS);

    return (
      WEIGHT_EXECUTION * execScore +
      WEIGHT_TRUST * trustScore +
      WEIGHT_RECENCY * recencyScore
    );
  }

  /**
   * Resolve a conflict between an incoming skill variant and existing variants
   * with the same stable_skill_id and version number.
   *
   * This is the main entry point — called by SkillNetworkBridge during ingestion.
   */
  resolveConflict(
    incoming: {
      stableSkillId: string;
      version: number;
      contentHash: string;
      parentContentHash: string | null;
      authorPubkey: string;
    },
    incomingFitness: FitnessInput,
    getExistingFitness: (crystalId: string, authorPubkey: string) => FitnessInput,
  ): ConflictResolution {
    const incomingLineage = SkillVersionResolver.lineageHash(
      incoming.stableSkillId,
      incoming.parentContentHash,
      incoming.authorPubkey,
    );

    // Find existing variants at this version
    const existing = this.getVariantsAtVersion(incoming.stableSkillId, incoming.version);

    // No conflict — new version number
    if (existing.length === 0) {
      const variant: SkillVariant = {
        crystalId: "", // caller assigns
        stableSkillId: incoming.stableSkillId,
        version: incoming.version,
        contentHash: incoming.contentHash,
        parentContentHash: incoming.parentContentHash,
        authorPubkey: incoming.authorPubkey,
        lineageHash: incomingLineage,
        fitnessScore: SkillVersionResolver.fitness(incomingFitness),
        createdAt: Date.now(),
      };
      return { action: "accept_new", winner: variant, reason: "no conflict" };
    }

    // Exact duplicate (same content hash) — skip
    const duplicate = existing.find((e) => e.contentHash === incoming.contentHash);
    if (duplicate) {
      return { action: "keep_existing", winner: duplicate, reason: "duplicate content" };
    }

    // Same lineage (same author re-mutated same parent) — newer replaces older
    const sameLineage = existing.find((e) => e.lineageHash === incomingLineage);
    if (sameLineage) {
      const incomingScore = SkillVersionResolver.fitness(incomingFitness);
      const existingScore = sameLineage.fitnessScore;

      if (incomingScore >= existingScore) {
        const incomingVariant: SkillVariant = {
          crystalId: "",
          stableSkillId: incoming.stableSkillId,
          version: incoming.version,
          contentHash: incoming.contentHash,
          parentContentHash: incoming.parentContentHash,
          authorPubkey: incoming.authorPubkey,
          lineageHash: incomingLineage,
          fitnessScore: incomingScore,
          createdAt: Date.now(),
        };
        return {
          action: "accept_new",
          winner: incomingVariant,
          loser: sameLineage,
          reason: `same lineage, incoming fitter (${incomingScore.toFixed(3)} >= ${existingScore.toFixed(3)})`,
        };
      }
      return {
        action: "keep_existing",
        winner: sameLineage,
        reason: `same lineage, existing fitter (${existingScore.toFixed(3)} > ${SkillVersionResolver.fitness(incomingFitness).toFixed(3)})`,
      };
    }

    // Different lineage — true divergence. Keep both, let fitness decide over time.
    const incomingVariant: SkillVariant = {
      crystalId: "",
      stableSkillId: incoming.stableSkillId,
      version: incoming.version,
      contentHash: incoming.contentHash,
      parentContentHash: incoming.parentContentHash,
      authorPubkey: incoming.authorPubkey,
      lineageHash: incomingLineage,
      fitnessScore: SkillVersionResolver.fitness(incomingFitness),
      createdAt: Date.now(),
    };

    // Find the overall fittest among all variants (existing + incoming)
    const allVariants = [...existing, incomingVariant];
    for (const v of existing) {
      const fitness = getExistingFitness(v.crystalId, v.authorPubkey);
      v.fitnessScore = SkillVersionResolver.fitness(fitness);
    }
    allVariants.sort((a, b) => b.fitnessScore - a.fitnessScore);

    log.debug("divergent skill variants", {
      stableSkillId: incoming.stableSkillId,
      version: incoming.version,
      variantCount: allVariants.length,
      fittest: allVariants[0].lineageHash,
    });

    return {
      action: "keep_both",
      winner: allVariants[0],
      reason: `divergent branches (${allVariants.length} variants), fittest: ${allVariants[0].lineageHash}`,
    };
  }

  /**
   * Get the fittest variant for a stable skill (across all versions).
   * Used by the agent when selecting which version to actually execute.
   */
  selectBestVariant(
    stableSkillId: string,
    getVariantFitness: (crystalId: string, authorPubkey: string) => FitnessInput,
  ): SkillVariant | null {
    const rows = this.db
      .prepare(
        `SELECT id, stable_skill_id, skill_version, hash, peer_origin,
                lineage_hash, created_at
         FROM chunks
         WHERE stable_skill_id = ?
           AND deprecated = 0
           AND lifecycle_state != 'expired'
         ORDER BY skill_version DESC`,
      )
      .all(stableSkillId) as Array<{
      id: string;
      stable_skill_id: string;
      skill_version: number;
      hash: string;
      peer_origin: string | null;
      lineage_hash: string | null;
      created_at: number;
    }>;

    if (rows.length === 0) return null;

    // Score each variant
    const scored = rows.map((r) => {
      const fitness = getVariantFitness(r.id, r.peer_origin ?? "local");
      return {
        crystalId: r.id,
        stableSkillId: r.stable_skill_id,
        version: r.skill_version,
        contentHash: r.hash,
        parentContentHash: null,
        authorPubkey: r.peer_origin ?? "local",
        lineageHash: r.lineage_hash ?? "unknown",
        fitnessScore: SkillVersionResolver.fitness(fitness),
        createdAt: r.created_at,
      } satisfies SkillVariant;
    });

    scored.sort((a, b) => b.fitnessScore - a.fitnessScore);
    return scored[0];
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private getVariantsAtVersion(stableSkillId: string, version: number): SkillVariant[] {
    const rows = this.db
      .prepare(
        `SELECT id, stable_skill_id, skill_version, hash, peer_origin,
                lineage_hash, importance_score, created_at
         FROM chunks
         WHERE stable_skill_id = ?
           AND skill_version = ?
           AND lifecycle_state != 'expired'`,
      )
      .all(stableSkillId, version) as Array<{
      id: string;
      stable_skill_id: string;
      skill_version: number;
      hash: string;
      peer_origin: string | null;
      lineage_hash: string | null;
      importance_score: number;
      created_at: number;
    }>;

    return rows.map((r) => ({
      crystalId: r.id,
      stableSkillId: r.stable_skill_id,
      version: r.skill_version,
      contentHash: r.hash,
      parentContentHash: null,
      authorPubkey: r.peer_origin ?? "local",
      lineageHash: r.lineage_hash ?? SkillVersionResolver.lineageHash(
        r.stable_skill_id,
        null,
        r.peer_origin ?? "local",
      ),
      fitnessScore: r.importance_score,
      createdAt: r.created_at,
    }));
  }
}
