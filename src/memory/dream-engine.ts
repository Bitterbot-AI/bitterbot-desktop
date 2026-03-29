/**
 * DreamEngine: offline discovery of cross-domain patterns across accumulated
 * memories. Implements a state machine (DORMANT → INCUBATING → DREAMING →
 * SYNTHESIZING → AWAKENING → DORMANT) with 7 distinct dream modes:
 *
 *  1. Replay — Strengthen important memory pathways (no LLM)
 *  2. Mutation — Generate skill/knowledge variations (LLM)
 *  3. Extrapolation — Predict future patterns (LLM)
 *  4. Compression — Generalize into higher abstractions (heuristic/LLM)
 *  5. Simulation — Cross-domain creative recombination (LLM)
 *  6. Exploration — Gap-filling from curiosity targets (LLM)
 *  7. Research — Empirical prompt optimization using execution data (LLM)
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { computeCentroid, cosineSimilarity, parseEmbedding } from "./internal.js";
import {
  type ComputeTier,
  type DreamCluster,
  type DreamCreativityMode,
  type DreamCycleMetadata,
  type DreamEngineConfig,
  type DreamInsight,
  type DreamMode,
  type DreamModeConfig,
  type DreamState,
  type DreamStats,
  type DreamSynthesisResult,
  type EmbedBatchFn,
  type SynthesizeFn,
  DEFAULT_DREAM_CONFIG,
  DEFAULT_MODE_CONFIGS,
  DEFAULT_MODE_TIERS,
} from "./dream-types.js";
import { ensureDreamSchema, recordDreamTelemetry } from "./dream-schema.js";
import {
  buildDreamSynthesisPrompt,
  heuristicSynthesize,
  parseDreamSynthesisResponse,
} from "./dream-synthesis-prompt.js";
import { ensureColumn } from "./memory-schema.js";
import { selectStrategy, buildStrategyPrompt } from "./dream-mutation-strategies.js";
import { PromptOptimizationExperiment } from "./prompt-optimization.js";
import { ExperimentSandbox, type MutationVerdict } from "./experiment-sandbox.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import type { HormonalStateManager } from "./hormonal.js";
import { simulateFSHO, fshoModeAdjustments } from "./dream-oscillator.js";

const log = createSubsystemLogger("memory/dream");

type ChunkRow = {
  id: string;
  text: string;
  embedding: string;
  importance_score: number;
  access_count: number;
  curiosity_boost: number;
  dream_count: number;
  last_dreamed_at: number | null;
  emotional_valence: number | null;
  semantic_type?: string | null;
  memory_type?: string | null;
  lifecycle?: string | null;
};

const CREATIVITY_MODES: DreamCreativityMode[] = [
  "associative",
  "convergent",
  "cross_domain",
];

export type CuriosityWeightProvider = {
  getDreamModeWeightAdjustments(): Partial<Record<DreamMode, number>>;
};

/** GCCRF component averages for mode influence. */
export type GCCRFModeInfluence = {
  eta: number;
  deltaEta: number;
  iAlpha: number;
  empowerment: number;
  strategic: number;
};

export class DreamEngine {
  private db: DatabaseSync;
  private readonly config: Required<Omit<DreamEngineConfig, "llmCall" | "localLlmCall" | "modes" | "modelTiers">> & { modes: Record<DreamMode, DreamModeConfig> };
  private readonly synthesize: SynthesizeFn;
  private readonly embedBatch: EmbedBatchFn;
  private readonly llmCallCloud: ((prompt: string) => Promise<string>) | null;
  private readonly llmCallLocal: ((prompt: string) => Promise<string>) | null;
  private readonly modeTiers: Record<DreamMode, ComputeTier>;
  private readonly fallbackToCloud: boolean;
  private curiosityWeightProvider: CuriosityWeightProvider | null = null;
  private hormonalStateGetter: (() => { dopamine: number; cortisol: number; oxytocin: number } | null) | null = null;
  private executionTracker: SkillExecutionTracker | null = null;
  private hormonalManager: HormonalStateManager | null = null;
  private gccrfRewardFunction: { updateFshoR(r: number): void; getFshoRAvg(): number; getFshoCoupledAlpha(): number } | null = null;
  private marketplaceIntelligence: { hasActivity(): boolean; getDreamModeAdjustments(): Partial<Record<DreamMode, number>>; injectDemandTargets(): number } | null = null;
  private state: DreamState = "DORMANT";
  private lastModeUsed: DreamMode | null = null;

  constructor(
    db: DatabaseSync,
    config: DreamEngineConfig | undefined,
    synthesize: SynthesizeFn,
    embedBatch: EmbedBatchFn,
  ) {
    this.db = db;

    // Merge mode configs
    const resolvedModes = { ...DEFAULT_MODE_CONFIGS };
    if (config?.modes) {
      for (const [mode, overrides] of Object.entries(config.modes)) {
        const key = mode as DreamMode;
        if (resolvedModes[key] && overrides) {
          resolvedModes[key] = { ...resolvedModes[key], ...overrides };
        }
      }
    }
    this.config = {
      ...DEFAULT_DREAM_CONFIG,
      ...config,
      modes: resolvedModes,
    } as Required<Omit<DreamEngineConfig, "llmCall" | "localLlmCall" | "modes" | "modelTiers">> & { modes: Record<DreamMode, DreamModeConfig> };
    this.synthesize = synthesize;
    this.embedBatch = embedBatch;
    this.llmCallCloud = config?.llmCall ?? null;
    this.llmCallLocal = config?.localLlmCall ?? null;
    // Tiered compute routing
    this.modeTiers = { ...DEFAULT_MODE_TIERS, ...config?.modelTiers?.modeTiers };
    this.fallbackToCloud = config?.modelTiers?.fallbackToCloud ?? true;
    ensureDreamSchema(db);
    // Ensure modes_used column exists on dream_cycles
    ensureColumn(db, "dream_cycles", "modes_used", "TEXT DEFAULT '[]'");
  }

  /**
   * Get the appropriate LLM call function for a given dream mode based on tier routing.
   * Returns null if the mode's tier is "none" or no suitable LLM is available.
   */
  getLlmCallForMode(mode: DreamMode): ((prompt: string) => Promise<string>) | null {
    const tier = this.modeTiers[mode];

    if (tier === "none") return null;

    if (tier === "local") {
      if (this.llmCallLocal) return this.llmCallLocal;
      // Fallback chain: local → cloud (if allowed)
      if (this.fallbackToCloud && this.llmCallCloud) return this.llmCallCloud;
      return null;
    }

    // tier === "cloud"
    if (this.llmCallCloud) return this.llmCallCloud;
    return null;
  }

  /**
   * Wire a curiosity engine to influence dream mode selection weights.
   */
  setCuriosityWeightProvider(provider: CuriosityWeightProvider | null): void {
    this.curiosityWeightProvider = provider;
  }

  /**
   * Wire a hormonal state getter for temperature-modulated mode selection.
   */
  setHormonalStateGetter(getter: () => { dopamine: number; cortisol: number; oxytocin: number } | null): void {
    this.hormonalStateGetter = getter;
  }

  /**
   * Wire a skill execution tracker for research mode.
   * Research mode requires execution data to ground its experiments.
   */
  setExecutionTracker(tracker: SkillExecutionTracker): void {
    this.executionTracker = tracker;
  }

  /**
   * Wire the hormonal manager for dopamine spikes on mutation promotion.
   */
  setHormonalManager(manager: HormonalStateManager): void {
    this.hormonalManager = manager;
  }

  /** Plan 8, Phase 7: Set marketplace intelligence for demand-driven dreams. */
  setMarketplaceIntelligence(mi: { hasActivity(): boolean; getDreamModeAdjustments(): Partial<Record<DreamMode, number>>; injectDemandTargets(): number } | null): void {
    this.marketplaceIntelligence = mi;
  }

  /** Plan 7, Phase 10: Set GCCRF reward function for FSHO alpha coupling. */
  setGccrfRewardFunction(fn: { updateFshoR(r: number): void; getFshoRAvg(): number; getFshoCoupledAlpha(): number } | null): void {
    this.gccrfRewardFunction = fn;
  }

