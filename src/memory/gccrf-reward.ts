/**
 * Geodesic Crystal-Field Curiosity Reward Function (GCCRF)
 *
 * A five-component intrinsic curiosity reward function that combines:
 * 1. Prediction Error (η) — surprise relative to known knowledge regions
 * 2. Learning Progress (Δη) — per-region improvement in prediction accuracy
 * 3. Information-Theoretic Novelty (Iα) — density-based novelty with developmental annealing
 * 4. Empowerment (E·μ) — knowledge agency gated by uncertainty
 * 5. Strategic Alignment (S) — goal-directed exploration
 *
 * Based on the GCCRF theory paper (research/04 - GCCRF_Curiosity_Function.md).
 * Translated from PyTorch/RL latent spaces to text embedding spaces.
 *
 * Total reward: R_i = w1·η_n + w2·Δη_n + w3·I_α_n + w4·(E_n · μ_t) + w5·S_n
 * All components normalized to [0,1] via running EMA normalizers.
 * Final reward is tanh-squashed to [0,1].
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  type GCCRFState,
  saveGCCRFState,
  loadGCCRFState,
  ensureGCCRFSchema,
  GCCRF_SCORING_VERSION,
} from "./gccrf-state.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

const log = createSubsystemLogger("memory/gccrf");

// ── Configuration ──

export interface GCCRFConfig {
  /** Component weights [w1..w5]. Default: [0.25, 0.25, 0.25, 0.20, 0.05] */
  weights: [number, number, number, number, number];
  /** Alpha schedule start (young agent). Default: -3.0 */
  alphaStart: number;
  /** Alpha schedule end (mature agent). Default: 0.0 */
  alphaEnd: number;
  /** Dream cycles expected for full maturity. Default: 100 */
  expectedMatureCycles: number;
  /** K neighbors for KDE density estimation. Default: 50 */
  kdeK: number;
  /** K neighbors for empowerment computation. Default: 30 */
  empowermentK: number;
  /** EMA decay rate for normalizers. Default: 0.05 */
  etaEmaAlpha: number;
  /** Window size for mu_t (interoceptive modulator) variability. Default: 20 */
  etaWindowSize: number;
  /** Gain for mu_t sigmoid. Default: 5.0 */
  muGain: number;
  /** Threshold for mu_t sigmoid. Default: 0.3 */
  muThreshold: number;
  /**
   * RBF bandwidth for KDE density, applied to raw cosine distances and shared
   * by every query. Default: 0.3. A per-query min/max stretch (the previous
   * behaviour) made every neighbourhood look identical, so a chunk sitting on
   * top of 50 near-duplicates scored the same density as one 0.7 away from
   * everything.
   */
  densityBandwidth: number;
  /**
   * Let the FSHO order parameter modulate the alpha schedule
   * (`getFshoCoupledAlpha`). Default: false. Set via
   * `memory.curiosity.fshoCoupling`; off, novelty uses the pure maturity
   * schedule and FSHO R is tracked for telemetry only.
   */
  fshoCoupling: boolean;
}

export const DEFAULT_GCCRF_CONFIG: GCCRFConfig = {
  // [η, Δη, Iα, E, S] — Strategic alignment (S) raised from 0.05 to 0.10
  // for personal assistant use: goal-directedness matters more than pure novelty.
  // Δη reduced slightly (0.25→0.20) to compensate.
  weights: [0.25, 0.2, 0.25, 0.2, 0.1],
  alphaStart: -3.0,
  alphaEnd: 0.0,
  expectedMatureCycles: 100,
  kdeK: 50,
  empowermentK: 30,
  etaEmaAlpha: 0.05,
  etaWindowSize: 20,
  muGain: 5.0,
  muThreshold: 0.3,
  densityBandwidth: 0.3,
  fshoCoupling: false,
};

/** Scoring context for one chunk: lets KNN exclude the chunk itself. */
export type GCCRFComputeContext = {
  /** The id of the chunk being scored, when it is already in `chunks`/`chunks_vec`. */
  chunkId?: string;
};

/**
 * Extra rows requested from the vector index beyond k: the assessed chunk is
 * its own nearest neighbour (distance 0) and the index can still hold rows
 * for chunks that were archived or deleted since. Filtered after the MATCH.
 */
const KNN_OVERFETCH = 8;
const KNN_MAX_ROUNDS = 3;

/** |α + 1| below this uses the -log p limit of I_α (prefactor instability). */
const ALPHA_LOG_LIMIT_WINDOW = 1e-3;

// ── Result Types ──

