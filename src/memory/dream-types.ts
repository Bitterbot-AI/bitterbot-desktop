/**
 * Dream Engine types: state machine, 9 dream modes, clustering,
 * synthesis, and configuration.
 */

export type DreamState = "DORMANT" | "INCUBATING" | "DREAMING" | "SYNTHESIZING" | "AWAKENING";

/** @deprecated Use DreamMode instead */
export type DreamCreativityMode = "associative" | "convergent" | "cross_domain";

// ── 9 Dream Modes ──
export type DreamMode =
  | "replay" // Strengthen important memory pathways
  | "mutation" // Generate skill/knowledge variations
  | "extrapolation" // Predict future patterns
  | "compression" // Generalize into higher abstractions
  | "simulation" // Cross-domain creative recombination
  | "exploration" // Gap-filling from curiosity targets
  | "research" // Empirical prompt optimization using execution data
  | "interceptor_harvest" // PLAN-20: mine intervention records → propose new interceptors
  | "relationship_reconsolidation" // PLAN-23 SABM: adjudicate flagged belief contradictions, close losers post-labile-window
  | "harness_evolve" // PLAN-25: mine harness-level failures → propose + validate + promote HarnessPolicy edits
  | "relationship_mining" // PLAN-28 A2: offline LLM mining of typed triples from fact chunks → populate the graph
  | "canonical_promotion" // PLAN-33 Phase 3: offline promotion of stable key-value facts into the canonical ledger
  | "hygiene"; // PLAN-40 Lane 2: embedding backfill + near-duplicate merge + canonical staleness questions

export type DreamModeConfig = {
  enabled: boolean;
  weight: number; // Relative frequency (0-1)
  maxChunks: number; // Chunks per cycle for this mode
  requiresLlm: boolean; // Whether this mode needs LLM calls
};

export const DEFAULT_MODE_CONFIGS: Record<DreamMode, DreamModeConfig> = {
  replay: { enabled: true, weight: 0.18, maxChunks: 20, requiresLlm: false },
  compression: { enabled: true, weight: 0.18, maxChunks: 30, requiresLlm: false },
  // PLAN-40 Phase 0: mutation disabled — the 2026-08-10 utility evaluation
  // found its lifetime output was 206 paraphrases of ONE skill (1 category,
  // 3 lineages), zero reads, zero executions: exactly the no-success-signal
  // distillation the literature warns against. Lane 1 (verified-success
  // distillation) is the principled replacement. The mode body is deleted
  // when Lane 1 lands; its auto-trigger is gated on this flag, so the flip
  // alone silences it.
  mutation: { enabled: false, weight: 0.14, maxChunks: 10, requiresLlm: true },
  simulation: { enabled: true, weight: 0.14, maxChunks: 10, requiresLlm: true },
  extrapolation: { enabled: true, weight: 0.09, maxChunks: 15, requiresLlm: true },
  exploration: { enabled: true, weight: 0.09, maxChunks: 10, requiresLlm: true },
  // PLAN-34 Phase 0: research mode disabled by default — it is unfueled
  // (skill_executions bootstrap deadlock) and its promotion path writes
  // directly to live chunk text with no staging gate (dream-engine value
  // audit 2026-07-10). PLAN-40 retires it permanently: Lane 1 is the gated
  // replacement for "improve skills from execution data".
  research: { enabled: false, weight: 0.09, maxChunks: 5, requiresLlm: true },
  // PLAN-40 HOLDS: these three are well-built but structurally unfueled
  // (evaluation E5: 0/25 held-out executions, 0/10 outcome-tagged records,
  // 12/100 relationships). Leaving them enabled burned softmax slots on
  // guaranteed no-ops (adversarial F10). The doctor's dream-utility section
  // shows each hold's live counter vs its wake threshold; re-enable when
  // the counter crosses it.
  interceptor_harvest: { enabled: false, weight: 0.09, maxChunks: 25, requiresLlm: true },
  relationship_reconsolidation: { enabled: false, weight: 0.09, maxChunks: 25, requiresLlm: true },
  harness_evolve: { enabled: false, weight: 0.05, maxChunks: 24, requiresLlm: true },
  relationship_mining: { enabled: true, weight: 0.09, maxChunks: 30, requiresLlm: true },
  canonical_promotion: { enabled: true, weight: 0.07, maxChunks: 30, requiresLlm: true },
  // PLAN-40 Lane 2. requiresLlm false: the backfill + staleness halves run
  // without any model; the merge half draws from the cycle's remaining LLM
  // budget when one is available and silently skips otherwise.
  hygiene: { enabled: true, weight: 0.15, maxChunks: 200, requiresLlm: false },
};