  getState(): DreamState {
    return this.state;
  }

  // ── Dream Readiness (Phase 6: Neuroscience Harvest) ──

  /**
   * Compute dream readiness score [0, 1].
   *   0         = nothing new, skip entirely
   *   (0, 0.3)  = trickle of new info
   *   [0.3, 1]  = meaningful new material, full cycle
   */
  private computeDreamReadiness(): { ready: boolean; score: number; reason: string } {
    // 1. When was the last completed dream?
    const lastDream = this.db.prepare(
      `SELECT MAX(started_at) as last FROM dream_cycles WHERE completed_at IS NOT NULL`,
    ).get() as { last: number | null } | undefined;

    const since = lastDream?.last ?? 0;

    // 2. Count new/updated chunks since last dream
    const newChunks = (this.db.prepare(
      `SELECT COUNT(*) as c FROM chunks WHERE created_at > ? OR updated_at > ?`,
    ).get(since, since) as { c: number })?.c ?? 0;

    // 3. Total active chunks (for information ratio)
    const totalChunks = (this.db.prepare(
      `SELECT COUNT(*) as c FROM chunks
       WHERE COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated', 'frozen')`,
    ).get() as { c: number })?.c ?? 1;

    // 4. Information ratio
    const infoRatio = newChunks / Math.max(totalChunks, 1);

    // 5. Secondary triggers (table-existence-safe)
    let pendingHints = 0;
    try {
      pendingHints = (this.db.prepare(
        `SELECT COUNT(*) as c FROM near_merge_hints WHERE consumed_at IS NULL`,
      ).get() as { c: number })?.c ?? 0;
    } catch {
      // near_merge_hints table may not exist yet
    }

    let orphanQueue = 0;
    try {
      orphanQueue = (this.db.prepare(
        `SELECT COUNT(*) as c FROM orphan_replay_queue WHERE consumed_at IS NULL`,
      ).get() as { c: number })?.c ?? 0;
    } catch {
      // orphan_replay_queue table may not exist yet
    }

    const curiosityTargets = this.countCuriosityTargets();

    // 6. Compute score
    let score = infoRatio;
    if (pendingHints > 0) score = Math.max(score, 0.3);
    if (orphanQueue > 0) score = Math.max(score, 0.3);
    if (curiosityTargets > 0) score = Math.max(score, 0.2);

    // 7. Determine readiness
    if (newChunks === 0 && pendingHints === 0 && orphanQueue === 0 && curiosityTargets === 0) {
      return { ready: false, score: 0, reason: "no new material since last cycle" };
    }

    if (newChunks < 3 && pendingHints === 0 && orphanQueue === 0 && curiosityTargets === 0) {
      return { ready: false, score, reason: `only ${newChunks} new chunks, below threshold` };
    }

    return { ready: true, score: Math.min(1, score), reason: `${newChunks} new chunks, ratio=${infoRatio.toFixed(2)}` };
  }

  /** Update the database handle after a reindex swaps the underlying file. */
  updateDb(db: DatabaseSync): void {
    this.db = db;
    // Re-ensure schema on the new DB (reindex creates a fresh file)
    ensureDreamSchema(db);
    ensureColumn(db, "dream_cycles", "modes_used", "TEXT DEFAULT '[]'");
  }

  status(): Record<string, unknown> {
    // Guard against closed/uninitialized database
    let insightCount = 0;
    let cycleCount = 0;
    let lastCycle: DreamCycleMetadata | undefined;
    try {
      insightCount = (
        this.db.prepare(`SELECT COUNT(*) as c FROM dream_insights`).get() as { c: number }
      )?.c ?? 0;
      cycleCount = (
        this.db.prepare(`SELECT COUNT(*) as c FROM dream_cycles`).get() as { c: number }
      )?.c ?? 0;
      lastCycle = this.db
        .prepare(`SELECT * FROM dream_cycles ORDER BY started_at DESC LIMIT 1`)
        .get() as DreamCycleMetadata | undefined;
    } catch {
      // DB may not be open yet — return partial status
    }
    // Strip functions from config — the agent framework structuredClone's tool results
    // in the message history, and functions are not cloneable (DataCloneError).
    const { llmCall: _, synthesisLlmCall: _s, localLlmCall: _l, ...safeConfig } = this.config as Record<string, unknown>;
    return {
      state: this.state,
      insightCount,
      cycleCount,
      lastCycle: lastCycle ?? null,
      config: safeConfig,
      modes: this.config.modes,
    };
  }

