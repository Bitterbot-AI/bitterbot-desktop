/**
 * CuriosityEngine: unified intrinsic motivation system combining knowledge
 * infrastructure (regions, targets, queries, emergence) with GCCRF
 * mathematical reward scoring.
 *
 * Three integration hooks:
 * 1. assessChunk() -- on indexing: compute GCCRF reward + contradiction detection
 * 2. recordSearchQuery() -- on search: track query quality for gap detection
 * 3. run() -- on consolidation: rebuild regions, detect gaps, generate targets, score pending chunks
 *
 * GCCRF proxy methods:
 * - getMaturity(), getCurrentAlpha(), updateFshoR(), getFshoRAvg(), getFshoCoupledAlpha()
 * - saveGCCRFState(), getGCCRFState(), getGCCRFConfig(), gccrfDiagnostics()
 * - computeReward(), scorePendingChunks()
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { computeCentroid, cosineSimilarity, parseEmbedding } from "./internal.js";
import {
  GCCRFRewardFunction,
  type GCCRFConfig,
  type GCCRFRewardResult,
} from "./gccrf-reward.js";

// Re-export for consumers that previously imported from gccrf-reward directly via manager
export type { GCCRFRewardResult, GCCRFConfig };
import {
  type CuriosityConfig,
  type CuriosityState,
  type EmergenceEvent,
  type ExplorationTarget,
  type ExplorationTargetType,
  type KnowledgeRegion,
  type SurpriseAssessment,
  DEFAULT_CURIOSITY_CONFIG,
  DEFAULT_CURIOSITY_WEIGHTS,
} from "./curiosity-types.js";
import { ensureCuriositySchema } from "./curiosity-schema.js";
import type { DreamInsight, DreamMode } from "./dream-types.js";
import type { EmbeddingPerspective } from "./crystal-types.js";

const log = createSubsystemLogger("memory/curiosity");

type ChunkRow = {
  id: string;
  hash: string;
  embedding: string;
  importance_score: number;
  access_count: number;
};

type RegionRow = {
  id: string;
  label: string;
  centroid: string;
  chunk_count: number;
  total_accesses: number;
  mean_importance: number;
  prediction_error: number;
  learning_progress: number;
  created_at: number;
  last_updated_at: number;
};

type QueryRow = {
  id: string;
  query: string;
  query_embedding: string;
  result_count: number;
  top_score: number;
  mean_score: number;
  region_id: string | null;
  timestamp: number;
};

export class CuriosityEngine {
  private db: DatabaseSync;
  private readonly config: {
    enabled: boolean;
    weights: { novelty: number; surprise: number; informationGain: number; contradiction: number };
    boostThreshold: number;
    boostMultiplier: number;
    maxRegions: number;
    maxTargets: number;
    targetTtlHours: number;
    maxQueryHistory: number;
    gapScoreThreshold: number;
  };

  /** Unified GCCRF reward function — the single scoring engine. */
  private readonly gccrfReward: GCCRFRewardFunction;

  constructor(db: DatabaseSync, config?: CuriosityConfig) {
    this.db = db;
    this.config = {
      enabled: config?.enabled ?? DEFAULT_CURIOSITY_CONFIG.enabled,
      weights: { ...DEFAULT_CURIOSITY_WEIGHTS, ...config?.weights },
      boostThreshold: config?.boostThreshold ?? DEFAULT_CURIOSITY_CONFIG.boostThreshold,
      boostMultiplier: config?.boostMultiplier ?? DEFAULT_CURIOSITY_CONFIG.boostMultiplier,
      maxRegions: config?.maxRegions ?? DEFAULT_CURIOSITY_CONFIG.maxRegions,
      maxTargets: config?.maxTargets ?? DEFAULT_CURIOSITY_CONFIG.maxTargets,
      targetTtlHours: config?.targetTtlHours ?? DEFAULT_CURIOSITY_CONFIG.targetTtlHours,
      maxQueryHistory: config?.maxQueryHistory ?? DEFAULT_CURIOSITY_CONFIG.maxQueryHistory,
      gapScoreThreshold: config?.gapScoreThreshold ?? DEFAULT_CURIOSITY_CONFIG.gapScoreThreshold,
    };
    ensureCuriositySchema(db);

    // Initialize GCCRF reward function as the single scoring engine
    this.gccrfReward = new GCCRFRewardFunction(db, config?.gccrf as Partial<GCCRFConfig> | undefined);
  }

  /** Update the database handle after a reindex swaps the underlying file. */
  updateDb(db: DatabaseSync): void {
    this.db = db;
    ensureCuriositySchema(db);
    // Propagate to GCCRF (it needs to re-ensure its schema too)
    (this.gccrfReward as any).db = db;
  }

  /**
   * Hook 1: Assess a newly indexed chunk using unified GCCRF scoring.
   * Returns the GCCRF reward result with component breakdown and contradiction detection.
   * Writes curiosity_reward directly on the chunk.
   */
  assessChunk(
    chunkId: string,
    chunkEmbedding: number[],
    chunkHash: string,
    _perspectiveEmbeddings?: Partial<Record<EmbeddingPerspective, number[]>>,
  ): SurpriseAssessment | null {
    if (!this.config.enabled) return null;
    if (chunkEmbedding.length === 0) return null;

    const regions = this.loadRegions();

    // Build region centroid map for GCCRF
    const regionCentroids = new Map<string, number[]>();
    for (const region of regions) {
      const centroid = parseEmbedding(region.centroid);
      if (centroid.length > 0) regionCentroids.set(region.id, centroid);
    }

    // Build strategic target embeddings from active exploration targets
    const strategicTargets: number[][] = [];
    try {
      const targets = this.db
        .prepare(
          `SELECT region_id FROM curiosity_targets
           WHERE resolved_at IS NULL AND expires_at > ?
           ORDER BY priority DESC LIMIT ?`,
        )
        .all(Date.now(), this.config.maxTargets) as Array<{ region_id: string | null }>;
      for (const t of targets) {
        if (t.region_id) {
          const centroid = regionCentroids.get(t.region_id);
          if (centroid) strategicTargets.push(centroid);
        }
      }
    } catch { /* targets table may not exist yet */ }

    // Compute GCCRF reward (the single scoring path)
    const gccrfResult = this.gccrfReward.compute(chunkEmbedding, regionCentroids, strategicTargets);

    // Contradiction detection (unique signal not in GCCRF)
    const neighbors = this.getNeighborChunks(chunkEmbedding, chunkId, 10);
    const contradiction = this.computeContradiction(chunkEmbedding, chunkHash, neighbors);

    const now = Date.now();
    const assessment: SurpriseAssessment = {
      chunkId,
      // Map GCCRF components to legacy assessment fields for backward compat
      noveltyScore: gccrfResult.rawComponents.eta,
      surpriseFactor: gccrfResult.rawComponents.deltaEta,
      informationGain: gccrfResult.rawComponents.iAlpha,
      contradictionScore: contradiction,
      compositeReward: gccrfResult.reward,
      regionId: gccrfResult.regionId,
      assessedAt: now,
      // New unified fields
      gccrfComponents: gccrfResult.components,
      gccrfReward: gccrfResult.reward,
    };

    // Store assessment
    this.db
      .prepare(
        `INSERT OR REPLACE INTO curiosity_surprises
         (chunk_id, novelty_score, surprise_factor, information_gain,
          contradiction_score, composite_reward, region_id, assessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunkId,
        gccrfResult.rawComponents.eta,
        gccrfResult.rawComponents.deltaEta,
        gccrfResult.rawComponents.iAlpha,
        contradiction,
        gccrfResult.reward,
        gccrfResult.regionId,
        now,
      );

    // Write curiosity_reward directly (replaces old dual curiosity_boost path)
    this.db
      .prepare(`UPDATE chunks SET curiosity_reward = ? WHERE id = ?`)
      .run(gccrfResult.reward, chunkId);

    return assessment;
  }

  /**
   * Hook 2: Record a search query for gap detection.
   */
  recordSearchQuery(
    query: string,
    queryEmbedding: number[],
    resultCount: number,
    topScore: number,
    meanScore: number,
  ): void {
    if (!this.config.enabled) return;

    // Find nearest region for the query
    const regions = this.loadRegions();
    let nearestRegionId: string | null = null;
    let maxSim = -1;
    for (const region of regions) {
      const centroid = parseEmbedding(region.centroid);
      if (centroid.length === 0) continue;
      const sim = cosineSimilarity(queryEmbedding, centroid);
      if (sim > maxSim) {
        maxSim = sim;
        nearestRegionId = region.id;
      }
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO curiosity_queries
         (id, query, query_embedding, result_count, top_score, mean_score, region_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, query, JSON.stringify(queryEmbedding), resultCount, topScore, meanScore, nearestRegionId, now);

    // Prune old queries
    this.pruneQueryHistory();
  }

  /**
   * Hook 3: Periodic consolidation -- rebuild regions, detect gaps, generate targets.
   */
  run(): { regions: number; targets: number; expired: number } {
    if (!this.config.enabled) return { regions: 0, targets: 0, expired: 0 };

    const regionsBuilt = this.rebuildRegions();
    const expired = this.expireTargets();
    const targetsGenerated = this.detectGapsAndGenerateTargets();
    this.computeRegionLearningProgress();

    // GCCRF-enhanced: retire satisfied targets and generate new ones from GCCRF signals
    const gccrfRetired = this.retireGCCRFTargets();
    const gccrfTargets = this.generateGCCRFTargets();
    if (gccrfRetired > 0 || gccrfTargets > 0) {
      log.debug("GCCRF target update", { retired: gccrfRetired, generated: gccrfTargets });
    }

    // Emergence detection: find convergence and bridge events
    const emergence = this.detectEmergence();
    if (emergence.length > 0) {
      this.storeEmergenceEvents(emergence);
      log.debug("emergence events detected", { count: emergence.length });
    }

    // Score pending chunks that haven't been GCCRF-scored yet
    const pendingScored = this.scorePendingChunks();

    // Persist GCCRF state
    this.gccrfReward.saveState();

    log.debug("curiosity run complete", {
      regions: regionsBuilt,
      targets: targetsGenerated,
      expired,
      emergence: emergence.length,
      pendingScored,
    });

    return { regions: regionsBuilt, targets: targetsGenerated, expired };
  }

  /**
   * Get the current curiosity state for agent inspection.
   */
  getState(): CuriosityState {
    const regions = this.loadRegions().map((r) => ({
      id: r.id,
      label: r.label,
      centroid: parseEmbedding(r.centroid),
      chunkCount: r.chunk_count,
      totalAccesses: r.total_accesses,
      meanImportance: r.mean_importance,
      predictionError: r.prediction_error,
      learningProgress: r.learning_progress,
      createdAt: r.created_at,
      lastUpdatedAt: r.last_updated_at,
    }));

    const targetRows = this.db
      .prepare(
        `SELECT id, type, description, priority, region_id, metadata,
                created_at, resolved_at, expires_at
         FROM curiosity_targets
         WHERE resolved_at IS NULL AND expires_at > ?
         ORDER BY priority DESC LIMIT ?`,
      )
      .all(Date.now(), this.config.maxTargets) as Array<{
        id: string;
        type: ExplorationTargetType;
        description: string;
        priority: number;
        region_id: string | null;
        metadata: string;
        created_at: number;
        resolved_at: number | null;
        expires_at: number;
      }>;

    const surpriseRows = this.db
      .prepare(
        `SELECT chunk_id, novelty_score, surprise_factor, information_gain,
                contradiction_score, composite_reward, region_id, assessed_at
         FROM curiosity_surprises ORDER BY assessed_at DESC LIMIT 20`,
      )
      .all() as Array<{
        chunk_id: string;
        novelty_score: number;
        surprise_factor: number;
        information_gain: number;
        contradiction_score: number;
        composite_reward: number;
        region_id: string | null;
        assessed_at: number;
      }>;

    const recentSurprises: SurpriseAssessment[] = surpriseRows.map((r) => ({
      chunkId: r.chunk_id,
      noveltyScore: r.novelty_score,
      surpriseFactor: r.surprise_factor,
      informationGain: r.information_gain,
      contradictionScore: r.contradiction_score,
      compositeReward: r.composite_reward,
      regionId: r.region_id,
      assessedAt: r.assessed_at,
    }));

    const queryCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM curiosity_queries`).get() as { c: number }
    )?.c ?? 0;

    const targets: ExplorationTarget[] = targetRows.map((t) => ({
      id: t.id,
      type: t.type,
      description: t.description,
      priority: t.priority,
      regionId: t.region_id,
      metadata: typeof t.metadata === "string" ? JSON.parse(t.metadata) : {},
      createdAt: t.created_at,
      resolvedAt: t.resolved_at,
      expiresAt: t.expires_at,
    }));

    // Recent emergence events (last 5)
    const emergenceRows = this.db
      .prepare(
        `SELECT id, type, description, involved_regions, strength, detected_at, metadata
         FROM curiosity_emergence ORDER BY detected_at DESC LIMIT 5`,
      )
      .all() as Array<{
        id: string;
        type: "convergence" | "bridge" | "cluster_formation";
        description: string;
        involved_regions: string;
        strength: number;
        detected_at: number;
        metadata: string;
      }>;

    const recentEmergence: EmergenceEvent[] = emergenceRows.map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      involvedRegions: JSON.parse(r.involved_regions),
      strength: r.strength,
      detectedAt: r.detected_at,
      metadata: JSON.parse(r.metadata),
    }));

    return {
      regions,
      targets,
      recentSurprises,
      recentEmergence,
      queryCount,
    };
  }

  /**
   * Mark an exploration target as resolved.
   */
  resolveTarget(targetId: string): boolean {
    const result = this.db
      .prepare(`UPDATE curiosity_targets SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`)
      .run(Date.now(), targetId);
    return (result as { changes: number }).changes > 0;
  }

  // --- Bounty Integration ---

  /**
   * Ingest a network bounty as an ultra-high-priority exploration target.
   * Priority is doubled (capped at 1.5) compared to locally-generated targets.
   */
  ingestBounty(bounty: {
    bountyId: string;
    targetType: ExplorationTargetType;
    description: string;
    priority: number;
    rewardMultiplier: number;
    regionHint?: string;
    expiresAt: number;
    // Plan 8, Phase 4: USDC reward info
    rewardUsdc?: number;
    posterPeerId?: string;
    posterWalletAddress?: string;
  }): boolean {
    if (!this.config.enabled) return false;

    // Validate: not expired
    if (bounty.expiresAt <= Date.now()) return false;

    // Check for duplicate bounty
    const existing = this.db
      .prepare(
        `SELECT id FROM curiosity_targets WHERE description LIKE ? AND resolved_at IS NULL`,
      )
      .get(`[BOUNTY ${bounty.bountyId}]%`) as { id: string } | undefined;
    if (existing) return false;

    const now = Date.now();
    const boostedPriority = Math.min(1.5, bounty.priority * 2.0);
    const metadata = JSON.stringify({
      isBounty: true,
      bountyId: bounty.bountyId,
      rewardMultiplier: bounty.rewardMultiplier,
      regionHint: bounty.regionHint,
      // Plan 8, Phase 4: USDC reward for economic bounty payouts
      rewardUsdc: bounty.rewardUsdc ?? 0,
      posterPeerId: bounty.posterPeerId ?? null,
      posterWalletAddress: bounty.posterWalletAddress ?? null,
    });

    this.db
      .prepare(
        `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        bounty.targetType,
        `[BOUNTY ${bounty.bountyId}] ${bounty.description}`,
        boostedPriority,
        null,
        metadata,
        now,
        null,
        bounty.expiresAt,
      );

    log.debug("bounty ingested as exploration target", { bountyId: bounty.bountyId, priority: boostedPriority });
    return true;
  }

  /**
   * Check if a crystal matches any active bounty. Returns match info or null.
   */
  checkBountyMatch(crystalId: string, crystalText: string): {
    bountyId: string; rewardMultiplier: number;
    rewardUsdc: number; posterPeerId: string | null; posterWalletAddress: string | null;
  } | null {
    if (!this.config.enabled) return null;

    const now = Date.now();
    const bountyTargets = this.db
      .prepare(
        `SELECT id, description, metadata FROM curiosity_targets
         WHERE resolved_at IS NULL AND expires_at > ?
           AND metadata LIKE '%"isBounty":true%'
         ORDER BY priority DESC LIMIT 20`,
      )
      .all(now) as Array<{ id: string; description: string; metadata: string }>;

    const lowerText = crystalText.toLowerCase();

    for (const target of bountyTargets) {
      // Extract the bounty description (after the "[BOUNTY xxx] " prefix)
      const descMatch = target.description.match(/\[BOUNTY [^\]]+\] (.+)/);
      const bountyDesc = descMatch ? descMatch[1]! : target.description;

      // Keyword matching: split bounty description into words and check overlap
      const bountyWords = bountyDesc.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchCount = bountyWords.filter(w => lowerText.includes(w)).length;
      const matchRatio = bountyWords.length > 0 ? matchCount / bountyWords.length : 0;

      if (matchRatio >= 0.3) {
        // Parse metadata for reward multiplier, bounty ID, and USDC reward
        let meta: {
          bountyId?: string; rewardMultiplier?: number;
          rewardUsdc?: number; posterPeerId?: string | null; posterWalletAddress?: string | null;
        } = {};
        try { meta = JSON.parse(target.metadata); } catch {}

        // Resolve this bounty target
        this.resolveTarget(target.id);

        return {
          bountyId: meta.bountyId ?? "unknown",
          rewardMultiplier: meta.rewardMultiplier ?? 1.0,
          rewardUsdc: meta.rewardUsdc ?? 0,
          posterPeerId: meta.posterPeerId ?? null,
          posterWalletAddress: meta.posterWalletAddress ?? null,
        };
      }
    }

    return null;
  }

  // --- Dream-Curiosity Integration ---

  /**
   * Assess a dream insight for its impact on curiosity targets.
   * Called after dream insights are stored (AWAKENING phase).
   */
  assessDreamInsight(insight: DreamInsight): {
    gapsFilled: number;
    contradictions: number;
    frontiersOpened: number;
  } {
    if (!this.config.enabled) return { gapsFilled: 0, contradictions: 0, frontiersOpened: 0 };

    const result = { gapsFilled: 0, contradictions: 0, frontiersOpened: 0 };
    const now = Date.now();

    // Check if insight fills a known knowledge gap
    if (insight.embedding.length > 0) {
      const targets = this.db
        .prepare(
          `SELECT id, type, description, region_id FROM curiosity_targets
           WHERE resolved_at IS NULL AND expires_at > ?
           ORDER BY priority DESC LIMIT 20`,
        )
        .all(now) as Array<{
          id: string;
          type: string;
          description: string;
          region_id: string | null;
        }>;

      // If the insight is highly relevant to a gap target's region, mark it resolved
      for (const target of targets) {
        if (target.region_id && target.type === "knowledge_gap") {
          const region = this.db
            .prepare(`SELECT centroid FROM curiosity_regions WHERE id = ?`)
            .get(target.region_id) as { centroid: string } | undefined;

          if (region) {
            const centroid = parseEmbedding(region.centroid);
            if (centroid.length > 0) {
              const sim = cosineSimilarity(insight.embedding, centroid);
              if (sim >= 0.6 && insight.confidence >= 0.5) {
                this.resolveTarget(target.id);
                result.gapsFilled++;
              }
            }
          }
        }

        // High-confidence contradictions from simulation mode
        if (target.type === "contradiction" && insight.mode === "simulation") {
          if (insight.confidence >= 0.7) {
            this.resolveTarget(target.id);
            result.contradictions++;
          }
        }
      }
    }

    // Check if insight opens new frontiers (high novelty insights)
    if (insight.embedding.length > 0 && insight.confidence >= 0.6) {
      const regions = this.loadRegions();
      const centroids = regions.map((r) => parseEmbedding(r.centroid)).filter((c) => c.length > 0);
      // Inline novelty: 1 - max cosine similarity to region centroids
      let maxSim = 0;
      for (const c of centroids) {
        const sim = cosineSimilarity(insight.embedding, c);
        if (sim > maxSim) maxSim = sim;
      }
      const novelty = centroids.length === 0 ? 1.0 : Math.max(0, 1 - maxSim);

      if (novelty > 0.7) {
        // This insight is far from existing regions — frontier territory
        const activeCount = (
          this.db
            .prepare(`SELECT COUNT(*) as c FROM curiosity_targets WHERE resolved_at IS NULL AND type = 'frontier' AND expires_at > ?`)
            .get(now) as { c: number }
        )?.c ?? 0;

        if (activeCount < this.config.maxTargets) {
          const ttlMs = this.config.targetTtlHours * 60 * 60 * 1000;
          this.db
            .prepare(
              `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              crypto.randomUUID(),
              "frontier",
              `New frontier opened by dream insight: ${insight.content.slice(0, 100)}`,
              0.6,
              null,
              JSON.stringify({ sourceInsightId: insight.id, noveltyScore: novelty }),
              now,
              null,
              now + ttlMs,
            );
          result.frontiersOpened++;
        }
      }
    }

    return result;
  }

  /**
   * Record search surprise: when a search returns unexpected results,
   * use the prediction error as a curiosity signal. Updates the nearest
   * region's prediction error and generates knowledge_gap targets for
   * large surprises.
   */
  recordSearchSurprise(
    query: string,
    expectedScore: number,
    actualScore: number,
    queryEmbedding?: number[],
  ): void {
    if (!this.config.enabled) return;

    const predictionError = Math.abs(expectedScore - actualScore);
    if (predictionError <= 0.1) return; // too small to be meaningful

    log.debug("search surprise detected", { query: query.slice(0, 50), predictionError });

    // Find nearest region and update its prediction error
    if (queryEmbedding && queryEmbedding.length > 0) {
      const regions = this.loadRegions();
      let nearestRegion: RegionRow | null = null;
      let maxSim = -1;
      for (const region of regions) {
        const centroid = parseEmbedding(region.centroid);
        if (centroid.length === 0) continue;
        const sim = cosineSimilarity(queryEmbedding, centroid);
        if (sim > maxSim) {
          maxSim = sim;
          nearestRegion = region;
        }
      }

      if (nearestRegion) {
        // Exponential moving average of prediction error
        const alpha = 0.3;
        const newError = alpha * predictionError + (1 - alpha) * nearestRegion.prediction_error;
        this.db
          .prepare(
            `UPDATE curiosity_regions SET prediction_error = ?, last_updated_at = ? WHERE id = ?`,
          )
          .run(newError, Date.now(), nearestRegion.id);
      }
    }

    // High prediction error → generate a knowledge_gap target
    if (predictionError > 0.4) {
      const now = Date.now();
      const activeGaps = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c FROM curiosity_targets
             WHERE type = 'knowledge_gap' AND resolved_at IS NULL AND expires_at > ?`,
          )
          .get(now) as { c: number }
      )?.c ?? 0;

      if (activeGaps < this.config.maxTargets) {
        const ttlMs = this.config.targetTtlHours * 60 * 60 * 1000;
        this.db
          .prepare(
            `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            "knowledge_gap",
            `Search surprise: query "${query.slice(0, 80)}" had prediction error ${predictionError.toFixed(2)}`,
            Math.min(1, 0.5 + predictionError),
            null,
            JSON.stringify({ predictionError, expectedScore, actualScore }),
            now,
            null,
            now + ttlMs,
          );
      }
    }
  }

  /**
   * Get suggested dream mode weight adjustments based on current curiosity state.
   * Used by DreamEngine to influence mode selection.
   */
  getDreamModeWeightAdjustments(): Partial<Record<DreamMode, number>> {
    if (!this.config.enabled) return {};

    const adjustments: Partial<Record<DreamMode, number>> = {};
    const now = Date.now();

    const targetCounts = this.db
      .prepare(
        `SELECT type, COUNT(*) as c FROM curiosity_targets
         WHERE resolved_at IS NULL AND expires_at > ?
         GROUP BY type`,
      )
      .all(now) as Array<{ type: string; c: number }>;

    const counts = new Map(targetCounts.map((r) => [r.type, r.c]));

    // Many knowledge gaps → increase exploration weight
    if ((counts.get("knowledge_gap") ?? 0) >= 2) {
      adjustments.exploration = 0.15;
    }

    // Many contradictions → increase simulation weight
    if ((counts.get("contradiction") ?? 0) >= 1) {
      adjustments.simulation = 0.1;
    }

    // High frontier activity → increase mutation weight
    if ((counts.get("frontier") ?? 0) >= 2) {
      adjustments.mutation = 0.1;
    }

    return adjustments;
  }

  /**
   * Register a query that deep_recall couldn't answer (Plan 7, Phase 8).
   * Creates a high-priority exploration target so the dream engine
   * specifically looks for this knowledge in the next cycle.
   */
  registerBlindSpot(params: { query: string; scope: string; timestamp: number }): void {
    if (!this.config.enabled) return;
    try {
      const id = crypto.randomUUID();
      const expiresAt = params.timestamp + 7 * 24 * 60 * 60 * 1000; // 7 day TTL
      this.db
        .prepare(
          `INSERT OR IGNORE INTO curiosity_targets
           (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          "knowledge_gap",
          `Deep recall blind spot: "${params.query}" (scope: ${params.scope})`,
          0.85,
          null,
          JSON.stringify({ source: "deep_recall", query: params.query, scope: params.scope }),
          params.timestamp,
          null,
          expiresAt,
        );
    } catch {
      // Non-critical
    }
  }

  // --- Private methods ---

  private detectEmergence(): EmergenceEvent[] {
    const regions = this.loadRegions();
    if (regions.length < 2) return [];

    const events: EmergenceEvent[] = [];
    const now = Date.now();
    const centroids = regions.map((r) => parseEmbedding(r.centroid));

    // Convergence detection: pairs of regions with high similarity (> 0.75)
    for (let i = 0; i < regions.length; i++) {
      const cA = centroids[i];
      if (!cA || cA.length === 0) continue;
      for (let j = i + 1; j < regions.length; j++) {
        const cB = centroids[j];
        if (!cB || cB.length === 0) continue;
        const sim = cosineSimilarity(cA, cB);
        if (sim > 0.75) {
          events.push({
            id: crypto.randomUUID(),
            type: "convergence",
            description: `Regions "${regions[i]!.label}" and "${regions[j]!.label}" are converging (similarity: ${sim.toFixed(3)})`,
            involvedRegions: [regions[i]!.id, regions[j]!.id],
            strength: sim,
            detectedAt: now,
            metadata: { similarity: sim, regionLabels: [regions[i]!.label, regions[j]!.label] },
          });
        }
      }
    }

    // Bridge detection: recent surprise chunks with high similarity to 2+ distant regions
    const recentSurprises = this.db
      .prepare(
        `SELECT cs.chunk_id, c.embedding FROM curiosity_surprises cs
         JOIN chunks c ON c.id = cs.chunk_id
         WHERE cs.assessed_at > ? AND c.embedding IS NOT NULL
         ORDER BY cs.assessed_at DESC LIMIT 20`,
      )
      .all(now - 24 * 60 * 60 * 1000) as Array<{ chunk_id: string; embedding: string }>;

    for (const surprise of recentSurprises) {
      const emb = parseEmbedding(surprise.embedding);
      if (emb.length === 0) continue;

      const highSimRegions: string[] = [];
      for (let i = 0; i < regions.length; i++) {
        const c = centroids[i];
        if (!c || c.length === 0) continue;
        if (cosineSimilarity(emb, c) > 0.6) {
          highSimRegions.push(regions[i]!.id);
        }
      }

      if (highSimRegions.length >= 2) {
        events.push({
          id: crypto.randomUUID(),
          type: "bridge",
          description: `Chunk ${surprise.chunk_id.slice(0, 8)} bridges ${highSimRegions.length} knowledge regions`,
          involvedRegions: highSimRegions,
          strength: Math.min(1, highSimRegions.length / regions.length),
          detectedAt: now,
          metadata: { chunkId: surprise.chunk_id, bridgedCount: highSimRegions.length },
        });
      }
    }

    return events;
  }

  private storeEmergenceEvents(events: EmergenceEvent[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO curiosity_emergence (id, type, description, involved_regions, strength, detected_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      stmt.run(
        event.id,
        event.type,
        event.description,
        JSON.stringify(event.involvedRegions),
        event.strength,
        event.detectedAt,
        JSON.stringify(event.metadata),
      );
    }
  }

  private loadRegions(): RegionRow[] {
    return this.db
      .prepare(`SELECT * FROM curiosity_regions ORDER BY chunk_count DESC LIMIT ?`)
      .all(this.config.maxRegions) as RegionRow[];
  }

  private getNeighborChunks(
    embedding: number[],
    excludeId: string,
    limit: number,
  ): Array<{ embedding: number[]; hash: string }> {
    // Get recent chunks and find nearest neighbors
    const rows = this.db
      .prepare(
        `SELECT id, embedding, hash FROM chunks
         WHERE id != ? AND COALESCE(lifecycle_state, 'active') = 'active'
         ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(excludeId) as Array<{ id: string; embedding: string; hash: string }>;

    const withSim = rows
      .map((r) => {
        const emb = parseEmbedding(r.embedding);
        return { embedding: emb, hash: r.hash, sim: cosineSimilarity(embedding, emb) };
      })
      .filter((r) => r.embedding.length > 0)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit);

    return withSim.map(({ embedding: emb, hash }) => ({ embedding: emb, hash }));
  }

  private rebuildRegions(): number {
    // Load all active chunks with embeddings
    const chunks = this.db
      .prepare(
        `SELECT id, hash, embedding, importance_score, access_count FROM chunks
         WHERE COALESCE(lifecycle_state, 'active') = 'active'
         ORDER BY importance_score DESC LIMIT 500`,
      )
      .all() as ChunkRow[];

    if (chunks.length < 5) return 0;

    // Simple greedy clustering to form knowledge regions
    const embeddings = new Map<string, number[]>();
    for (const chunk of chunks) {
      const emb = parseEmbedding(chunk.embedding);
      if (emb.length > 0) embeddings.set(chunk.id, emb);
    }

    const assigned = new Set<string>();
    const newRegions: Array<{
      chunkIds: string[];
      centroid: number[];
      totalAccesses: number;
      meanImportance: number;
    }> = [];

    for (const chunk of chunks) {
      if (assigned.has(chunk.id)) continue;
      const embA = embeddings.get(chunk.id);
      if (!embA) continue;

      const cluster = [chunk.id];
      assigned.add(chunk.id);
      let totalAccess = chunk.access_count;
      let totalImportance = chunk.importance_score;

      for (const other of chunks) {
        if (assigned.has(other.id)) continue;
        const embB = embeddings.get(other.id);
        if (!embB) continue;
        if (cosineSimilarity(embA, embB) >= 0.7) {
          cluster.push(other.id);
          assigned.add(other.id);
          totalAccess += other.access_count;
          totalImportance += other.importance_score;
        }
      }

      if (cluster.length >= 3) {
        const centroid = computeCentroid(
          cluster.map((id) => embeddings.get(id)!).filter(Boolean),
        );
        newRegions.push({
          chunkIds: cluster,
          centroid,
          totalAccesses: totalAccess,
          meanImportance: totalImportance / cluster.length,
        });
      }

      if (newRegions.length >= this.config.maxRegions) break;
    }

    // Update DB: clear old regions and insert new (in a transaction)
    const now = Date.now();
    try {
      this.db.exec("BEGIN");
      this.db.exec(`DELETE FROM curiosity_regions`);
      const stmt = this.db.prepare(
        `INSERT INTO curiosity_regions
         (id, label, centroid, chunk_count, total_accesses, mean_importance,
          prediction_error, learning_progress, created_at, last_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (let i = 0; i < newRegions.length; i++) {
        const region = newRegions[i]!;
        // Derive a semantic label from the region's chunk content
        const label = this.extractRegionLabel(region.chunkIds) || `region_${i}`;
        // Compute prediction error as mean distance of chunks from centroid
        const errors: number[] = [];
        for (const id of region.chunkIds) {
          const emb = embeddings.get(id);
          if (emb) {
            errors.push(1 - cosineSimilarity(emb, region.centroid));
          }
        }
        const predictionError =
          errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;

        stmt.run(
          crypto.randomUUID(),
          label,
          JSON.stringify(region.centroid),
          region.chunkIds.length,
          region.totalAccesses,
          region.meanImportance,
          predictionError,
          0, // learning progress computed separately
          now,
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      log.warn(`rebuildRegions transaction failed: ${String(err)}`);
      throw err;
    }

    return newRegions.length;
  }

  /**
   * Extract a human-readable label for a knowledge region by finding
   * the most frequent meaningful words across its chunks' text.
   */
  private extractRegionLabel(chunkIds: string[]): string {
    // Sample up to 5 chunks for efficiency
    const sampleIds = chunkIds.slice(0, 5);
    const placeholders = sampleIds.map(() => "?").join(",");
    let texts: string[];
    try {
      const rows = this.db
        .prepare(`SELECT text FROM chunks WHERE id IN (${placeholders})`)
        .all(...sampleIds) as Array<{ text: string }>;
      texts = rows.map((r) => r.text);
    } catch {
      return "";
    }
    if (texts.length === 0) return "";

    // Count word frequencies, filtering stopwords and short words
    const stopwords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "shall", "can", "need", "must", "to", "of",
      "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
      "that", "this", "it", "its", "and", "or", "but", "not", "no", "if",
      "then", "else", "when", "than", "so", "just", "also", "very", "all",
      "any", "each", "which", "what", "who", "how", "where", "there", "here",
      "about", "up", "out", "more", "some", "other", "new", "one", "two",
    ]);
    const wordCounts = new Map<string, number>();
    for (const text of texts) {
      const words = text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
      for (const word of words) {
        if (stopwords.has(word)) continue;
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }

    // Take top 3 words by frequency
    const sorted = [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word]) => word);

    return sorted.join("-");
  }

  private detectGapsAndGenerateTargets(): number {
    const now = Date.now();
    const ttlMs = this.config.targetTtlHours * 60 * 60 * 1000;

    // Count current active targets
    const activeCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM curiosity_targets WHERE resolved_at IS NULL AND expires_at > ?`,
        )
        .get(now) as { c: number }
    )?.c ?? 0;

    if (activeCount >= this.config.maxTargets) return 0;

    // Dedup: fetch types of existing active targets so we don't create duplicates
    const existingTypes = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT type FROM curiosity_targets WHERE resolved_at IS NULL AND expires_at > ?`,
          )
          .all(now) as Array<{ type: string }>
      ).map((r) => r.type),
    );

    const targets: Array<{
      type: ExplorationTargetType;
      description: string;
      priority: number;
      regionId: string | null;
      metadata: Record<string, unknown>;
    }> = [];

    // 1. Knowledge gaps: low-score queries
    if (!existingTypes.has("knowledge_gap")) {
      const lowScoreQueries = this.db
        .prepare(
          `SELECT query, top_score, mean_score, region_id FROM curiosity_queries
           WHERE top_score < ? ORDER BY timestamp DESC LIMIT 20`,
        )
        .all(this.config.gapScoreThreshold) as QueryRow[];

      if (lowScoreQueries.length >= 3) {
        const queries = lowScoreQueries.slice(0, 5).map((q) => q.query);
        targets.push({
          type: "knowledge_gap",
          description: `Knowledge gap detected: queries yielding poor results: ${queries.join("; ")}`,
          priority: 0.7,
          regionId: lowScoreQueries[0]?.region_id ?? null,
          metadata: { queryCount: lowScoreQueries.length, sampleQueries: queries },
        });
      }
    }

    // 2. Stale regions: low learning progress
    if (!existingTypes.has("stale_region")) {
      const regions = this.loadRegions();
      for (const region of regions) {
        if (region.learning_progress < -0.3 && region.chunk_count > 5) {
          targets.push({
            type: "stale_region",
            description: `Stale knowledge region "${region.label}" with ${region.chunk_count} chunks and declining learning progress`,
            priority: 0.5,
            regionId: region.id,
            metadata: { chunkCount: region.chunk_count, learningProgress: region.learning_progress },
          });
        }
      }
    }

    // 3. Contradictions: high contradiction scores in recent assessments
    if (!existingTypes.has("contradiction")) {
      const contradictions = this.db
        .prepare(
          `SELECT chunk_id, contradiction_score, region_id FROM curiosity_surprises
           WHERE contradiction_score > 0.5 ORDER BY assessed_at DESC LIMIT 5`,
        )
        .all() as Array<{ chunk_id: string; contradiction_score: number; region_id: string | null }>;

      if (contradictions.length > 0) {
        targets.push({
          type: "contradiction",
          description: `Contradictory information detected in ${contradictions.length} recent chunks`,
          priority: 0.8,
          regionId: contradictions[0]?.region_id ?? null,
          metadata: {
            chunkIds: contradictions.map((c) => c.chunk_id),
            scores: contradictions.map((c) => c.contradiction_score),
          },
        });
      }
    }

    // 4. Frontiers: high novelty in recent assessments
    if (!existingTypes.has("frontier")) {
      const frontiers = this.db
        .prepare(
          `SELECT chunk_id, novelty_score, region_id FROM curiosity_surprises
           WHERE novelty_score > 0.7 ORDER BY assessed_at DESC LIMIT 5`,
        )
        .all() as Array<{ chunk_id: string; novelty_score: number; region_id: string | null }>;

      if (frontiers.length >= 2) {
        targets.push({
          type: "frontier",
          description: `Frontier exploration opportunity: ${frontiers.length} highly novel chunks detected at the edge of known semantic space`,
          priority: 0.6,
          regionId: null,
          metadata: {
            chunkIds: frontiers.map((f) => f.chunk_id),
            noveltyScores: frontiers.map((f) => f.novelty_score),
          },
        });
      }
    }

    // Store targets up to limit
    const slotsAvailable = this.config.maxTargets - activeCount;
    const toStore = targets
      .sort((a, b) => b.priority - a.priority)
      .slice(0, slotsAvailable);

    const insertStmt = this.db.prepare(
      `INSERT INTO curiosity_targets
       (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const target of toStore) {
      insertStmt.run(
        crypto.randomUUID(),
        target.type,
        target.description,
        target.priority,
        target.regionId,
        JSON.stringify(target.metadata),
        now,
        null,
        now + ttlMs,
      );
    }

    return toStore.length;
  }

  private computeRegionLearningProgress(): void {
    const regions = this.loadRegions();
    const now = Date.now();

    for (const region of regions) {
      // Record current prediction error
      this.db
        .prepare(
          `INSERT INTO curiosity_progress (id, region_id, prediction_error, timestamp)
           VALUES (?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), region.id, region.prediction_error, now);

      // Compute learning progress from history
      const history = this.db
        .prepare(
          `SELECT prediction_error as error, timestamp FROM curiosity_progress
           WHERE region_id = ? ORDER BY timestamp ASC LIMIT 50`,
        )
        .all(region.id) as Array<{ error: number; timestamp: number }>;

      const progress = this.computeLearningProgressFromHistory(history);

      this.db
        .prepare(
          `UPDATE curiosity_regions SET learning_progress = ?, last_updated_at = ? WHERE id = ?`,
        )
        .run(progress, now, region.id);
    }
  }

  private expireTargets(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `DELETE FROM curiosity_targets WHERE expires_at <= ? AND resolved_at IS NULL`,
      )
      .run(now);
    return (result as { changes: number }).changes;
  }

  private pruneQueryHistory(): void {
    const max = this.config.maxQueryHistory;
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM curiosity_queries`).get() as {
      c: number;
    };
    if (row.c <= max) return;

    const excess = row.c - max;
    this.db
      .prepare(
        `DELETE FROM curiosity_queries WHERE id IN (
          SELECT id FROM curiosity_queries ORDER BY timestamp ASC LIMIT ?
        )`,
      )
      .run(excess);
  }

  /**
   * Handle an incoming novelty signal from a peer node.
   * Boosts priority of the nearest matching region so our curiosity engine
   * explores that area sooner.
   */
  handleNoveltySignal(signal: NoveltySignal): void {
    if (!this.config.enabled) return;
    const regions = this.loadRegions();
    if (regions.length === 0) return;

    // Find region matching the domain_hint label (fuzzy match)
    let matchedRegion: RegionRow | null = null;
    for (const r of regions) {
      if (r.label.toLowerCase().includes(signal.region.toLowerCase()) ||
          signal.region.toLowerCase().includes(r.label.toLowerCase())) {
        matchedRegion = r;
        break;
      }
    }

    if (!matchedRegion) {
      log.debug(`novelty signal for unmatched region '${signal.region}', ignoring`);
      return;
    }

    // Boost region's prediction_error to increase curiosity drive toward it
    const boostAmount = signal.surprise_score * 0.3; // 30% of peer's surprise
    const newError = Math.min(matchedRegion.prediction_error + boostAmount, 1.0);
    this.db
      .prepare(`UPDATE curiosity_regions SET prediction_error = ?, last_updated_at = ? WHERE id = ?`)
      .run(newError, Date.now(), matchedRegion.id);

    log.debug(
      `novelty signal boosted region '${matchedRegion.label}' prediction_error: ` +
      `${matchedRegion.prediction_error.toFixed(3)} → ${newError.toFixed(3)} (peer surprise: ${signal.surprise_score.toFixed(3)})`,
    );
  }

  /**
   * Threshold for emitting a novelty signal to the network.
   * assessChunk compositeReward above this value triggers a signal.
   */
  static readonly NOVELTY_SIGNAL_THRESHOLD = 0.7;

  /**
   * GCCRF-enhanced target generation.
   * Uses GCCRF signals (from gccrf_state) to prioritize exploration targets:
   * - High mean η → surprising regions worth investigating
   * - Low Δη → stuck regions needing new approaches
   * - Low density → frontier regions
   */
  generateGCCRFTargets(): number {
    if (!this.config.enabled) return 0;

    const now = Date.now();
    const ttlMs = this.config.targetTtlHours * 60 * 60 * 1000;

    // Check current target count
    const activeCount = (
      this.db
        .prepare(`SELECT COUNT(*) as c FROM curiosity_targets WHERE resolved_at IS NULL AND expires_at > ?`)
        .get(now) as { c: number }
    )?.c ?? 0;

    if (activeCount >= this.config.maxTargets) return 0;

    // Try reading GCCRF region ETA state
    let regionEta: Record<string, { emaLong: number; emaShort: number; sampleCount: number }> = {};
    try {
      const row = this.db
        .prepare(`SELECT value FROM gccrf_state WHERE key = 'region_eta'`)
        .get() as { value: string } | undefined;
      if (row) regionEta = JSON.parse(row.value);
    } catch { /* gccrf_state may not exist yet */ }

    const regions = this.loadRegions();
    const targets: Array<{
      type: ExplorationTargetType;
      description: string;
      priority: number;
      regionId: string | null;
      metadata: Record<string, unknown>;
    }> = [];

    for (const region of regions) {
      const eta = regionEta[region.id];
      if (!eta || eta.sampleCount < 3) continue;

      // High mean η (emaShort) → region is still surprising → worth investigating
      if (eta.emaShort > 0.7 && activeCount + targets.length < this.config.maxTargets) {
        targets.push({
          type: "knowledge_gap",
          description: `GCCRF: high prediction error in region "${region.label}" (η=${eta.emaShort.toFixed(2)}) — needs investigation`,
          priority: Math.min(1.0, 0.6 + eta.emaShort * 0.3),
          regionId: region.id,
          metadata: { source: "gccrf", etaShort: eta.emaShort, etaLong: eta.emaLong },
        });
      }

      // Low Δη (emaLong ≈ emaShort, both high) → NOT making progress → stuck
      const deltaEta = Math.max(0, eta.emaLong - eta.emaShort);
      if (deltaEta < 0.05 && eta.emaShort > 0.5 && eta.sampleCount > 10) {
        targets.push({
          type: "stale_region",
          description: `GCCRF: region "${region.label}" is stuck (Δη=${deltaEta.toFixed(3)}, η=${eta.emaShort.toFixed(2)}) — needs new approach`,
          priority: 0.65,
          regionId: region.id,
          metadata: { source: "gccrf", deltaEta, etaShort: eta.emaShort, sampleCount: eta.sampleCount },
        });
      }
    }

    // Store targets
    const slotsAvailable = this.config.maxTargets - activeCount;
    const toStore = targets.sort((a, b) => b.priority - a.priority).slice(0, slotsAvailable);
    const stmt = this.db.prepare(
      `INSERT INTO curiosity_targets (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const target of toStore) {
      stmt.run(
        crypto.randomUUID(), target.type, target.description, target.priority,
        target.regionId, JSON.stringify(target.metadata), now, null, now + ttlMs,
      );
    }

    return toStore.length;
  }

  /**
   * GCCRF-informed target retirement.
   * Retire targets for regions where:
   * - Δη is consistently high (making progress → curiosity satisfied)
   * - density has increased significantly (no longer frontier)
   */
  retireGCCRFTargets(): number {
    if (!this.config.enabled) return 0;

    let regionEta: Record<string, { emaLong: number; emaShort: number; sampleCount: number }> = {};
    try {
      const row = this.db
        .prepare(`SELECT value FROM gccrf_state WHERE key = 'region_eta'`)
        .get() as { value: string } | undefined;
      if (row) regionEta = JSON.parse(row.value);
    } catch { return 0; }

    const now = Date.now();
    let retired = 0;

    // Get active targets with region IDs
    const activeTargets = this.db
      .prepare(
        `SELECT id, region_id FROM curiosity_targets
         WHERE resolved_at IS NULL AND expires_at > ? AND region_id IS NOT NULL`,
      )
      .all(now) as Array<{ id: string; region_id: string }>;

    for (const target of activeTargets) {
      const eta = regionEta[target.region_id];
      if (!eta || eta.sampleCount < 5) continue;

      // Retire if Δη is consistently high (making good progress)
      const deltaEta = Math.max(0, eta.emaLong - eta.emaShort);
      if (deltaEta > 0.15 && eta.emaShort < 0.3) {
        // Learning progress is strong and current surprise is low → curiosity satisfied
        this.db
          .prepare(`UPDATE curiosity_targets SET resolved_at = ? WHERE id = ?`)
          .run(now, target.id);
        retired++;
      }
    }

    return retired;
  }

  /**
   * Get GCCRF-enhanced curiosity state summary including alpha and maturity.
   */
  getGCCRFSummary(): {
    alpha: number | null;
    maturity: number | null;
    regionProgress: Array<{ regionId: string; label: string; deltaEta: number; eta: number }>;
  } {
    let alpha: number | null = null;
    let maturity: number | null = null;
    const regionProgress: Array<{ regionId: string; label: string; deltaEta: number; eta: number }> = [];

    // Read alpha from gccrf_state normalizers (calculate from dream cycles)
    try {
      const dreamCycleRow = this.db
        .prepare(`SELECT COUNT(*) as c FROM dream_cycles WHERE completed_at IS NOT NULL`)
        .get() as { c: number } | undefined;
      const dreamCycles = dreamCycleRow?.c ?? 0;
      const EXPECTED_MATURE_CYCLES = 100;
      maturity = Math.min(1, dreamCycles / EXPECTED_MATURE_CYCLES);
      const ALPHA_START = -3.0;
      const ALPHA_END = 0.0;
      alpha = ALPHA_START + (ALPHA_END - ALPHA_START) * maturity;
    } catch { /* tables may not exist */ }

    // Read per-region learning progress from GCCRF state
    try {
      const row = this.db
        .prepare(`SELECT value FROM gccrf_state WHERE key = 'region_eta'`)
        .get() as { value: string } | undefined;
      if (row) {
        const regionEta = JSON.parse(row.value) as Record<string, { emaLong: number; emaShort: number; sampleCount: number }>;
        const regions = this.loadRegions();
        const regionMap = new Map(regions.map((r) => [r.id, r.label]));

        for (const [regionId, eta] of Object.entries(regionEta)) {
          if (eta.sampleCount < 2) continue;
          regionProgress.push({
            regionId,
            label: regionMap.get(regionId) ?? regionId,
            deltaEta: Math.max(0, eta.emaLong - eta.emaShort),
            eta: eta.emaShort,
          });
        }
      }
    } catch { /* gccrf_state may not exist */ }

    return { alpha, maturity, regionProgress };
  }

  // ── GCCRF Proxy Methods ──
  // These expose the internal GCCRFRewardFunction for consumers that need
  // maturity, alpha, FSHO coupling, or direct reward computation.

  /** Agent maturity ratio [0, 1]. */
  getMaturity(): number {
    return this.gccrfReward.getMaturity();
  }

  /** Current alpha schedule value. */
  getCurrentAlpha(): number {
    return this.gccrfReward.getCurrentAlpha();
  }

  /** Update FSHO order parameter EMA (called by DreamEngine after FSHO computation). */
  updateFshoR(orderParameter: number): void {
    this.gccrfReward.updateFshoR(orderParameter);
  }

  /** Get FSHO R EMA value. */
  getFshoRAvg(): number {
    return this.gccrfReward.getFshoRAvg();
  }

  /** Get FSHO-coupled alpha (modulated by memory landscape coherence). */
  getFshoCoupledAlpha(): number {
    return this.gccrfReward.getFshoCoupledAlpha();
  }

  /** Persist GCCRF normalizer and region ETA state. */
  saveGCCRFState(): void {
    this.gccrfReward.saveState();
  }

  /** Get full GCCRF diagnostic state. */
  getGCCRFState(): Record<string, unknown> {
    return this.gccrfReward.getState() as unknown as Record<string, unknown>;
  }

  /** Get current GCCRF config. */
  getGCCRFConfig(): Record<string, unknown> {
    return this.gccrfReward.getConfig() as unknown as Record<string, unknown>;
  }

  /** Get GCCRF diagnostics bundle for dashboard. */
  gccrfDiagnostics(): {
    alpha: number;
    maturity: number;
    state: Record<string, unknown>;
    config: Record<string, unknown>;
  } {
    return {
      alpha: this.gccrfReward.getCurrentAlpha(),
      maturity: this.gccrfReward.getMaturity(),
      state: this.gccrfReward.getState() as unknown as Record<string, unknown>,
      config: this.gccrfReward.getConfig() as unknown as Record<string, unknown>,
    };
  }

  // ── Reward Computation (absorbed from manager bridge) ──

  /**
   * Compute GCCRF reward for a single chunk. Used by manager for inline scoring.
   * Returns the full result so the caller can trigger hormonal responses.
   */
  computeReward(chunkId: string, chunkEmbedding: number[]): GCCRFRewardResult | null {
    if (!this.config.enabled) return null;
    if (chunkEmbedding.length === 0) return null;

    try {
      const regions = this.loadRegions();
      const regionCentroids = new Map<string, number[]>();
      for (const region of regions) {
        const centroid = parseEmbedding(region.centroid);
        if (centroid.length > 0) regionCentroids.set(region.id, centroid);
      }

      const strategicTargets: number[][] = [];
      try {
        const targets = this.db
          .prepare(
            `SELECT region_id FROM curiosity_targets
             WHERE resolved_at IS NULL AND expires_at > ?
             ORDER BY priority DESC LIMIT ?`,
          )
          .all(Date.now(), this.config.maxTargets) as Array<{ region_id: string | null }>;
        for (const t of targets) {
          if (t.region_id) {
            const c = regionCentroids.get(t.region_id);
            if (c) strategicTargets.push(c);
          }
        }
      } catch { /* non-critical */ }

      const result = this.gccrfReward.compute(chunkEmbedding, regionCentroids, strategicTargets);

      this.db
        .prepare(`UPDATE chunks SET curiosity_reward = ? WHERE id = ?`)
        .run(result.reward, chunkId);

      return result;
    } catch (err) {
      log.debug(`GCCRF computation failed for chunk ${chunkId}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Batch-score all chunks with NULL curiosity_reward.
   * Called during consolidation cycle.
   */
  scorePendingChunks(): number {
    if (!this.config.enabled) return 0;

    try {
      const pendingRows = this.db
        .prepare(
          `SELECT id, embedding FROM chunks
           WHERE curiosity_reward IS NULL
             AND COALESCE(lifecycle_state, 'active') = 'active'
             AND embedding IS NOT NULL AND embedding != '[]'
           LIMIT 100`,
        )
        .all() as Array<{ id: string; embedding: string }>;

      if (pendingRows.length === 0) return 0;

      // Gather shared context once
      const regions = this.loadRegions();
      const regionCentroids = new Map<string, number[]>();
      for (const region of regions) {
        const centroid = parseEmbedding(region.centroid);
        if (centroid.length > 0) regionCentroids.set(region.id, centroid);
      }

      const strategicTargets: number[][] = [];
      try {
        const targets = this.db
          .prepare(
            `SELECT region_id FROM curiosity_targets
             WHERE resolved_at IS NULL AND expires_at > ?
             ORDER BY priority DESC LIMIT ?`,
          )
          .all(Date.now(), this.config.maxTargets) as Array<{ region_id: string | null }>;
        for (const t of targets) {
          if (t.region_id) {
            const c = regionCentroids.get(t.region_id);
            if (c) strategicTargets.push(c);
          }
        }
      } catch { /* non-critical */ }

      let scored = 0;
      const updateStmt = this.db.prepare(
        `UPDATE chunks SET curiosity_reward = ? WHERE id = ?`,
      );

      for (const row of pendingRows) {
        try {
          const emb = JSON.parse(row.embedding) as number[];
          if (emb.length === 0) continue;
          const result = this.gccrfReward.compute(emb, regionCentroids, strategicTargets);
          updateStmt.run(result.reward, row.id);
          scored++;
        } catch { /* skip individual failures */ }
      }

      if (scored > 0) {
        log.debug(`GCCRF batch scored ${scored} pending chunks`);
      }

      return scored;
    } catch (err) {
      log.debug(`GCCRF batch scoring failed: ${String(err)}`);
      return 0;
    }
  }

  /** Count chunks that haven't been GCCRF-scored yet. */
  countPendingChunks(): number {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) as c FROM chunks WHERE curiosity_reward IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'`)
        .get() as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Private: Contradiction Detection (moved from curiosity-math.ts) ──

  /**
   * Detects conflicting information within a region.
   * High similarity in embedding space + different content hash = contradiction signal.
   */
  private computeContradiction(
    chunkEmbedding: number[],
    chunkHash: string,
    neighborEmbeddings: Array<{ embedding: number[]; hash: string }>,
  ): number {
    if (neighborEmbeddings.length === 0) return 0;

    let maxContradiction = 0;
    for (const neighbor of neighborEmbeddings) {
      const sim = cosineSimilarity(chunkEmbedding, neighbor.embedding);
      if (sim >= 0.85 && chunkHash !== neighbor.hash) {
        const contradiction = sim * 0.8;
        if (contradiction > maxContradiction) {
          maxContradiction = contradiction;
        }
      }
    }
    return maxContradiction;
  }

  /**
   * Learning progress from prediction error history (moved from curiosity-math.ts).
   * Positive = region is improving (errors decreasing).
   */
  private computeLearningProgressFromHistory(
    errorHistory: Array<{ error: number; timestamp: number }>,
  ): number {
    if (errorHistory.length < 2) return 0;

    const n = errorHistory.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const t0 = errorHistory[0]!.timestamp;

    for (const entry of errorHistory) {
      const x = (entry.timestamp - t0) / (1000 * 60);
      const y = entry.error;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-10) return 0;

    const slope = (n * sumXY - sumX * sumY) / denom;
    return Math.max(-1, Math.min(1, -slope * 100));
  }

  /**
   * Match a peer query against local knowledge regions.
   * Returns descriptions of regions that might satisfy the query.
   */
  matchQuery(query: string): Array<{ regionId: string; label: string; score: number }> {
    if (!this.config.enabled) return [];
    const regions = this.loadRegions();
    const results: Array<{ regionId: string; label: string; score: number }> = [];

    const queryLower = query.toLowerCase();
    for (const r of regions) {
      // Simple keyword matching — check if query terms appear in region label
      const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
      const matchCount = words.filter((w) => r.label.toLowerCase().includes(w)).length;
      if (matchCount > 0 && r.chunk_count > 0) {
        const score = (matchCount / words.length) * Math.min(r.chunk_count / 10, 1.0);
        results.push({ regionId: r.id, label: r.label, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
  }
}

/** Novelty signal from a peer node. */
export type NoveltySignal = {
  region: string;
  surprise_score: number;
  domain_hint?: string;
};