export type DreamCluster = {
  id: string;
  chunkIds: string[];
  centroid: number[];
  mode: DreamCreativityMode;
  meanImportance: number;
  keywords: string[];
};

export type DreamInsight = {
  id: string;
  content: string;
  embedding: number[];
  confidence: number;
  mode: DreamCreativityMode | DreamMode;
  sourceChunkIds: string[];
  sourceClusterIds: string[];
  dreamCycleId: string;
  importanceScore: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

// ── Tiered Compute (Task 9) ──

export type ComputeTier = "none" | "local" | "cloud";

export type ModelTierConfig = {
  localModel?: string;
  cloudModel?: string;
  modeTiers?: Partial<Record<DreamMode, ComputeTier>>;
  fallbackToCloud?: boolean;
};

export const DEFAULT_MODE_TIERS: Record<DreamMode, ComputeTier> = {
  replay: "none",
  compression: "none",
  exploration: "local",
  mutation: "cloud",
  extrapolation: "cloud",
  simulation: "cloud",
  research: "cloud",
  interceptor_harvest: "cloud",
  relationship_reconsolidation: "cloud",
  harness_evolve: "cloud",
  relationship_mining: "cloud",
  canonical_promotion: "cloud",
};

export type DreamCycleMetadata = {
  cycleId: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  state: DreamState;
  clustersProcessed: number;
  insightsGenerated: number;
  chunksAnalyzed: number;
  llmCallsUsed: number;
  error: string | null;
  modesUsed?: DreamMode[];
  tiersUsed?: ComputeTier[];
};

export type DreamStats = {
  cycle: DreamCycleMetadata;
  newInsights: DreamInsight[];
};

export type DreamSynthesisResult = {
  content: string;
  confidence: number;
  keywords: string[];
};

export type SynthesizeFn = (
  clusters: DreamCluster[],
  chunkTexts: Map<string, string>,
) => Promise<DreamSynthesisResult[]>;

export type EmbedBatchFn = (texts: string[]) => Promise<number[][]>;

export type DreamEngineConfig = {
  /** Enable dream engine. Default: true. */
  enabled?: boolean;
  /** Dream cycle interval in minutes. Default: 120. */
  intervalMinutes?: number;
  /** Initial delay in minutes before the first dream cycle. Default: 5.
   * Prevents hot reloads from resetting the 2-hour timer indefinitely. */
  initialDelayMinutes?: number;
  /** PLAN-11 Gap 5: adaptive interval driven by smoothed marketplace activity. */
  adaptiveInterval?: {
    /** Enable adaptive scheduling (default: false — falls back to fixed interval). */
    enabled?: boolean;
    /** Minimum interval in minutes (floor). Default: 30. */
    minMinutes?: number;
    /** Maximum interval in minutes (ceiling). Default: 240. */
    maxMinutes?: number;
    /** Rolling-window hours for activity smoothing. Default: 8. */
    windowHours?: number;
    /** Cooldown in minutes between interval changes (anti-flap). Default: 60. */
    cooldownMinutes?: number;
    /** Activity score above which the interval halves. Default: 0.7. */
    highThreshold?: number;
    /** Activity score below which the interval doubles. Default: 0.3. */
    lowThreshold?: number;
  };
  /** Max chunks to process per dream cycle. Default: 50. */
  maxChunksPerCycle?: number;
  /** Max LLM calls per dream cycle. Default: 5. */
  maxLlmCallsPerCycle?: number;
  /** Cosine similarity threshold for clustering. Default: 0.65. */
  clusterSimilarityThreshold?: number;
  /** Minimum importance score to be dream-eligible. Default: 0.1. */
  minImportanceForDream?: number;
  /** Synthesis mode. Default: "both". */
  synthesisMode?: "heuristic" | "llm" | "both";
  /** LLM model for synthesis. Default: "openai/gpt-4o-mini". */
  model?: string;
  /** Maximum stored dream insights. Default: 200. */
  maxInsights?: number;
  /** Minimum chunks required to run a dream cycle. Default: 5. */
  minChunksForDream?: number;
  /** Optional LLM call function for synthesis (cloud). */
  llmCall?: (prompt: string) => Promise<string>;
  /** Optional LLM call function specifically for RLM working memory synthesis. Falls back to llmCall. */
  synthesisLlmCall?: (prompt: string) => Promise<string>;
  /** Model identifier for RLM synthesis (e.g. "openai/gpt-4o"). Falls back to model. */
  synthesisModel?: string;
  /** Optional local LLM call function for local-tier modes. */
  localLlmCall?: (prompt: string) => Promise<string>;
  /** Per-mode configuration overrides. */
  modes?: Partial<Record<DreamMode, Partial<DreamModeConfig>>>;
  /** Tiered compute routing configuration. */
  modelTiers?: ModelTierConfig;
  /** Disable FSHO oscillator for mode selection (fall back to uniform weights). Used for ablation testing. */
  disableFsho?: boolean;
  /**
   * PLAN-34 Phase 2c: autonomous curiosity research egress controls
   * (mapped from memory.curiosity.autoResearch). enabled default true;
   * maxPerDay default 10 — a persisted UTC-day attempt counter with
   * reserve-then-act semantics. External research additionally requires a
   * local depersonalization model (localLlmCall): without one it fails
   * closed to zero egress.
   */
  autoResearch?: { enabled?: boolean; maxPerDay?: number };
  /**
   * PLAN-34 Phase 2 adversarial fix: set by the manager to true only when
   * localLlmCall was built from a genuinely LOCAL model spec. Gates
   * depersonalization egress so a cloud model named as localModel cannot
   * receive verbatim private notes. Omitted in direct-injection tests.
   */
  localModelIsLocal?: boolean;
  /**
   * PLAN-34 Phase 4: promote qualifying dream insights into searchable
   * chunks (origin='dream', semantic_type='insight') so dreams become
   * rememberable. Default enabled. Kill switch:
   * memory.dream.insightPromotion.enabled.
   */
  insightPromotion?: { enabled?: boolean };
};

export const DEFAULT_DREAM_CONFIG: Required<
  Omit<
    DreamEngineConfig,
    | "llmCall"
    | "synthesisLlmCall"
    | "localLlmCall"
    | "modes"
    | "modelTiers"
    | "autoResearch"
    | "localModelIsLocal"
    | "insightPromotion"
  >
> & { modes: Record<DreamMode, DreamModeConfig> } = {
  enabled: true,
  intervalMinutes: 120,
  initialDelayMinutes: 5,
  adaptiveInterval: {
    enabled: true,
    minMinutes: 30,
    maxMinutes: 240,
    windowHours: 8,
    cooldownMinutes: 60,
    highThreshold: 0.7,
    lowThreshold: 0.3,
  },
  maxChunksPerCycle: 50,
  // PLAN-34 Phase 4: 5 mode calls + up to 3 claim-decomposition
  // verification calls for insight promotion.
  maxLlmCallsPerCycle: 8,
  clusterSimilarityThreshold: 0.65,
  minImportanceForDream: 0.1,
  synthesisMode: "both",
  model: "openai/gpt-4o-mini",
  synthesisModel: "openai/gpt-4o-mini",
  maxInsights: 200,
  minChunksForDream: 5,
  disableFsho: false,
  modes: { ...DEFAULT_MODE_CONFIGS },
};
