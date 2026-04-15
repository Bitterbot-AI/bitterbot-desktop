/**
 * Dream Engine types: state machine, 7 dream modes, clustering,
 * synthesis, and configuration.
 */

export type DreamState = "DORMANT" | "INCUBATING" | "DREAMING" | "SYNTHESIZING" | "AWAKENING";

/** @deprecated Use DreamMode instead */
export type DreamCreativityMode = "associative" | "convergent" | "cross_domain";

// ── 7 Dream Modes ──
export type DreamMode =
  | "replay" // Strengthen important memory pathways
  | "mutation" // Generate skill/knowledge variations
  | "extrapolation" // Predict future patterns
  | "compression" // Generalize into higher abstractions
  | "simulation" // Cross-domain creative recombination
  | "exploration" // Gap-filling from curiosity targets
  | "research"; // Empirical prompt optimization using execution data

export type DreamModeConfig = {
  enabled: boolean;
  weight: number; // Relative frequency (0-1)
  maxChunks: number; // Chunks per cycle for this mode
  requiresLlm: boolean; // Whether this mode needs LLM calls
};

export const DEFAULT_MODE_CONFIGS: Record<DreamMode, DreamModeConfig> = {
  replay: { enabled: true, weight: 0.2, maxChunks: 20, requiresLlm: false },
  compression: { enabled: true, weight: 0.2, maxChunks: 30, requiresLlm: false },
  mutation: { enabled: true, weight: 0.15, maxChunks: 10, requiresLlm: true },
  simulation: { enabled: true, weight: 0.15, maxChunks: 10, requiresLlm: true },
  extrapolation: { enabled: true, weight: 0.1, maxChunks: 15, requiresLlm: true },
  exploration: { enabled: true, weight: 0.1, maxChunks: 10, requiresLlm: true },
  research: { enabled: true, weight: 0.1, maxChunks: 5, requiresLlm: true },
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
};

export const DEFAULT_DREAM_CONFIG: Required<
  Omit<DreamEngineConfig, "llmCall" | "synthesisLlmCall" | "localLlmCall" | "modes" | "modelTiers">
> & { modes: Record<DreamMode, DreamModeConfig> } = {
  enabled: true,
  intervalMinutes: 120,
  initialDelayMinutes: 5,
  adaptiveInterval: {
    enabled: false,
    minMinutes: 30,
    maxMinutes: 240,
    windowHours: 8,
    cooldownMinutes: 60,
    highThreshold: 0.7,
    lowThreshold: 0.3,
  },
  maxChunksPerCycle: 50,
  maxLlmCallsPerCycle: 5,
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