export interface GCCRFRewardResult {
  /** Final squashed reward in [0, 1] */
  reward: number;
  /** Individual component values (normalized) */
  components: {
    eta: number;
    deltaEta: number;
    iAlpha: number;
    empowerment: number;
    strategic: number;
  };
  /** Raw (pre-normalization) component values for diagnostics */
  rawComponents: {
    eta: number;
    deltaEta: number;
    iAlpha: number;
    empowerment: number;
    strategic: number;
  };
  /** Current alpha schedule value */
  alpha: number;
  /** Raw KDE density for diagnostics */
  density: number;
  /** Nearest knowledge region ID */
  regionId: string | null;
  /** Agent maturity ratio [0, 1] */
  maturity: number;
}

// ── Running EMA Normalizer ──
// Port of RunningEMANorm from the GCCRF theory paper.
// Tracks running mean/variance per component. Normalizes raw values to ~[0,1].
// Variance floor of 0.05 prevents blowup when a component stagnates.

class RunningEMANormalizer {
  mean: number;
  variance: number;
  count: number;
  private readonly alpha: number;
  private static readonly VARIANCE_FLOOR = 0.05;
  private static readonly EPS = 1e-8;

  constructor(alpha: number, mean = 0.5, variance = 0.1, count = 0) {
    this.alpha = alpha;
    this.mean = mean;
    this.variance = variance;
    this.count = count;
  }

  /** Update the running statistics and return the normalized value in [0, 1]. */
  normalize(raw: number): number {
    // Update running mean and variance with EMA
    this.mean = (1 - this.alpha) * this.mean + this.alpha * raw;
    const diff = raw - this.mean;
    this.variance = (1 - this.alpha) * this.variance + this.alpha * (diff * diff);
    this.count++;

    // Normalize: (raw - mean) / max(std, VARIANCE_FLOOR)
    // Then map to [0, 1] via sigmoid-like shift
    const std = Math.sqrt(this.variance);
    const safeStd = Math.max(std, RunningEMANormalizer.VARIANCE_FLOOR) + RunningEMANormalizer.EPS;
    const normalized = (raw - this.mean) / safeStd;

    // Map from ~[-3, 3] to [0, 1] via shifted sigmoid
    return Math.max(0, Math.min(1, 0.5 + normalized * 0.25));
  }

  toJSON(): { mean: number; variance: number; count: number } {
    return { mean: this.mean, variance: this.variance, count: this.count };
  }

  static fromJSON(
    alpha: number,
    data: { mean: number; variance: number; count: number },
  ): RunningEMANormalizer {
    return new RunningEMANormalizer(alpha, data.mean, data.variance, data.count);
  }
}

// ── Main GCCRF Reward Function ──

export class GCCRFRewardFunction {
  private readonly db: DatabaseSync;
  private readonly config: GCCRFConfig;

  // Normalizers — one per component
  private normEta: RunningEMANormalizer;
  private normDeltaEta: RunningEMANormalizer;
  private normIAlpha: RunningEMANormalizer;
  private normEmpowerment: RunningEMANormalizer;
  private normStrategic: RunningEMANormalizer;

  // Per-region ETA tracking: regionId → { emaLong, emaShort, sampleCount }
  private regionEta: Map<string, { emaLong: number; emaShort: number; sampleCount: number }>;

  // Sliding window of recent η values for mu_t (interoceptive modulator)
  private recentEtas: number[];

  // Total chunks processed (for internal tracking — maturity uses dream cycles)
  private totalChunksProcessed: number;

  // Plan 7, Phase 10: FSHO ↔ GCCRF alpha coupling
  private fshoRAvg: number = 0.5;
  private readonly fshoEmaAlpha = 0.2;

  constructor(db: DatabaseSync, config?: Partial<GCCRFConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_GCCRF_CONFIG, ...config };
    if (!Number.isFinite(this.config.densityBandwidth) || this.config.densityBandwidth <= 0) {
      log.warn(
        `invalid gccrf.densityBandwidth ${String(this.config.densityBandwidth)}; using ${DEFAULT_GCCRF_CONFIG.densityBandwidth}`,
      );
      this.config.densityBandwidth = DEFAULT_GCCRF_CONFIG.densityBandwidth;
    }
    if (
      !Number.isFinite(this.config.expectedMatureCycles) ||
      this.config.expectedMatureCycles <= 0
    ) {
      log.warn(
        `invalid gccrf.expectedMatureCycles ${String(this.config.expectedMatureCycles)}; using ${DEFAULT_GCCRF_CONFIG.expectedMatureCycles}`,
      );
      this.config.expectedMatureCycles = DEFAULT_GCCRF_CONFIG.expectedMatureCycles;
    }
    ensureGCCRFSchema(db);