  async run(opts?: { modes?: DreamMode[] }): Promise<DreamStats | null> {
    if (this.state !== "DORMANT") {
      log.debug("dream engine already running", { state: this.state });
      return null;
    }

    // Dream readiness gate (skip for mode-specific runs like mini-dreams)
    if (!opts?.modes) {
      const readiness = this.computeDreamReadiness();
      recordDreamTelemetry(this.db, `pre-${crypto.randomUUID().slice(0, 8)}`, "readiness", "score", readiness.score);

      if (!readiness.ready) {
        log.debug(`skipping dream cycle: ${readiness.reason}`);
        return null;
      }
      log.debug("dream readiness check passed", { score: readiness.score, reason: readiness.reason });
    }

    const cycleId = crypto.randomUUID();
    const startedAt = Date.now();
    const cycleMeta: DreamCycleMetadata = {
      cycleId,
      startedAt,
      completedAt: null,
      durationMs: null,
      state: "INCUBATING",
      clustersProcessed: 0,
      insightsGenerated: 0,
      chunksAnalyzed: 0,
      llmCallsUsed: 0,
      error: null,
      modesUsed: [],
    };

    this.recordCycle(cycleMeta);

    try {
      // INCUBATING: select modes and seed chunks
      this.state = "INCUBATING";
      cycleMeta.state = "INCUBATING";

      const selectedModes = opts?.modes ?? this.selectModes();
      cycleMeta.modesUsed = selectedModes;

      // Check minimum chunks
      const totalChunks = (
        this.db.prepare(
          `SELECT COUNT(*) as c FROM chunks
           WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                  OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
             AND importance_score >= ?`,
        ).get(this.config.minImportanceForDream) as { c: number }
      )?.c ?? 0;

      if (totalChunks < this.config.minChunksForDream) {
        log.debug("not enough chunks for dream cycle", {
          found: totalChunks,
          needed: this.config.minChunksForDream,
        });
        this.completeCycle(cycleMeta, null);
        return null;
      }

      // DREAMING: run each selected mode
      this.state = "DREAMING";
      cycleMeta.state = "DREAMING";

      const allInsights: DreamInsight[] = [];
      let totalLlmCalls = 0;
      let totalChunksAnalyzed = 0;

      for (const mode of selectedModes) {
        if (totalLlmCalls >= this.config.maxLlmCallsPerCycle &&
            this.config.modes[mode].requiresLlm) {
          log.debug(`skipping ${mode} mode: LLM budget exhausted`);
          continue;
        }

        const { insights, llmCalls, chunksAnalyzed } = await this.runMode(mode, cycleId);
        allInsights.push(...insights);
        totalLlmCalls += llmCalls;
        totalChunksAnalyzed += chunksAnalyzed;
      }

      cycleMeta.chunksAnalyzed = totalChunksAnalyzed;
      cycleMeta.llmCallsUsed = totalLlmCalls;
      cycleMeta.clustersProcessed = selectedModes.length;

      // SYNTHESIZING: embed insights
      this.state = "SYNTHESIZING";
      cycleMeta.state = "SYNTHESIZING";

      // AWAKENING: store insights
      this.state = "AWAKENING";
      cycleMeta.state = "AWAKENING";

      if (allInsights.length > 0) {
        // Embed insights that don't have embeddings yet
        const needsEmbed = allInsights.filter((i) => i.embedding.length === 0);
        if (needsEmbed.length > 0) {
          const embeddings = await this.embedBatch(needsEmbed.map((i) => i.content));
          for (let i = 0; i < needsEmbed.length; i++) {
            needsEmbed[i]!.embedding = embeddings[i] ?? [];
          }
        }

        this.storeInsights(allInsights);
        this.pruneInsights();
      }

      cycleMeta.insightsGenerated = allInsights.length;
      this.completeCycle(cycleMeta, null);

      const stats: DreamStats = { cycle: cycleMeta, newInsights: allInsights };

      // Plan 7, Phase 5: Dream outcome evaluation — close the telemetry loop
      try {
        const { evaluateDreamOutcome, persistDreamOutcome } = await import("./dream-evaluator.js");
        const outcome = evaluateDreamOutcome({
          cycleId,
          db: this.db,
          stats,
          tokenBudget: this.config.maxLlmCallsPerCycle ?? 5,
          tokensUsed: totalLlmCalls,
        });
        persistDreamOutcome(this.db, outcome);
        this.recordTelemetry(cycleId, "outcome", "dqs", outcome.dqs);
        log.debug("dream outcome", {
          cycleId,
          dqs: outcome.dqs.toFixed(3),
        });
      } catch {
        // Dream evaluator not available — non-critical
      }

      log.debug("dream cycle complete", {
        cycleId,
        modes: selectedModes,
        insights: allInsights.length,
        llmCalls: totalLlmCalls,
      });

      return stats;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`dream cycle failed: ${message}`);
      this.completeCycle(cycleMeta, message);
      return null;
    }
  }

  // ── Mini-Dream (Plan 6, Phase 4: Emotional Dream Triggering) ──

  /**
   * Run a mini dream cycle triggered by emotional spike.
   * Runs a single non-LLM mode with standard chunk limits.
   *
   * dopamine_spike → replay mode (reinforce the positive experience)
   * cortisol_spike → compression mode (process the stressful event via heuristic)
   *
   * Both modes can run without LLM calls, so mini-dreams are free.
   */
  async runMiniDream(reason: string): Promise<DreamStats | null> {
    if (this.state !== "DORMANT") return null;

    const mode: DreamMode = reason === "dopamine_spike" ? "replay" : "compression";
    log.info(`emotional mini-dream triggered: ${reason} → ${mode}`);

    return this.run({ modes: [mode] });
  }

  // ── Mode Selection ──

  private selectModes(): DreamMode[] {
    const enabledModes = (Object.entries(this.config.modes) as [DreamMode, DreamModeConfig][])
      .filter(([, cfg]) => cfg.enabled && cfg.weight > 0);

    if (enabledModes.length === 0) return ["replay"];

    // --- Three complementary adjustment sources (Plan 6, Phase 1) ---

    // 1. Curiosity: heuristic gap detection
    const curiosityAdj = this.curiosityWeightProvider?.getDreamModeWeightAdjustments() ?? {};

    // 2. GCCRF: what the agent needs to learn (prediction error, learning progress, etc.)
    const gccrfAdj = this.computeGCCRFModeAdjustments();

    // 3. FSHO: what the memory landscape looks like (coherence vs. scatter)
    const hormones = this.hormonalStateGetter?.() ?? null;
    let fshoAdj: Partial<Record<DreamMode, number>> = {};
    try {
      const salienceRows = this.db.prepare(
        `SELECT importance_score FROM chunks
         WHERE COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
           AND importance_score >= ?
         ORDER BY importance_score DESC LIMIT 20`,
      ).all(this.config.minImportanceForDream) as Array<{ importance_score: number }>;

      if (salienceRows.length >= 5) {
        const { orderParameter } = simulateFSHO(salienceRows.map(r => r.importance_score));
        fshoAdj = fshoModeAdjustments(orderParameter, hormones);

        // Plan 7, Phase 10: FSHO ↔ GCCRF alpha coupling
        // Feed order parameter into GCCRF for self-regulating curiosity drive
        if (this.gccrfRewardFunction) {
          try {
            this.gccrfRewardFunction.updateFshoR(orderParameter);
          } catch {
            // Method may not exist yet — non-critical
          }
        }

        log.debug("FSHO mode selection", { R: orderParameter, adjustments: fshoAdj });
      }
    } catch {
      // FSHO computation non-critical
    }

    // 4. Market Intelligence: what the network demands (Plan 8, Phase 7)
    let marketAdj: Partial<Record<DreamMode, number>> = {};
    const hasMarketActivity = this.marketplaceIntelligence?.hasActivity() ?? false;
    if (hasMarketActivity) {
      try {
        marketAdj = this.marketplaceIntelligence!.getDreamModeAdjustments();
        // Inject demand targets into curiosity engine
        this.marketplaceIntelligence!.injectDemandTargets();
      } catch {
        // Marketplace intelligence non-critical
      }
    }

    // Weighted combination with marketplace fallback:
    // When marketplace is active, allocate 20% weight to market demand.
    // When inactive, preserve original 3-signal weights (zero regression).
    const CURIOSITY_W = hasMarketActivity ? 0.25 : 0.30;
    const GCCRF_W =     hasMarketActivity ? 0.25 : 0.30;
    const FSHO_W =      hasMarketActivity ? 0.30 : 0.40;
    const MARKET_W =    hasMarketActivity ? 0.20 : 0.0;

    const adjustedModes = enabledModes.map(([mode, cfg]) => {
      const adj = CURIOSITY_W * (curiosityAdj[mode] ?? 0)
               + GCCRF_W * (gccrfAdj[mode] ?? 0)
               + FSHO_W * (fshoAdj[mode] ?? 0)
               + MARKET_W * (marketAdj[mode] ?? 0);
      return [mode, { ...cfg, weight: Math.max(0, cfg.weight + adj) }] as [DreamMode, DreamModeConfig];
    });

    // Weighted random selection, pick 1-3 modes
    const totalWeight = adjustedModes.reduce((sum, [, cfg]) => sum + cfg.weight, 0);
    const selected: DreamMode[] = [];
    const numModes = Math.min(3, Math.max(1, adjustedModes.length));

    // Check for auto-triggers
    const hasCuriosityTargets = this.countCuriosityTargets() > 0;
    const hasSkillCrystals = this.countSkillCrystals() > 0;

    if (hasCuriosityTargets && this.config.modes.exploration.enabled) {
      selected.push("exploration");
    }
    if (hasSkillCrystals && this.config.modes.mutation.enabled && selected.length < numModes) {
      selected.push("mutation");
    }

    // Hormonal temperature modulation (hormones already fetched for FSHO above)
    const baseTemp = 1.0;
    // Stronger hormonal influence on dream creativity:
    // Dopamine (euphoria) → more creative/exploratory dreams
    // Cortisol (stress) → more focused/replay-oriented dreams
    // Oxytocin (warmth) → slightly more creative, relational exploration
    const hormonalTemp = hormones
      ? baseTemp + (hormones.dopamine * 1.0) - (hormones.cortisol * 0.6) + (hormones.oxytocin * 0.3)
      : baseTemp;
    const temperature = Math.max(0.3, Math.min(2.0, hormonalTemp));

    // Fill remaining slots via temperature-scaled softmax (using curiosity-adjusted weights)
    const remaining = adjustedModes.filter(([mode]) => !selected.includes(mode));
    while (selected.length < numModes && remaining.length > 0) {
      // Softmax with temperature
      const logits = remaining.map(([, cfg]) => cfg.weight / temperature);
      const maxLogit = Math.max(...logits);
      const expWeights = logits.map((l) => Math.exp(l - maxLogit));
      const sumExp = expWeights.reduce((a, b) => a + b, 0);
      const probs = expWeights.map((e) => e / sumExp);

      const rand = Math.random();
      let cumulative = 0;
      for (let i = 0; i < remaining.length; i++) {
        cumulative += probs[i]!;
        if (rand <= cumulative) {
          const picked = remaining[i]![0];
          if (picked === this.lastModeUsed && remaining.length > 1) {
            continue;
          }
          selected.push(picked);
          remaining.splice(i, 1);
          break;
        }
      }
      // Safety fallback
      if (selected.length < numModes && remaining.length > 0 &&
          !selected.includes(remaining[0]![0])) {
        selected.push(remaining.shift()![0]);
      }
    }

    if (selected.length > 0) {
      this.lastModeUsed = selected[selected.length - 1]!;
    }

    return selected;
  }

  /**
   * Compute GCCRF component-based mode weight adjustments.
   * Uses average GCCRF component values from recently scored chunks to
   * influence which dream modes are favored.
   */
  private computeGCCRFModeAdjustments(): Partial<Record<DreamMode, number>> {
    const adj: Partial<Record<DreamMode, number>> = {};

    try {
      // Get average GCCRF component values from recently scored chunks
      // We approximate from the curiosity_reward distribution:
      // - High average reward → the system is finding interesting things
      // We use the chunks table's curiosity_reward as a proxy.
      const recentRow = this.db
        .prepare(
          `SELECT AVG(curiosity_reward) as avg_reward,
                  COUNT(*) as cnt
           FROM chunks
           WHERE curiosity_reward IS NOT NULL
             AND COALESCE(lifecycle_state, 'active') = 'active'
             AND updated_at > ?`,
        )
        .get(Date.now() - 24 * 60 * 60 * 1000) as { avg_reward: number | null; cnt: number } | undefined;

      if (!recentRow || !recentRow.avg_reward || recentRow.cnt < 5) return adj;

      const avgReward = recentRow.avg_reward;

      // Also check the gccrf_state for more detailed component info
      const stateRow = this.db
        .prepare(`SELECT value FROM gccrf_state WHERE key = 'normalizers'`)
        .get() as { value: string } | undefined;

      if (stateRow) {
        const normalizers = JSON.parse(stateRow.value) as Record<string, { mean: number }>;

        // Component means approximate average raw component values
        const etaMean = normalizers.eta?.mean ?? 0.5;
        const deltaEtaMean = normalizers.deltaEta?.mean ?? 0.5;
        const iAlphaMean = normalizers.iAlpha?.mean ?? 0.5;
        const empMean = normalizers.empowerment?.mean ?? 0.5;
        const stratMean = normalizers.strategic?.mean ?? 0.5;

        // Scale adjustments: ±0.15 range based on component dominance
        const SCALE = 0.15;

        // High η → exploration mode (investigate the surprising)
        if (etaMean > 0.6) adj.exploration = (adj.exploration ?? 0) + (etaMean - 0.5) * SCALE;

        // High Δη → compression mode (consolidate what's being learned)
        if (deltaEtaMean > 0.6) adj.compression = (adj.compression ?? 0) + (deltaEtaMean - 0.5) * SCALE;

        // High Iα → simulation mode (cross-domain connections in novel space)
        if (iAlphaMean > 0.6) adj.simulation = (adj.simulation ?? 0) + (iAlphaMean - 0.5) * SCALE;

        // High E → mutation mode (optimize high-agency skills)
        if (empMean > 0.6) adj.mutation = (adj.mutation ?? 0) + (empMean - 0.5) * SCALE;

        // High S → research mode (goal-directed investigation)
        if (stratMean > 0.6) adj.research = (adj.research ?? 0) + (stratMean - 0.5) * SCALE;
      }
    } catch {
      // gccrf_state table may not exist yet
    }

    return adj;
  }

  // ── Mode Dispatcher ──

  private async runMode(
    mode: DreamMode,
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    switch (mode) {
      case "replay":
        return this.runReplayMode(cycleId);
      case "mutation":
        return this.runMutationMode(cycleId);
      case "extrapolation":
        return this.runExtrapolationMode(cycleId);
      case "compression":
        return this.runCompressionMode(cycleId);
      case "simulation":
        return this.runSimulationMode(cycleId);
      case "exploration":
        return this.runExplorationMode(cycleId);
      case "research":
        return this.runResearchMode(cycleId);
      default:
        return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }
  }

  // ── Mode 1: Replay (Ripple-Enhanced — Plan 6, Phase 2) ──

  private async runReplayMode(
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    const maxChunks = this.config.modes.replay.maxChunks;

    // --- Check orphan replay queue first (Phase 7 integration) ---
    let orphanSeeds: ChunkRow[] = [];
    try {
      orphanSeeds = this.db.prepare(
        `SELECT c.id, c.text, c.embedding, c.importance_score, c.access_count,
                COALESCE(c.curiosity_boost, 0.0) as curiosity_boost,
                COALESCE(c.dream_count, 0) as dream_count,
                c.last_dreamed_at, c.emotional_valence
         FROM orphan_replay_queue q
         JOIN chunks c ON c.id = q.chunk_id
         WHERE q.consumed_at IS NULL
         ORDER BY q.cluster_importance DESC
         LIMIT 5`,
      ).all() as ChunkRow[];

      if (orphanSeeds.length > 0) {
        const consumeStmt = this.db.prepare(
          `UPDATE orphan_replay_queue SET consumed_at = ? WHERE chunk_id = ?`,
        );
        for (const seed of orphanSeeds) consumeStmt.run(Date.now(), seed.id);
      }
    } catch {
      // orphan_replay_queue table may not exist yet
    }

    // --- Normal hormonal-weighted seed selection for remaining slots ---
    const remainingSlots = maxChunks - orphanSeeds.length;
    const hormones = this.hormonalStateGetter?.() ?? null;
    const dopBoost = hormones ? hormones.dopamine * 0.3 : 0;
    const cortBoost = hormones ? hormones.cortisol * 0.2 : 0;
    const orderExpr = `(importance_score * (1 + ABS(COALESCE(emotional_valence, 0)))` +
      (dopBoost > 0 ? ` * (1 + ${dopBoost} * CASE WHEN COALESCE(emotional_valence, 0) > 0 THEN 1 ELSE 0 END)` : ``) +
      (cortBoost > 0 ? ` * (1 + ${cortBoost} * CASE WHEN COALESCE(emotional_valence, 0) > 0.3 THEN 1 ELSE 0 END)` : ``) +
      `)`;

    const normalSeeds = remainingSlots > 0 ? this.db.prepare(
      `SELECT id, text, embedding, importance_score, access_count,
              COALESCE(curiosity_boost, 0.0) as curiosity_boost,
              COALESCE(dream_count, 0) as dream_count,
              last_dreamed_at, emotional_valence
       FROM chunks
       WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
              OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
         AND importance_score >= ?
       ORDER BY ${orderExpr} DESC,
                last_accessed_at DESC
       LIMIT ?`,
    ).all(this.config.minImportanceForDream, remainingSlots) as ChunkRow[] : [];

    const seeds = [...orphanSeeds, ...normalSeeds];
    if (seeds.length === 0) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    // Ripple-enhanced replay: Poisson-sampled passes with decaying boost
    const now = Date.now();
    const baseBoost = 0.1;
    const rippleCount = this.sampleRippleCount();
    const decayRate = 0.6;

    // Geometric series: total boost from multiple ripples with habituation
    const totalBoost = baseBoost * (1 - Math.pow(decayRate, rippleCount)) / (1 - decayRate);

    const stmt = this.db.prepare(
      `UPDATE chunks SET
         importance_score = MIN(1.0, importance_score + ?),
         dream_count = COALESCE(dream_count, 0) + 1,
         last_dreamed_at = ?,
         last_ripple_count = ?
       WHERE id = ?`,
    );
    for (const seed of seeds) {
      stmt.run(totalBoost, now, rippleCount, seed.id);
    }

    // Telemetry
    this.recordTelemetry(cycleId, "ripple", "ripple_count", rippleCount);
    this.recordTelemetry(cycleId, "ripple", "total_boost_per_seed", totalBoost);
    this.recordTelemetry(cycleId, "ripple", "orphan_seeds", orphanSeeds.length);

    log.debug("ripple-enhanced replay", {
      seeds: seeds.length,
      orphanSeeds: orphanSeeds.length,
      ripples: rippleCount,
      totalBoostPerSeed: totalBoost.toFixed(3),
    });

    // No new insights from replay — it just strengthens existing memories
    return { insights: [], llmCalls: 0, chunksAnalyzed: seeds.length };
  }

  /**
   * Sample number of ripple events from Poisson distribution.
   * λ=3 (average 3 ripples per replay), clamped to [1, 7].
   * Uses Knuth's algorithm (efficient for small λ).
   */
  private sampleRippleCount(): number {
    const lambda = 3;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return Math.max(1, Math.min(7, k - 1));
  }

  // ── Mode 2: Mutation ──

  private async runMutationMode(
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    const llmCall = this.getLlmCallForMode("mutation");
    if (!llmCall) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    const maxChunks = this.config.modes.mutation.maxChunks;
    // Select skill crystals and high-importance task patterns
    const seeds = this.db
      .prepare(
        `SELECT id, text, embedding, importance_score, access_count,
                COALESCE(curiosity_boost, 0.0) as curiosity_boost,
                COALESCE(dream_count, 0) as dream_count,
                last_dreamed_at, emotional_valence, semantic_type, memory_type
         FROM chunks
         WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
           AND (COALESCE(memory_type, 'plaintext') = 'skill'
                OR COALESCE(semantic_type, 'general') IN ('skill', 'task_pattern'))
         ORDER BY importance_score DESC
         LIMIT ?`,
      )
      .all(maxChunks) as ChunkRow[];

    if (seeds.length === 0) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    const insights: DreamInsight[] = [];
    let llmCalls = 0;

    // Phase 7: Process up to 5 skills per cycle with strategy-based mutation
    const maxPerCycle = Math.min(seeds.length, 5);
    for (const seed of seeds.slice(0, maxPerCycle)) {
      if (llmCalls >= this.config.maxLlmCallsPerCycle) break;

      // Select strategy based on execution metrics (if available)
      const relatedCount = this.countRelatedSkills(seed.id, seed.semantic_type);
      const strategy = selectStrategy(
        { text: seed.text, skillCategory: seed.semantic_type },
        null, // execution metrics would come from tracker integration
        relatedCount,
      );

      // Build context for strategy-specific prompt
      const relatedSkills = relatedCount > 0 ? this.getRelatedSkills(seed.id, seed.semantic_type, 2) : [];
      const prompt = buildStrategyPrompt(strategy, seed.text, { relatedSkills });

      try {
        const raw = await llmCall(prompt);
        llmCalls++;
        const results = parseDreamSynthesisResponse(raw);
        const now = Date.now();

        for (const result of results) {
          insights.push({
            id: crypto.randomUUID(),
            content: result.content,
            embedding: [],
            confidence: result.confidence,
            mode: "mutation",
            sourceChunkIds: [seed.id],
            sourceClusterIds: [],
            dreamCycleId: cycleId,
            importanceScore: Math.min(1, result.confidence * seed.importance_score),
            accessCount: 0,
            lastAccessedAt: null,
            createdAt: now,
            updatedAt: now,
          });
        }

        // Phase 7: Queue promising-but-not-promoted mutations for retry
        for (const result of results) {
          if (result.confidence >= 0.4 && result.confidence < 0.7) {
            this.queueForRetry(seed.id, strategy);
          }
        }
      } catch (err) {
        log.debug(`mutation LLM call failed: ${String(err)}`);
      }
    }

    this.markChunksDreamed(seeds.map((s) => s.id));
    return { insights, llmCalls, chunksAnalyzed: seeds.length };
  }

  // ── Mode 3: Extrapolation ──

  private async runExtrapolationMode(
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    const llmCall = this.getLlmCallForMode("extrapolation");
    if (!llmCall) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    const maxChunks = this.config.modes.extrapolation.maxChunks;
    // Select user preferences, task patterns, and recent episodes
    const seeds = this.db
      .prepare(
        `SELECT id, text, embedding, importance_score, access_count,
                COALESCE(curiosity_boost, 0.0) as curiosity_boost,
                COALESCE(dream_count, 0) as dream_count,
                last_dreamed_at, emotional_valence, semantic_type
         FROM chunks
         WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
           AND COALESCE(semantic_type, 'general') IN ('preference', 'task_pattern', 'episode', 'goal')
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(maxChunks) as ChunkRow[];

    if (seeds.length < 3) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    const texts = seeds.map((s) => s.text.slice(0, 500)).join("\n---\n");
    const prompt =
      `You are a Dream Engine predicting future user needs. Based on these recent ` +
      `patterns, preferences, and episodes, identify 2-3 predictive patterns — ` +
      `what is the user likely to need or do next?\n\n` +
      `${texts}\n\n` +
      `Respond with a JSON array of objects, each with:\n` +
      `- "content": a predictive insight (1-3 sentences)\n` +
      `- "confidence": float 0-1 indicating prediction strength\n` +
      `- "keywords": array of 2-5 relevant keywords\n\n` +
      `Respond ONLY with the JSON array.`;

    try {
      const raw = await llmCall(prompt);
      const results = parseDreamSynthesisResponse(raw);
      const now = Date.now();
      const insights = results.map((result) => ({
        id: crypto.randomUUID(),
        content: result.content,
        embedding: [] as number[],
        confidence: result.confidence,
        mode: "extrapolation" as const,
        sourceChunkIds: seeds.map((s) => s.id),
        sourceClusterIds: [],
        dreamCycleId: cycleId,
        importanceScore: Math.min(1, result.confidence * 0.7),
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: now,
        updatedAt: now,
      }));

      this.markChunksDreamed(seeds.map((s) => s.id));
      return { insights, llmCalls: 1, chunksAnalyzed: seeds.length };
    } catch (err) {
      log.debug(`extrapolation LLM call failed: ${String(err)}`);
      return { insights: [], llmCalls: 1, chunksAnalyzed: seeds.length };
    }
  }

  // ── Mode 4: Compression ──

  private async runCompressionMode(
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    const maxChunks = this.config.modes.compression.maxChunks;

    // Consume SNN near-merge hints (Plan 6, Phase 3 integration)
    let hintChunkIds: string[] = [];
    try {
      const hints = this.db.prepare(
        `SELECT chunk_id_a, chunk_id_b FROM near_merge_hints
         WHERE consumed_at IS NULL
         ORDER BY snn_similarity DESC LIMIT 10`,
      ).all() as Array<{ chunk_id_a: string; chunk_id_b: string }>;

      if (hints.length > 0) {
        const consumeStmt = this.db.prepare(
          `UPDATE near_merge_hints SET consumed_at = ? WHERE chunk_id_a = ? AND chunk_id_b = ?`,
        );
        const now = Date.now();
        for (const h of hints) {
          consumeStmt.run(now, h.chunk_id_a, h.chunk_id_b);
          hintChunkIds.push(h.chunk_id_a, h.chunk_id_b);
        }
        hintChunkIds = [...new Set(hintChunkIds)]; // Deduplicate
        this.recordTelemetry(cycleId, "snn_merge", "hints_consumed", hints.length);
      }
    } catch {
      // near_merge_hints table may not exist yet
    }

    const seeds = this.selectSeeds(maxChunks, hintChunkIds);

    if (seeds.length < 6) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    // Cluster with tighter threshold (0.85) to find dense groups
    const clusters = this.clusterChunks(seeds, 0.85);
    // Only compress clusters with 3+ members
    const denseClusters = clusters.filter((c) => c.chunkIds.length >= 3);

    if (denseClusters.length === 0) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: seeds.length };
    }

    const chunkTexts = new Map<string, string>();
    for (const seed of seeds) {
      chunkTexts.set(seed.id, seed.text);
    }

    // Heuristic compression (no LLM needed)
    const heuristic = heuristicSynthesize(denseClusters, chunkTexts);
    const now = Date.now();
    const insights: DreamInsight[] = [];

    for (let i = 0; i < denseClusters.length; i++) {
      const cluster = denseClusters[i]!;
      const result = heuristic[i];
      if (!result) continue;

      insights.push({
        id: crypto.randomUUID(),
        content: result.content,
        embedding: [],
        confidence: result.confidence,
        mode: "compression",
        sourceChunkIds: cluster.chunkIds,
        sourceClusterIds: [cluster.id],
        dreamCycleId: cycleId,
        importanceScore: Math.min(1, result.confidence * cluster.meanImportance),
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      // Archive or consolidate source chunks based on compression confidence.
      // High-confidence compressions (>= 0.7): archive sources (not searchable).
      // Lower-confidence: consolidate sources (still searchable as fallback).
      const insightId = insights[insights.length - 1]!.id;
      if (result.confidence >= 0.7) {
        const archiveStmt = this.db.prepare(
          `UPDATE chunks SET lifecycle = 'archived', lifecycle_state = 'archived',
                  parent_id = ?, version = COALESCE(version, 1) + 1
           WHERE id = ?`,
        );
        for (const chunkId of cluster.chunkIds) {
          archiveStmt.run(insightId, chunkId);
        }
      } else {
        const consolidateStmt = this.db.prepare(
          `UPDATE chunks SET lifecycle = 'consolidated', lifecycle_state = 'consolidated',
                  parent_id = ?, version = COALESCE(version, 1) + 1
           WHERE id = ?`,
        );
        for (const chunkId of cluster.chunkIds) {
          consolidateStmt.run(insightId, chunkId);
        }
      }
    }

    this.markChunksDreamed(seeds.map((s) => s.id));
    return { insights, llmCalls: 0, chunksAnalyzed: seeds.length };
  }

  // ── Mode 5: Simulation ──

  private async runSimulationMode(
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    const llmCall = this.getLlmCallForMode("simulation");
    if (!llmCall) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    // Pick 2-3 crystals from different knowledge regions (cross-domain)
    const seeds = this.db
      .prepare(
        `SELECT id, text, embedding, importance_score, access_count,
                COALESCE(curiosity_boost, 0.0) as curiosity_boost,
                COALESCE(dream_count, 0) as dream_count,
                last_dreamed_at, emotional_valence, semantic_type
         FROM chunks
         WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
           AND importance_score >= ?
         ORDER BY RANDOM()
         LIMIT 20`,
      )
      .all(this.config.minImportanceForDream) as ChunkRow[];

    if (seeds.length < 3) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    // Pick 3 chunks that are maximally different from each other
    const crossDomain = this.pickDiverseChunks(seeds, 3);
    if (crossDomain.length < 2) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    const texts = crossDomain.map((s) => s.text.slice(0, 600));
    const prompt =
      `You are a Dream Engine finding cross-domain connections. These pieces of ` +
      `knowledge are from different domains. What non-obvious connections or ` +
      `applications exist between them? Generate a novel insight.\n\n` +
      texts.map((t, i) => `Domain ${i + 1}:\n${t}`).join("\n\n---\n\n") +
      `\n\nRespond with a JSON array of objects, each with:\n` +
      `- "content": a cross-domain insight (1-3 sentences)\n` +
      `- "confidence": float 0-1 indicating how strong the connection is\n` +
      `- "keywords": array of 2-5 relevant keywords\n\n` +
      `Respond ONLY with the JSON array.`;

    try {
      const raw = await llmCall(prompt);
      const results = parseDreamSynthesisResponse(raw);
      const now = Date.now();
      const insights = results.map((result) => ({
        id: crypto.randomUUID(),
        content: result.content,
        embedding: [] as number[],
        confidence: result.confidence,
        mode: "simulation" as const,
        sourceChunkIds: crossDomain.map((s) => s.id),
        sourceClusterIds: [],
        dreamCycleId: cycleId,
        importanceScore: Math.min(1, result.confidence * 0.8),
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: now,
        updatedAt: now,
      }));

      this.markChunksDreamed(crossDomain.map((s) => s.id));
      return { insights, llmCalls: 1, chunksAnalyzed: crossDomain.length };
    } catch (err) {
      log.debug(`simulation LLM call failed: ${String(err)}`);
      return { insights: [], llmCalls: 1, chunksAnalyzed: crossDomain.length };
    }
  }

  // ── Mode 6: Exploration ──

  private async runExplorationMode(
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    const llmCall = this.getLlmCallForMode("exploration");
    if (!llmCall) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    // Query curiosity targets for unresolved gaps
    const targets = this.db
      .prepare(
        `SELECT id, type, description, priority, region_id, metadata
         FROM curiosity_targets
         WHERE resolved_at IS NULL AND expires_at > ?
         ORDER BY priority DESC
         LIMIT 3`,
      )
      .all(Date.now()) as Array<{
        id: string;
        type: string;
        description: string;
        priority: number;
        region_id: string | null;
        metadata: string;
      }>;

    if (targets.length === 0) {
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    // For each target, find nearest existing crystals
    const targetDescriptions = targets.map((t) => t.description).join("\n---\n");
    const maxChunks = this.config.modes.exploration.maxChunks;
    const nearbyChunks = this.db
      .prepare(
        `SELECT id, text, embedding, importance_score, access_count,
                COALESCE(curiosity_boost, 0.0) as curiosity_boost,
                COALESCE(dream_count, 0) as dream_count,
                last_dreamed_at, emotional_valence
         FROM chunks
         WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
         ORDER BY importance_score DESC
         LIMIT ?`,
      )
      .all(maxChunks) as ChunkRow[];

    const contextTexts = nearbyChunks.slice(0, 5).map((c) => c.text.slice(0, 300));
    const prompt =
      `You are a Dream Engine exploring knowledge gaps. We have identified these gaps:\n\n` +
      `${targetDescriptions}\n\n` +
      `Based on what we know about related topics:\n${contextTexts.join("\n---\n")}\n\n` +
      `What questions should we investigate? What knowledge would fill these gaps? ` +
      `Generate exploration strategies.\n\n` +
      `Respond with a JSON array of objects, each with:\n` +
      `- "content": an exploration strategy or question (1-3 sentences)\n` +
      `- "confidence": float 0-1 indicating how useful this exploration would be\n` +
      `- "keywords": array of 2-5 relevant keywords\n\n` +
      `Respond ONLY with the JSON array.`;

    try {
      const raw = await llmCall(prompt);
      const results = parseDreamSynthesisResponse(raw);
      const now = Date.now();
      const insights = results.map((result) => ({
        id: crypto.randomUUID(),
        content: result.content,
        embedding: [] as number[],
        confidence: result.confidence,
        mode: "exploration" as const,
        sourceChunkIds: nearbyChunks.slice(0, 5).map((c) => c.id),
        sourceClusterIds: [],
        dreamCycleId: cycleId,
        importanceScore: Math.min(1, result.confidence * 0.6),
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: now,
        updatedAt: now,
      }));

      // Mark targets as explored (but not resolved — needs real new knowledge)
      for (const target of targets) {
        try {
          this.db.prepare(
            `UPDATE curiosity_targets SET metadata = json_set(COALESCE(metadata, '{}'), '$.explored', 1) WHERE id = ?`,
          ).run(target.id);
        } catch {
          // json_set may not be available; skip gracefully
        }
      }

      return { insights, llmCalls: 1, chunksAnalyzed: nearbyChunks.length };
    } catch (err) {
      log.debug(`exploration LLM call failed: ${String(err)}`);
      return { insights: [], llmCalls: 1, chunksAnalyzed: nearbyChunks.length };
    }
  }

  // ── Mode 7: Research ──

  private async runResearchMode(
    cycleId: string,
  ): Promise<{ insights: DreamInsight[]; llmCalls: number; chunksAnalyzed: number }> {
    // Research mode requires both LLM and execution tracker
    const llmCall = this.getLlmCallForMode("research");
    if (!llmCall) {
      log.debug("research mode skipped: no LLM available");
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }
    if (!this.executionTracker) {
      log.debug("research mode skipped: no execution tracker wired");
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    const maxChunks = this.config.modes.research.maxChunks;
    const experiment = new PromptOptimizationExperiment(this.db, this.executionTracker);
    const candidates = experiment.findCandidates(maxChunks);

    if (candidates.length === 0) {
      log.debug("research mode: no candidates with sufficient execution data");
      return { insights: [], llmCalls: 0, chunksAnalyzed: 0 };
    }

    const sandbox = new ExperimentSandbox(this.db, llmCall);
    const insights: DreamInsight[] = [];
    let llmCalls = 0;

    for (const candidate of candidates) {
      if (llmCalls >= this.config.maxLlmCallsPerCycle) break;

      try {
        const results = await experiment.optimize(candidate, llmCall);
        llmCalls++;
        const now = Date.now();

        for (const result of results) {
          // Confidence incorporates both LLM confidence and opportunity score
          const adjustedConfidence = result.confidence * (0.7 + 0.3 * result.opportunityScore);

          const insight: DreamInsight = {
            id: crypto.randomUUID(),
            content: result.content,
            embedding: [],
            confidence: Math.min(1, adjustedConfidence),
            mode: "research",
            sourceChunkIds: [candidate.skill.id],
            sourceClusterIds: [],
            dreamCycleId: cycleId,
            importanceScore: Math.min(
              1,
              adjustedConfidence * candidate.skill.importance_score,
            ),
            accessCount: 0,
            lastAccessedAt: null,
            createdAt: now,
            updatedAt: now,
          };

          // Sandbox evaluation: A/B test the mutation against the original
          try {
            const verdict = await sandbox.evaluate(
              {
                id: candidate.skill.id,
                text: candidate.skill.text,
                skill_category: candidate.skill.skill_category,
                importance_score: candidate.skill.importance_score,
              },
              result.content,
            );
            // Count sandbox LLM calls toward budget
            llmCalls += verdict.testCasesRun;

            if (verdict.accepted && verdict.confidence >= 0.6) {
              // Promote the mutation (git advance)
              this.promoteSkillMutation(candidate.skill.id, result.content, verdict, result.strategy ?? undefined);
              log.debug("mutation promoted", {
                skillId: candidate.skill.id,
                delta: verdict.delta.toFixed(3),
                confidence: verdict.confidence.toFixed(2),
              });
            } else {
              // Archive the mutation (git reset)
              this.archiveMutationResult(candidate.skill.id, result.content, verdict);
            }
          } catch (sandboxErr) {
            log.debug(`sandbox evaluation failed: ${String(sandboxErr)}`);
          }

          insights.push(insight);
        }

        log.debug("research experiment completed", {
          skillId: candidate.skill.id,
          strategy: results[0]?.strategy ?? "unknown",
          baselineSuccessRate: candidate.metrics.successRate,
          mutationsGenerated: results.length,
        });
      } catch (err) {
        log.debug(`research LLM call failed: ${String(err)}`);
      }
    }

    this.markChunksDreamed(candidates.map((c) => c.skill.id));
    return { insights, llmCalls, chunksAnalyzed: candidates.length };
  }

  /**
   * Promote a skill mutation: update the skill crystal with mutated text,
   * bump version, record provenance, and trigger dopamine spike.
   * This is the `git advance` equivalent in the Karpathy pattern.
   */
  private promoteSkillMutation(
    skillId: string,
    mutatedText: string,
    verdict: MutationVerdict,
    strategy?: string,
  ): void {
    const now = Date.now();
    try {
      // Get current version info
      const row = this.db
        .prepare(`SELECT skill_version, governance_json, importance_score FROM chunks WHERE id = ?`)
        .get(skillId) as {
          skill_version: number | null;
          governance_json: string | null;
          importance_score: number;
        } | undefined;

      if (!row) return;

      const newVersion = (row.skill_version ?? 1) + 1;

      // Update governance with promotion provenance
      let governance: Record<string, unknown> = {};
      try {
        governance = row.governance_json ? JSON.parse(row.governance_json) : {};
      } catch { /* empty */ }
      governance.lastMutationPromotion = {
        strategy: strategy ?? "unknown",
        delta: verdict.delta,
        testCases: verdict.testCasesRun,
        timestamp: now,
        originalScore: verdict.originalScore,
        mutatedScore: verdict.mutatedScore,
      };

      // Boost importance proportional to delta
      const boostedImportance = Math.min(1, row.importance_score + verdict.delta * 0.2);

      // Update the skill crystal
      this.db
        .prepare(
          `UPDATE chunks SET
             text = ?,
             skill_version = ?,
             importance_score = ?,
             governance_json = ?,
             updated_at = ?,
             version = COALESCE(version, 1) + 1
           WHERE id = ?`,
        )
        .run(mutatedText, newVersion, boostedImportance, JSON.stringify(governance), now, skillId);

      // Audit log
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          skillId,
          "skill_mutation_promoted",
          now,
          "dream_engine/research",
          JSON.stringify({
            strategy,
            delta: verdict.delta,
            confidence: verdict.confidence,
            testCasesRun: verdict.testCasesRun,
            originalScore: verdict.originalScore,
            mutatedScore: verdict.mutatedScore,
            newVersion,
          }),
        );

      // Dopamine spike for successful mutation
      this.hormonalManager?.stimulate("achievement");
    } catch (err) {
      log.debug(`promoteSkillMutation failed: ${String(err)}`);
    }
  }

  /**
   * Archive a rejected mutation with its verdict.
   * This is the `git reset` equivalent in the Karpathy pattern.
   */
  private archiveMutationResult(
    skillId: string,
    mutatedText: string,
    verdict: MutationVerdict,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          skillId,
          "skill_mutation_archived",
          Date.now(),
          "dream_engine/research",
          JSON.stringify({
            delta: verdict.delta,
            confidence: verdict.confidence,
            testCasesRun: verdict.testCasesRun,
            originalScore: verdict.originalScore,
            mutatedScore: verdict.mutatedScore,
            reason: verdict.accepted ? "low_confidence" : "negative_delta",
            mutationPreview: mutatedText.slice(0, 200),
          }),
        );
    } catch (err) {
      log.debug(`archiveMutationResult failed: ${String(err)}`);
    }
  }

  // ── Shared helpers ──

  private selectSeeds(limit?: number, priorityIds?: string[]): ChunkRow[] {
    const maxChunks = limit ?? this.config.maxChunksPerCycle;

    // If SNN hints provided priority chunk IDs, fetch them first
    let prioritySeeds: ChunkRow[] = [];
    if (priorityIds && priorityIds.length > 0) {
      try {
        const placeholders = priorityIds.map(() => "?").join(",");
        prioritySeeds = this.db.prepare(
          `SELECT id, text, embedding, importance_score, access_count,
                  COALESCE(curiosity_boost, 0.0) as curiosity_boost,
                  COALESCE(dream_count, 0) as dream_count,
                  last_dreamed_at, emotional_valence
           FROM chunks WHERE id IN (${placeholders})`,
        ).all(...priorityIds) as ChunkRow[];
      } catch {
        // Non-critical
      }
    }

    const remaining = maxChunks - prioritySeeds.length;
    // GCCRF-informed seed selection: use curiosity_reward (from GCCRF) when available,
    // fall back to curiosity_boost (from old heuristic engine) for backwards compatibility.
    // Dream count penalty: / (dream_count + 1) deprioritizes previously-dreamed chunks.
    const normalSeeds = remaining > 0 ? this.db
      .prepare(
        `SELECT id, text, embedding, importance_score, access_count,
                COALESCE(curiosity_boost, 0.0) as curiosity_boost,
                COALESCE(dream_count, 0) as dream_count,
                last_dreamed_at, emotional_valence
         FROM chunks
         WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
           AND COALESCE(memory_type, 'plaintext') != 'skill'
           AND importance_score >= ?
         ORDER BY (importance_score + COALESCE(curiosity_reward, curiosity_boost, 0.0))
                  / (COALESCE(dream_count, 0) + 1) DESC
         LIMIT ?`,
      )
      .all(this.config.minImportanceForDream, remaining) as ChunkRow[] : [];

    // Merge, deduplicate
    const seen = new Set<string>();
    const result: ChunkRow[] = [];
    for (const seed of [...prioritySeeds, ...normalSeeds]) {
      if (!seen.has(seed.id)) {
        seen.add(seed.id);
        result.push(seed);
      }
    }
    return result;
  }

  private clusterChunks(seeds: ChunkRow[], threshold?: number): DreamCluster[] {
    const embeddings = new Map<string, number[]>();
    const seedMap = new Map<string, ChunkRow>();
    for (const seed of seeds) {
      seedMap.set(seed.id, seed);
      const emb = parseEmbedding(seed.embedding);
      if (emb.length > 0) {
        embeddings.set(seed.id, emb);
      }
    }

    const assigned = new Set<string>();
    const clusters: DreamCluster[] = [];
    const th = threshold ?? this.config.clusterSimilarityThreshold;

    for (const seed of seeds) {
      if (assigned.has(seed.id)) continue;
      const embA = embeddings.get(seed.id);
      if (!embA) continue;

      const cluster: string[] = [seed.id];
      assigned.add(seed.id);

      for (const other of seeds) {
        if (assigned.has(other.id)) continue;
        const embB = embeddings.get(other.id);
        if (!embB) continue;

        if (cosineSimilarity(embA, embB) >= th) {
          cluster.push(other.id);
          assigned.add(other.id);
        }
      }

      if (cluster.length < 2) continue;

      const centroid = computeCentroid(
        cluster.map((id) => embeddings.get(id)!).filter(Boolean),
      );
      const keywords = this.extractKeywords(
        cluster.map((id) => seedMap.get(id)?.text ?? ""),
      );
      const meanImportance =
        cluster.reduce(
          (sum, id) => sum + (seedMap.get(id)?.importance_score ?? 0),
          0,
        ) / cluster.length;

      const mode = CREATIVITY_MODES[clusters.length % CREATIVITY_MODES.length]!;

      clusters.push({
        id: crypto.randomUUID(),
        chunkIds: cluster,
        centroid,
        mode,
        meanImportance,
        keywords,
      });
    }

    return clusters;
  }

  private pickDiverseChunks(chunks: ChunkRow[], count: number): ChunkRow[] {
    if (chunks.length <= count) return chunks;

    const embeddings = new Map<string, number[]>();
    for (const chunk of chunks) {
      const emb = parseEmbedding(chunk.embedding);
      if (emb.length > 0) embeddings.set(chunk.id, emb);
    }

    const withEmb = chunks.filter((c) => embeddings.has(c.id));
    if (withEmb.length <= count) return withEmb;

    // Greedy farthest-point sampling
    const selected: ChunkRow[] = [withEmb[0]!];
    const used = new Set([withEmb[0]!.id]);

    while (selected.length < count) {
      let bestChunk: ChunkRow | null = null;
      let bestMinDist = -1;

      for (const candidate of withEmb) {
        if (used.has(candidate.id)) continue;
        const candEmb = embeddings.get(candidate.id)!;
        let minDist = Infinity;
        for (const sel of selected) {
          const selEmb = embeddings.get(sel.id)!;
          const dist = 1 - cosineSimilarity(candEmb, selEmb);
          if (dist < minDist) minDist = dist;
        }
        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestChunk = candidate;
        }
      }

      if (!bestChunk) break;
      selected.push(bestChunk);
      used.add(bestChunk.id);
    }

    return selected;
  }

  private extractKeywords(texts: string[]): string[] {
    const freq = new Map<string, number>();
    for (const text of texts) {
      const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const seen = new Set<string>();
      for (const word of words) {
        if (!seen.has(word)) {
          seen.add(word);
          freq.set(word, (freq.get(word) ?? 0) + 1);
        }
      }
    }
    return [...freq.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  private countCuriosityTargets(): number {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) as c FROM curiosity_targets WHERE resolved_at IS NULL AND expires_at > ?`)
        .get(Date.now()) as { c: number };
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  private countSkillCrystals(): number {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as c FROM chunks
           WHERE (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')
             AND (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                  OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))`,
        )
        .get() as { c: number };
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  private storeInsights(insights: DreamInsight[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO dream_insights (id, content, embedding, confidence, mode,
        source_chunk_ids, source_cluster_ids, dream_cycle_id, importance_score,
        access_count, last_accessed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const insight of insights) {
      stmt.run(
        insight.id,
        insight.content,
        JSON.stringify(insight.embedding),
        insight.confidence,
        insight.mode,
        JSON.stringify(insight.sourceChunkIds),
        JSON.stringify(insight.sourceClusterIds),
        insight.dreamCycleId,
        insight.importanceScore,
        insight.accessCount,
        insight.lastAccessedAt,
        insight.createdAt,
        insight.updatedAt,
      );
    }
  }

  /** Convenience wrapper for dream telemetry recording. */
  private recordTelemetry(cycleId: string, phase: string, metric: string, value: number): void {
    recordDreamTelemetry(this.db, cycleId, phase, metric, value);
  }

  private markChunksDreamed(ids: string[]): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE chunks SET dream_count = COALESCE(dream_count, 0) + 1, last_dreamed_at = ? WHERE id = ?`,
    );
    for (const id of ids) {
      stmt.run(now, id);
    }
  }

  private pruneInsights(): void {
    const max = this.config.maxInsights;
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM dream_insights`).get() as {
      c: number;
    };
    if (row.c <= max) return;

    const excess = row.c - max;
    this.db
      .prepare(
        `DELETE FROM dream_insights WHERE id IN (
          SELECT id FROM dream_insights
          ORDER BY importance_score ASC, created_at ASC
          LIMIT ?
        )`,
      )
      .run(excess);
  }

  // ── Phase 7: Strategy helpers ──

  private countRelatedSkills(skillId: string, semanticType?: string | null): number {
    if (!semanticType) return 0;
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as c FROM chunks
           WHERE id != ? AND COALESCE(semantic_type, 'general') = ?
             AND (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')
             AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')`,
        )
        .get(skillId, semanticType) as { c: number };
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  private getRelatedSkills(skillId: string, semanticType: string | null | undefined, limit: number): Array<{ text: string; id: string }> {
    if (!semanticType) return [];
    try {
      return this.db
        .prepare(
          `SELECT id, text FROM chunks
           WHERE id != ? AND COALESCE(semantic_type, 'general') = ?
             AND (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')
             AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
           ORDER BY importance_score DESC
           LIMIT ?`,
        )
        .all(skillId, semanticType, limit) as Array<{ text: string; id: string }>;
    } catch {
      return [];
    }
  }

  private queueForRetry(skillCrystalId: string, strategy: string): void {
    try {
      // Check if already queued
      const existing = this.db
        .prepare(
          `SELECT id FROM mutation_queue WHERE skill_crystal_id = ? AND attempts < max_attempts`,
        )
        .get(skillCrystalId);
      if (existing) return;

      this.db
        .prepare(
          `INSERT INTO mutation_queue (id, skill_crystal_id, strategy, priority, created_at)
           VALUES (?, ?, ?, 0.5, ?)`,
        )
        .run(crypto.randomUUID(), skillCrystalId, strategy, Date.now());
    } catch {
      // mutation_queue table may not exist yet
    }
  }

  private recordCycle(meta: DreamCycleMetadata): void {
    this.db
      .prepare(
        `INSERT INTO dream_cycles (cycle_id, started_at, completed_at, duration_ms, state,
          clusters_processed, insights_generated, chunks_analyzed, llm_calls_used, error, modes_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.cycleId,
        meta.startedAt,
        meta.completedAt,
        meta.durationMs,
        meta.state,
        meta.clustersProcessed,
        meta.insightsGenerated,
        meta.chunksAnalyzed,
        meta.llmCallsUsed,
        meta.error,
        JSON.stringify(meta.modesUsed ?? []),
      );
  }

  private completeCycle(meta: DreamCycleMetadata, error: string | null): void {
    const now = Date.now();
    meta.completedAt = now;
    meta.durationMs = now - meta.startedAt;
    meta.state = "DORMANT";
    meta.error = error;
    this.state = "DORMANT";

    this.db
      .prepare(
        `UPDATE dream_cycles
         SET completed_at = ?, duration_ms = ?, state = ?,
             clusters_processed = ?, insights_generated = ?,
             chunks_analyzed = ?, llm_calls_used = ?, error = ?,
             modes_used = ?
         WHERE cycle_id = ?`,
      )
      .run(
        meta.completedAt,
        meta.durationMs,
        meta.state,
        meta.clustersProcessed,
        meta.insightsGenerated,
        meta.chunksAnalyzed,
        meta.llmCallsUsed,
        meta.error,
        JSON.stringify(meta.modesUsed ?? []),
        meta.cycleId,
      );
  }
}

/**
 * Create the default synthesize function that uses the Dream Engine's
 * built-in prompt template. This is the implementation wired in when
 * synthesisMode is "llm" or "both".
 */
export function createDefaultSynthesizeFn(
  llmCall: (prompt: string) => Promise<string>,
): SynthesizeFn {
  return async (clusters, chunkTexts) => {
    const prompt = buildDreamSynthesisPrompt(clusters, chunkTexts);
    const raw = await llmCall(prompt);
    return parseDreamSynthesisResponse(raw);
  };
}
