/**
 * SkillRefiner: orchestrates the dream mutation → evaluation → crystallization
 * pipeline. When a dream mutation insight scores high enough, it's promoted
 * to a skill crystal; otherwise it's archived with a learning note.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { DreamInsight } from "./dream-types.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import type { SkillNetworkBridge } from "./skill-network-bridge.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { SkillVerifier } from "./skill-verifier.js";

const log = createSubsystemLogger("memory/skill-refiner");

export type SkillRefinementResult = {
  original: { id: string; text: string };
  mutations: Array<{
    insight: DreamInsight;
    score: number;
    promoted: boolean;
    reason: string;
  }>;
};

export type SkillRefinementConfig = {
  /** Minimum confidence to promote a mutation to a skill crystal. Default: 0.7. */
  promotionThreshold?: number;
  /** Maximum mutations to evaluate per cycle. Default: 5. */
  maxMutationsPerCycle?: number;
};

const DEFAULT_CONFIG: Required<SkillRefinementConfig> = {
  promotionThreshold: 0.7,
  maxMutationsPerCycle: 5,
};

export class SkillRefiner {
  private readonly db: DatabaseSync;
  private readonly config: Required<SkillRefinementConfig>;
  private readonly onSkillCrystallized?: (insightId: string) => void;
  private readonly executionTracker?: SkillExecutionTracker;
  private networkBridge?: SkillNetworkBridge;
  private readonly verifier: SkillVerifier;

  constructor(
    db: DatabaseSync,
    config?: SkillRefinementConfig,
    onSkillCrystallized?: (insightId: string) => void,
    executionTracker?: SkillExecutionTracker,
    networkBridge?: SkillNetworkBridge,
    verifier?: SkillVerifier,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onSkillCrystallized = onSkillCrystallized;
    this.executionTracker = executionTracker;
    this.networkBridge = networkBridge;
    this.verifier = verifier ?? new SkillVerifier(db);
  }

  /**
   * Wire or replace the network bridge after construction.
   */
  setNetworkBridge(bridge: SkillNetworkBridge): void {
    this.networkBridge = bridge;
  }

  /**
   * Evaluate dream mutation insights against their source skills.
   * Promotes high-scoring mutations to skill crystals.
   */
  evaluateMutations(
    original: { id: string; text: string },
    mutations: DreamInsight[],
  ): SkillRefinementResult {
    const results: SkillRefinementResult = {
      original,
      mutations: [],
    };

    const toEvaluate = mutations.slice(0, this.config.maxMutationsPerCycle);

    for (const mutation of toEvaluate) {
      const score = this.scoreMutation(original.text, mutation.content, original.id);
      const promoted = score >= this.config.promotionThreshold && mutation.confidence >= 0.5;

      if (promoted) {
        // Safety gate: verify mutation before crystallization
        const verification = this.verifier.verify(
          mutation.content,
          original.id,
          mutation.embedding.length > 0 ? mutation.embedding : undefined,
        );
        if (!verification.passed) {
          this.archiveMutation(mutation, `Verification failed: ${verification.overallReason}`);
          results.mutations.push({
            insight: mutation,
            score,
            promoted: false,
            reason: `Verification failed: ${verification.overallReason}`,
          });
          continue;
        }

        const crystallized = this.queueForCrystallization(mutation, original.id);
        results.mutations.push({
          insight: mutation,
          score,
          promoted: crystallized,
          reason: crystallized
            ? `Score ${score.toFixed(2)} >= threshold ${this.config.promotionThreshold}`
            : `Score ${score.toFixed(2)} met threshold but crystallization failed`,
        });
      } else {
        this.archiveMutation(mutation, `Score ${score.toFixed(2)} below threshold`);
        results.mutations.push({
          insight: mutation,
          score,
          promoted: false,
          reason: `Score ${score.toFixed(2)} below threshold ${this.config.promotionThreshold}`,
        });
      }
    }

    if (results.mutations.some((m) => m.promoted)) {
      log.debug("skill mutations evaluated", {
        original: original.id,
        total: toEvaluate.length,
        promoted: results.mutations.filter((m) => m.promoted).length,
      });
    }

    return results;
  }

  /**
   * Score a mutation against the original.
   * Higher scores mean the mutation is more general, better structured,
   * or covers more edge cases. Incorporates empirical execution data
   * when available.
   */
  private scoreMutation(original: string, mutation: string, originalId?: string): number {
    let score = this.heuristicScore(original, mutation);

    // Empirical scoring from execution tracker (Phase 3)
    if (originalId && this.executionTracker) {
      const metrics = this.executionTracker.getSkillMetrics(originalId);
      if (metrics.totalExecutions >= 3) {
        // If original has high success rate, mutations get a boost
        score += metrics.successRate * 0.15;
        // But if original already works great, demand higher quality mutations
        if (metrics.successRate > 0.9) {
          score -= 0.1; // raise the bar
        }
      }
    }

    return Math.min(1, score);
  }