    // Initialize normalizers with defaults
    const alpha = this.config.etaEmaAlpha;
    this.normEta = new RunningEMANormalizer(alpha);
    this.normDeltaEta = new RunningEMANormalizer(alpha);
    this.normIAlpha = new RunningEMANormalizer(alpha);
    this.normEmpowerment = new RunningEMANormalizer(alpha);
    this.normStrategic = new RunningEMANormalizer(alpha);
    this.regionEta = new Map();
    this.recentEtas = [];
    this.totalChunksProcessed = 0;

    // Try to load persisted state
    this.loadState();
  }

  /**
   * Compute the intrinsic curiosity reward for a new chunk.
   * Call this when a new chunk is ingested into the memory system.
   *
   * @param chunkEmbedding - The chunk's embedding vector
   * @param regionCentroids - Map of region ID → centroid embedding
   * @param strategicTargets - Array of active curiosity target embeddings
   * @param context - The chunk being scored, so KNN can exclude it from its own neighbourhood
   * @returns Full reward result with components, diagnostics, and alpha
   */
  compute(
    chunkEmbedding: number[],
    regionCentroids: Map<string, number[]>,
    strategicTargets: number[][],
    context: GCCRFComputeContext = {},
  ): GCCRFRewardResult {
    const [w1, w2, w3, w4, w5] = this.config.weights;

    // ── Component 1: Prediction Error (η) ──
    // η = 1 - max_cosine_similarity(chunk, region_centroids)
    // Measures deviation from world model expectation (nearest region centroid).
    const { eta: rawEta, regionId } = this.computePredictionError(chunkEmbedding, regionCentroids);

    // ── Component 2: Learning Progress (Δη) ──
    // Per-region dual-EMA: Δη = max(0, ema_long - ema_short)
    // Positive = system is getting "less surprised" in this region (learning).
    const rawDeltaEta = this.computeLearningProgress(regionId, rawEta);

    // ── Component 3: Information-Theoretic Novelty (Iα) ──
    // KDE density with alpha-annealed reward shaping.
    // Young agent (α < -1): rewards high density (common things).
    // Mature agent (α → 0): rewards low density (frontier exploration).
    const { iAlpha: rawIAlpha, density } = this.computeInformationTheoreticNovelty(
      chunkEmbedding,
      context,
    );

    // ── Component 4: Empowerment (E · μ_t) ──
    // E = neighborhood diversity (regions × types).
    // μ_t = interoceptive gate: opens when prediction errors are volatile.
    const rawEmpowerment = this.computeEmpowerment(chunkEmbedding, rawEta, context);

    // ── Component 5: Strategic Alignment (S) ──
    // S = max cosine similarity to active exploration targets.
    const rawStrategic = this.computeStrategicAlignment(chunkEmbedding, strategicTargets);

    // ── Normalize all components to [0, 1] via running EMA normalizers ──
    const normEta = this.normEta.normalize(rawEta);
    // Progress preserves zero: the EMA normalizer maps "no change" to 0.5 (its
    // running mean), which rewarded a region that is not moving at all. Raw Δη
    // is already a bounded difference of two η EMAs, so clamp it instead. The
    // normalizer still sees the value so its statistics remain available for
    // telemetry (getState) and for the dream-mode thresholds that read them.
    this.normDeltaEta.normalize(rawDeltaEta);
    const normDeltaEta = Math.max(0, Math.min(1, rawDeltaEta));
    const normIAlpha = this.normIAlpha.normalize(rawIAlpha);
    const normEmpowerment = this.normEmpowerment.normalize(rawEmpowerment);
    const normStrategic = this.normStrategic.normalize(rawStrategic);

    // ── Weighted sum + tanh squash to [0, 1] ──
    // R_i = tanh(w1·η_n + w2·Δη_n + w3·I_α_n + w4·E_n + w5·S_n)
    const weightedSum =
      w1 * normEta +
      w2 * normDeltaEta +
      w3 * normIAlpha +
      w4 * normEmpowerment +
      w5 * normStrategic;

    // tanh squash: raw weighted sum is typically 0-1 range already (since components
    // are normalized), but tanh ensures we stay bounded for edge cases.
    // Map from tanh output [-1,1] to [0,1]:
    const reward = (Math.tanh(weightedSum * 2 - 1) + 1) / 2;

    // Update tracking
    this.recentEtas.push(rawEta);
    if (this.recentEtas.length > this.config.etaWindowSize) {
      this.recentEtas.shift();
    }
    this.totalChunksProcessed++;

    const maturity = this.getMaturity();

    return {
      reward,
      components: {
        eta: normEta,
        deltaEta: normDeltaEta,
        iAlpha: normIAlpha,
        empowerment: normEmpowerment,
        strategic: normStrategic,
      },
      rawComponents: {
        eta: rawEta,
        deltaEta: rawDeltaEta,
        iAlpha: rawIAlpha,
        empowerment: rawEmpowerment,
        strategic: rawStrategic,
      },
      alpha: this.getEffectiveAlpha(),
      density,
      regionId,
      maturity,
    };
  }

  // ── Component 1: Prediction Error (η) ──
  // η = 1 - max_cosine_similarity(chunk_embedding, region_centroids)
  // Original: MSE between predicted and actual next latent state.
  // Translation: Distance from nearest knowledge region centroid.

  private computePredictionError(
    chunkEmbedding: number[],
    regionCentroids: Map<string, number[]>,
  ): { eta: number; regionId: string | null } {
    if (regionCentroids.size === 0) {
      return { eta: 1.0, regionId: null };
    }

    let maxSim = -1;
    let nearestRegionId: string | null = null;

    for (const [regionId, centroid] of regionCentroids) {
      if (centroid.length === 0) {
        continue;
      }
      const sim = cosineSimilarity(chunkEmbedding, centroid);
      if (sim > maxSim) {
        maxSim = sim;
        nearestRegionId = regionId;
      }
    }

    // η = 1 - max_cosine_sim
    const eta = Math.max(0, 1 - maxSim);
    return { eta, regionId: nearestRegionId };
  }

  // ── Component 2: Learning Progress (Δη) ──
  // Per-region dual-EMA tracking.
  // Δη = max(0, ema_long - ema_short)
  // Update both EMAs with current η after computing Δη.
  // Original: positive difference between long-term EMA and current batch error.

  private computeLearningProgress(regionId: string | null, currentEta: number): number {
    if (!regionId) {
      return 0;
    }

    // Get or initialize per-region ETA state. A new region starts at the
    // observed η, not at 0.5: seeding both EMAs at a constant manufactured a
    // spurious Δη for the first dozens of samples in every region whose η sat
    // away from 0.5.
    let state = this.regionEta.get(regionId);
    if (!state) {
      state = { emaLong: currentEta, emaShort: currentEta, sampleCount: 0 };
      this.regionEta.set(regionId, state);
    }

    // Compute Δη BEFORE updating EMAs (as specified in the plan)
    const deltaEta = Math.max(0, state.emaLong - state.emaShort);

    // Update EMAs with current η
    const ALPHA_LONG = 0.01; // slow decay
    const ALPHA_SHORT = 0.1; // fast decay
    state.emaLong = (1 - ALPHA_LONG) * state.emaLong + ALPHA_LONG * currentEta;
    state.emaShort = (1 - ALPHA_SHORT) * state.emaShort + ALPHA_SHORT * currentEta;
    state.sampleCount++;

    return deltaEta;
  }

  // ── Component 3: Information-Theoretic Novelty (Iα) ──
  // KDE density estimation with alpha-annealed reward shaping.
  // This is the most original component — developmental annealing.
  //
  // 1. Density: RBF kernel KDE over K nearest neighbors (from sqlite-vec).
  // 2. Alpha: linear interpolation based on dream cycles completed.
  //    α starts at -3.0 (rewards high density → common things).
  //    α anneals to 0.0 (rewards low density → frontier exploration).
  // 3. Shaped reward: I_α = (density + ε)^(-(α+1)/2) - 1
  //
  // Density uses one shared RBF bandwidth over raw cosine distances
  // (config.densityBandwidth) so that absolute proximity is preserved across
  // queries: a neighbourhood at distance 0.01 and one at 0.7 must not score
  // the same just because their internal spacing is similar. The previous
  // per-query min/max stretch had exactly that defect.
  // Cold start protection: return 0.5 (neutral) when < 10 neighbors available.

  private computeInformationTheoreticNovelty(
    chunkEmbedding: number[],
    context: GCCRFComputeContext = {},
  ): {
    iAlpha: number;
    density: number;
  } {
    const targetK = this.config.kdeK;
    const EPS = 1e-8;

    // Get total chunk count for cold start check
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM chunks WHERE COALESCE(lifecycle_state, 'active') = 'active'`,
      )
      .get() as { c: number } | undefined;
    const totalChunks = totalRow?.c ?? 0;
    // The assessed chunk is not its own neighbour.
    const actualK = Math.min(targetK, totalChunks - (context.chunkId ? 1 : 0));

    // Cold start protection: neutral value if insufficient topology
    if (actualK < 10) {
      return { iAlpha: 0.5, density: 0.5 };
    }

    // KNN search: get K nearest neighbors and their distances
    const neighbors = this.knnSearch(chunkEmbedding, actualK, context);
    if (neighbors.length < 10) {
      return { iAlpha: 0.5, density: 0.5 };
    }

    // RBF kernel density estimation over raw cosine distances
    // density = (1/K) * Σ exp(-d² / (2 * bandwidth²))
    const bwSq = this.config.densityBandwidth * this.config.densityBandwidth;
    let densitySum = 0;
    for (const n of neighbors) {
      const d = Math.max(0, 1 - n.similarity);
      densitySum += Math.exp(-(d * d) / (2 * bwSq));
    }
    const density = densitySum / neighbors.length;

    // Alpha annealing schedule (tied to dream cycles, not chunk count),
    // optionally FSHO-modulated when memory.curiosity.fshoCoupling is on.
    const alpha = this.getEffectiveAlpha();

    // Shaped reward: the alpha-family novelty of Nedergaard & Morales (eq. 23),
    // including its 4/(1-α²) prefactor. See informationGeometricNovelty.
    const iAlpha = informationGeometricNovelty(density + EPS, alpha);

    return { iAlpha, density };
  }

  // ── Component 4: Empowerment (E · μ_t) ──
  // E = log(regions_touched + 1) * log(types_touched + 1)
  // μ_t = sigmoid(GAIN * (eta_variability - THRESHOLD))
  //
  // A chunk's empowerment is high if it bridges multiple knowledge regions
  // and connects to diverse semantic types.
  // The interoceptive modulator μ_t gates empowerment by uncertainty:
  // when prediction errors are volatile (confused), seek agency.

  private computeEmpowerment(
    chunkEmbedding: number[],
    _currentEta: number,
    context: GCCRFComputeContext = {},
  ): number {
    const targetK = this.config.empowermentK;

    // Get total chunk count for cold start check
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM chunks WHERE COALESCE(lifecycle_state, 'active') = 'active'`,
      )
      .get() as { c: number } | undefined;
    const totalChunks = totalRow?.c ?? 0;
    const actualK = Math.min(targetK, totalChunks - (context.chunkId ? 1 : 0));

    // Cold start protection
    if (actualK < 10) {
      return 0.5;
    }

    // Get neighborhood: chunks with their region assignments and semantic types
    const neighbors = this.getNeighborhoodDiversity(chunkEmbedding, actualK, context);

    // E = log(regions_touched + 1) * log(types_touched + 1)
    const E = Math.log(neighbors.regionsCount + 1) * Math.log(neighbors.typesCount + 1);

    // μ_t: interoceptive modulator
    // eta_variability = std(recent_eta_values, window=20)
    // mu_t = sigmoid(GAIN * (eta_variability - THRESHOLD))
    const etaVariability = this.computeEtaVariability();
    const muT = sigmoid(this.config.muGain * (etaVariability - this.config.muThreshold));

    // Final component 4: E * mu_t
    return E * muT;
  }

  // ── Component 5: Strategic Alignment (S) ──
  // S = max cosine similarity to active curiosity targets.
  // Original: direct port. Closes the curiosity→reward→target loop.

  private computeStrategicAlignment(
    chunkEmbedding: number[],
    strategicTargets: number[][],
  ): number {
    if (strategicTargets.length === 0) {
      return 0.5; // Neutral when no targets
    }

    let maxSim = 0;
    for (const target of strategicTargets) {
      if (target.length === 0) {
        continue;
      }
      const sim = cosineSimilarity(chunkEmbedding, target);
      if (sim > maxSim) {
        maxSim = sim;
      }
    }

    return maxSim;
  }

  // ── Alpha Schedule ──
  // Linear interpolation based on dream cycles completed (not chunk count).
  // Tied to dream cycles to prevent "speedrunning childhood" on bulk imports.

  getCurrentAlpha(): number {
    const maturity = this.getMaturity();
    const { alphaStart, alphaEnd } = this.config;
    return alphaStart + (alphaEnd - alphaStart) * maturity;
  }

  /**
   * Agent maturity ratio [0, 1], from completed dream cycles only. A bulk
   * import of 500 chunks or 30 days on the clock is not consolidation: the
   * chunk-count and calendar-age shortcuts let a node with many chunks and
   * almost no completed cycles jump straight to the frontier-seeking regime.
   */
  getMaturity(): number {
    const cycleMat = this.getDreamCyclesCompleted() / this.config.expectedMatureCycles;
    return Math.min(1, Math.max(0, cycleMat));
  }

  /**
   * The alpha novelty actually uses: the maturity schedule, FSHO-modulated only
   * when `fshoCoupling` is enabled.
   */
  getEffectiveAlpha(): number {
    return this.config.fshoCoupling ? this.getFshoCoupledAlpha() : this.getCurrentAlpha();
  }

  // ── Plan 7, Phase 10: FSHO Alpha Coupling ──

  /**
   * Update the running EMA of FSHO order parameter.
   * Called by dream-engine after FSHO computation.
   */
  updateFshoR(orderParameter: number): void {
    this.fshoRAvg = this.fshoEmaAlpha * orderParameter + (1 - this.fshoEmaAlpha) * this.fshoRAvg;
  }

  /**
   * Get FSHO-coupled alpha. Modulates the base maturity schedule
   * based on memory landscape coherence.
   *
   * High R (coherent) → shift alpha toward frontier-seeking (faster maturation)
   * Low R (scattered) → shift alpha toward density-seeking (consolidate first)
   */
  getFshoCoupledAlpha(): number {
    const baseAlpha = this.getCurrentAlpha();
    const couplingStrength = 0.5;
    const rThreshold = 0.5;

    const delta = couplingStrength * (this.fshoRAvg - rThreshold);

    return Math.max(this.config.alphaStart, Math.min(this.config.alphaEnd, baseAlpha + delta));
  }

  /** Expose FSHO R EMA for telemetry. */
  getFshoRAvg(): number {
    return this.fshoRAvg;
  }

  /** Count completed dream cycles from the dream_cycles table. */
  private getDreamCyclesCompleted(): number {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) as c FROM dream_cycles WHERE completed_at IS NOT NULL`)
        .get() as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  // ── KNN Search ──
  // Uses sqlite-vec for K-nearest-neighbor search when available,
  // falls back to brute-force cosine similarity over recent chunks.
  // Both paths exclude the assessed chunk itself (context.chunkId) and only
  // return active chunks, so they rank the same corpus.

  private knnSearch(
    embedding: number[],
    k: number,
    context: GCCRFComputeContext = {},
  ): Array<{ id: string; similarity: number }> {
    if (k <= 0) {
      return [];
    }
    // Try sqlite-vec first
    try {
      const vecBlob = float32ArrayToBlob(new Float32Array(embedding));
      // Use vec0's native KNN (MATCH ... k) rather than scanning every row with
      // vec_distance_cosine + ORDER BY + LIMIT. On ~8.7k vectors the scan takes
      // ~4.4s/query vs ~0.1s for MATCH (~40x), and this runs thousands of times
      // per dream cycle — the scan form blocked the event loop for tens of
      // minutes once the embedded set grew. chunks_vec uses vec0's default L2
      // metric and the embeddings are unit-normalized, so the L2 ranking equals
      // the cosine ranking and cosine = 1 - L2^2/2 exactly.
      //
      // The MATCH stays index-wide. We overfetch a little and post-filter: the
      // assessed chunk is its own nearest neighbour (self-match at distance 0
      // inflated every density estimate), and the index can hold rows for
      // chunks archived since. The filter is one primary-key IN lookup over
      // ~k ids; no embedding is parsed and no recency window is applied.
      const stmt = this.db.prepare(
        `SELECT id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?`,
      );
      let fetch = k + KNN_OVERFETCH;
      let eligible: Array<{ id: string; distance: number }> = [];
      for (let round = 0; round < KNN_MAX_ROUNDS; round++) {
        const rows = stmt.all(vecBlob, fetch) as Array<{ id: string; distance: number }>;
        eligible = this.filterEligibleNeighbors(rows, context.chunkId);
        if (eligible.length >= k || rows.length < fetch) {
          break;
        }
        fetch *= 2;
      }

      return eligible.slice(0, k).map((r) => ({
        id: r.id,
        similarity: 1 - (r.distance * r.distance) / 2,
      }));
    } catch {
      // Fallback: brute-force over recent active chunks
      return this.knnSearchFallback(embedding, k, context);
    }
  }

  /** Drop the assessed chunk and any index row whose chunk is gone or inactive. */
  private filterEligibleNeighbors(
    rows: Array<{ id: string; distance: number }>,
    selfId: string | undefined,
  ): Array<{ id: string; distance: number }> {
    const candidates = rows.filter((r) => r.id !== selfId);
    if (candidates.length === 0) {
      return candidates;
    }
    const placeholders = candidates.map(() => "?").join(",");
    const active = new Set(
      (
        this.db
          .prepare(
            `SELECT id FROM chunks WHERE id IN (${placeholders})
               AND COALESCE(lifecycle_state, 'active') = 'active'`,
          )
          .all(...candidates.map((r) => r.id)) as Array<{ id: string }>
      ).map((r) => r.id),
    );
    return candidates.filter((r) => active.has(r.id));
  }

  private knnSearchFallback(
    embedding: number[],
    k: number,
    context: GCCRFComputeContext = {},
  ): Array<{ id: string; similarity: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, embedding FROM chunks
         WHERE COALESCE(lifecycle_state, 'active') = 'active'
           AND embedding IS NOT NULL AND embedding != '[]'
           AND id != ?
         ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(context.chunkId ?? "") as Array<{ id: string; embedding: string }>;

    // Rank every parseable neighbour, like the vec0 path does: an orthogonal
    // (similarity 0) chunk is still one of the k nearest when the corpus is small.
    const withSim = rows
      .map((r) => ({ id: r.id, emb: parseEmbedding(r.embedding) }))
      .filter((r) => r.emb.length === embedding.length && r.emb.length > 0)
      .map((r) => ({ id: r.id, similarity: cosineSimilarity(embedding, r.emb) }))
      .toSorted((a, b) => b.similarity - a.similarity)
      .slice(0, k);

    return withSim;
  }

  // ── Neighborhood Diversity (for Empowerment) ──

  private getNeighborhoodDiversity(
    embedding: number[],
    k: number,
    context: GCCRFComputeContext = {},
  ): { regionsCount: number; typesCount: number } {
    // Get K nearest neighbor IDs
    const neighbors = this.knnSearch(embedding, k, context);
    if (neighbors.length === 0) {
      return { regionsCount: 0, typesCount: 0 };
    }

    const neighborIds = neighbors.map((n) => n.id);

    // Count distinct knowledge regions touched by neighbors
    const regionIds = new Set<string>();
    const types = new Set<string>();

    // Check curiosity_surprises for region assignments
    for (const nId of neighborIds) {
      try {
        const row = this.db
          .prepare(`SELECT region_id FROM curiosity_surprises WHERE chunk_id = ?`)
          .get(nId) as { region_id: string | null } | undefined;
        if (row?.region_id) {
          regionIds.add(row.region_id);
        }
      } catch {
        /* table may not exist yet */
      }

      // Check semantic type from chunks table
      try {
        const row = this.db.prepare(`SELECT semantic_type FROM chunks WHERE id = ?`).get(nId) as
          | { semantic_type: string | null }
          | undefined;
        if (row?.semantic_type) {
          types.add(row.semantic_type);
        }
      } catch {
        /* column may not exist */
      }
    }

    // If no region data from surprises, approximate from region centroids
    if (regionIds.size === 0) {
      try {
        const regions = this.db
          .prepare(`SELECT id, centroid FROM curiosity_regions LIMIT 50`)
          .all() as Array<{ id: string; centroid: string }>;

        for (const nId of neighborIds) {
          const chunk = this.db.prepare(`SELECT embedding FROM chunks WHERE id = ?`).get(nId) as
            | { embedding: string }
            | undefined;
          if (!chunk) {
            continue;
          }
          const emb = parseEmbedding(chunk.embedding);
          if (emb.length === 0) {
            continue;
          }

          let bestRegion: string | null = null;
          let bestSim = -1;
          for (const region of regions) {
            const centroid = parseEmbedding(region.centroid);
            if (centroid.length === 0) {
              continue;
            }
            const sim = cosineSimilarity(emb, centroid);
            if (sim > bestSim) {
              bestSim = sim;
              bestRegion = region.id;
            }
          }
          if (bestRegion && bestSim > 0.5) {
            regionIds.add(bestRegion);
          }
        }
      } catch {
        /* curiosity_regions may not exist */
      }
    }

    return {
      regionsCount: regionIds.size,
      typesCount: Math.max(1, types.size), // At least 1 type (default)
    };
  }

  // ── Eta Variability (for μ_t) ──

  private computeEtaVariability(): number {
    if (this.recentEtas.length < 3) {
      return 0;
    }

    const n = this.recentEtas.length;
    const mean = this.recentEtas.reduce((a, b) => a + b, 0) / n;
    let variance = 0;
    for (const eta of this.recentEtas) {
      variance += (eta - mean) ** 2;
    }
    variance /= n;

    return Math.sqrt(variance);
  }

  // ── State Persistence ──

  /** Persist normalizer and region ETA state to DB. */
  saveState(): void {
    const state: GCCRFState = {
      normalizers: {
        eta: this.normEta.toJSON(),
        deltaEta: this.normDeltaEta.toJSON(),
        iAlpha: this.normIAlpha.toJSON(),
        empowerment: this.normEmpowerment.toJSON(),
        strategic: this.normStrategic.toJSON(),
      },
      regionEta: Object.fromEntries(this.regionEta),
      recentEtas: this.recentEtas,
      totalChunksProcessed: this.totalChunksProcessed,
      scoringVersion: GCCRF_SCORING_VERSION,
      fshoRAvg: this.fshoRAvg,
    };

    try {
      saveGCCRFState(this.db, state);
    } catch (err) {
      log.warn(`failed to save GCCRF state: ${String(err)}`);
    }
  }

  /** Load persisted state from DB. Initializes with defaults on failure. */
  loadState(): void {
    try {
      const state = loadGCCRFState(this.db);
      if (!state) {
        return;
      }

      const alpha = this.config.etaEmaAlpha;

      // Version gate: normalizer statistics and per-region η EMAs accumulated
      // under an older scoring version are in different units (per-query
      // stretched density, 0.5-seeded region EMAs). They are reset once here;
      // the next saveState stamps the current version. The η window and the
      // processed counter are version-independent and are kept.
      const sameVersion = state.scoringVersion === GCCRF_SCORING_VERSION;
      if (!sameVersion) {
        log.info("GCCRF scoring version changed; resetting normalizer and region state", {
          from: state.scoringVersion ?? "legacy",
          to: GCCRF_SCORING_VERSION,
        });
      }

      if (sameVersion) {
        if (state.normalizers?.eta) {
          this.normEta = RunningEMANormalizer.fromJSON(alpha, state.normalizers.eta);
        }
        if (state.normalizers?.deltaEta) {
          this.normDeltaEta = RunningEMANormalizer.fromJSON(alpha, state.normalizers.deltaEta);
        }
        if (state.normalizers?.iAlpha) {
          this.normIAlpha = RunningEMANormalizer.fromJSON(alpha, state.normalizers.iAlpha);
        }
        if (state.normalizers?.empowerment) {
          this.normEmpowerment = RunningEMANormalizer.fromJSON(
            alpha,
            state.normalizers.empowerment,
          );
        }
        if (state.normalizers?.strategic) {
          this.normStrategic = RunningEMANormalizer.fromJSON(alpha, state.normalizers.strategic);
        }

        if (state.regionEta) {
          this.regionEta = new Map(Object.entries(state.regionEta));
        }
      }

      if (typeof state.fshoRAvg === "number" && Number.isFinite(state.fshoRAvg)) {
        this.fshoRAvg = state.fshoRAvg;
      }

      if (Array.isArray(state.recentEtas)) {
        this.recentEtas = state.recentEtas.slice(-this.config.etaWindowSize);
      }

      if (typeof state.totalChunksProcessed === "number") {
        this.totalChunksProcessed = state.totalChunksProcessed;
      }

      log.debug("GCCRF state loaded", {
        chunksProcessed: this.totalChunksProcessed,
        regions: this.regionEta.size,
      });
    } catch (err) {
      log.warn(`failed to load GCCRF state: ${String(err)}`);
    }
  }

  /** Get full diagnostic state. */
  getState(): GCCRFState {
    return {
      normalizers: {
        eta: this.normEta.toJSON(),
        deltaEta: this.normDeltaEta.toJSON(),
        iAlpha: this.normIAlpha.toJSON(),
        empowerment: this.normEmpowerment.toJSON(),
        strategic: this.normStrategic.toJSON(),
      },
      regionEta: Object.fromEntries(this.regionEta),
      recentEtas: [...this.recentEtas],
      totalChunksProcessed: this.totalChunksProcessed,
      scoringVersion: GCCRF_SCORING_VERSION,
      fshoRAvg: this.fshoRAvg,
    };
  }

  /** Get current config (for diagnostics). */
  getConfig(): GCCRFConfig {
    return { ...this.config };
  }
}

// ── Utility Functions ──

/**
 * Alpha-family information-geometric novelty of a density estimate p in (0, 1]:
 *
 *   I_α(p) = 4 / (1 - α²) · (p^(-(α+1)/2) - 1)      for α ≠ ±1
 *   I_-1(p) = -log p                                 (the α → -1 limit)
 *
 * (Nedergaard & Morales, eq. 23). The prefactor is not cosmetic: without it the
 * ordering flips for α < -1. At α = -3 the bare power term is p - 1, a
 * familiarity bonus that scored the most common material highest, while the
 * full I_-3(p) = (1 - p) / 2 is decreasing in p like every other member of the
 * family. So the schedule does not switch from "familiar is interesting" to
 * "rare is interesting"; it moves from a bounded, forgiving novelty bonus
 * (I_-3 ∈ [0, 0.5)) to an unbounded, sharply frontier-seeking one
 * (I_0 = 4(1/√p - 1)). The per-component normalizer absorbs the scale.
 *
 * Near α = -1 the prefactor blows up (about +21 at -0.9, -19 at -1.1) while
 * the power term goes to 0, so a window around -1 uses the log limit.
 */
export function informationGeometricNovelty(p: number, alpha: number): number {
  const safeP = Math.max(p, Number.EPSILON);
  if (Math.abs(alpha + 1) < ALPHA_LOG_LIMIT_WINDOW) {
    return -Math.log(safeP);
  }
  const prefactor = 4 / (1 - alpha * alpha);
  return prefactor * (Math.pow(safeP, -(alpha + 1) / 2) - 1);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function float32ArrayToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