  /**
   * Pure heuristic scoring (no empirical data).
   */
  private heuristicScore(original: string, mutation: string): number {
    let score = 0;

    // Length ratio: mutations shouldn't be vastly shorter or longer
    const lenRatio = mutation.length / Math.max(1, original.length);
    if (lenRatio >= 0.5 && lenRatio <= 2.0) {
      score += 0.2;
    }

    // Keyword coverage: mutation should retain core concepts
    const originalWords = new Set(
      original
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
    const mutationWords = new Set(
      mutation
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );

    let overlap = 0;
    for (const word of originalWords) {
      if (mutationWords.has(word)) overlap++;
    }
    const coverage = originalWords.size > 0 ? overlap / originalWords.size : 0;
    score += coverage * 0.3;

    // Novelty: mutation should introduce some new concepts
    let novelWords = 0;
    for (const word of mutationWords) {
      if (!originalWords.has(word)) novelWords++;
    }
    const novelty = mutationWords.size > 0 ? novelWords / mutationWords.size : 0;
    score += Math.min(0.3, novelty * 0.5);

    // Structural indicators: the mutation mentions edge cases, alternatives, etc.
    const structurePatterns = [
      /\b(?:edge case|alternative|fallback|handle|when|if|otherwise|except)\b/i,
      /\b(?:more general|broader|flexible|robust|efficient|scalable)\b/i,
    ];
    for (const pattern of structurePatterns) {
      if (pattern.test(mutation)) score += 0.1;
    }

    return Math.min(1, score);
  }

  /**
   * Promote a mutation to a skill crystal by creating a new chunk in the chunks
   * table with lifecycle='frozen' and memory_type='skill'. This ensures the
   * mutated skill is available for future dream cycles and consolidation.
   *
   * Handles versioning (Phase 6): inherits stable_skill_id from parent or creates new one.
   */
  private queueForCrystallization(mutation: DreamInsight, originalId: string): boolean {
    const now = Date.now();
    const crystalId = crypto.randomUUID();
    try {
      // Boost insight importance
      this.db
        .prepare(
          `UPDATE dream_insights SET importance_score = MIN(1.0, importance_score + 0.2) WHERE id = ?`,
        )
        .run(mutation.id);

      // Versioning: inherit or create stable_skill_id
      let stableSkillId: string;
      let skillVersion = 1;
      const originalRow = this.db
        .prepare(
          `SELECT stable_skill_id, skill_version, skill_category, skill_tags FROM chunks WHERE id = ?`,
        )
        .get(originalId) as
        | {
            stable_skill_id: string | null;
            skill_version: number | null;
            skill_category: string | null;
            skill_tags: string | null;
          }
        | undefined;

      if (originalRow?.stable_skill_id) {
        stableSkillId = originalRow.stable_skill_id;
        skillVersion = (originalRow.skill_version ?? 1) + 1;
      } else {
        stableSkillId = crypto.randomUUID();
      }

      // Create a new skill crystal in the chunks table
      const governance = JSON.stringify({
        accessScope: "shared",
        lifespanPolicy: "permanent",
        priority: mutation.confidence,
        sensitivity: "normal",
        provenanceChain: [originalId, mutation.id],
      });

      const provenanceDag = JSON.stringify([
        {
          crystalId,
          operation: "mutated",
          actor: "dream_engine",
          timestamp: now,
          parentIds: [originalId],
          metadata: { mutationId: mutation.id, confidence: mutation.confidence },
        },
      ]);

      this.db
        .prepare(
          `INSERT INTO chunks (
            id, path, source, start_line, end_line, hash, model, text, embedding,
            updated_at, importance_score, access_count, lifecycle_state, lifecycle,
            memory_type, semantic_type, origin, governance_json, created_at,
            version, parent_id, provenance_chain,
            stable_skill_id, skill_version, previous_version_id,
            skill_category, skill_tags, provenance_dag
          ) VALUES (
            ?, ?, 'skills', 0, 0, ?, 'dream', ?, '[]',
            ?, ?, 0, 'active', 'frozen',
            'skill', 'skill', 'dream', ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?
          )`,
        )
        .run(
          crystalId,
          `dream/mutation/${originalId}`,
          crypto.randomUUID(), // unique hash
          mutation.content,
          now,
          mutation.confidence,
          governance,
          now,
          skillVersion,
          originalId,
          JSON.stringify([originalId, mutation.id]),
          stableSkillId,
          skillVersion,
          originalId,
          originalRow?.skill_category ?? null,
          originalRow?.skill_tags ?? "[]",
          provenanceDag,
        );

      // Record provenance: link mutation back to original skill
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          crystalId,
          "skill_mutation_promoted",
          now,
          "skill_refiner",
          JSON.stringify({
            originalId,
            mutationId: mutation.id,
            confidence: mutation.confidence,
            stableSkillId,
            skillVersion,
          }),
        );

      log.debug("skill mutation crystallized", {
        crystalId,
        originalId,
        confidence: mutation.confidence,
        stableSkillId,
        skillVersion,
      });

      // Notify callback listener
      this.onSkillCrystallized?.(crystalId);

      // Publish to P2P network via bridge (Phase 2)
      this.networkBridge?.onSkillCrystallized(crystalId);
      return true;
    } catch (err) {
      log.warn(`failed to crystallize mutation: ${String(err)}`);
      return false;
    }
  }

  /**
   * Archive a mutation that didn't score high enough.
   */
  private archiveMutation(mutation: DreamInsight, reason: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          mutation.id,
          "skill_mutation_archived",
          Date.now(),
          "skill_refiner",
          JSON.stringify({ reason }),
        );
    } catch {
      // Non-critical
    }
  }
}
