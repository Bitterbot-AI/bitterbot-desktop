import type { RLMConfig } from "../agents/rlm/types.js";
import type { CuriosityConfig, EmotionalConfig } from "../memory/curiosity-types.js";
import type { DreamEngineConfig, DreamMode, DreamModeConfig } from "../memory/dream-types.js";
import type { GCCRFConfig } from "../memory/gccrf-reward.js";
import type { BudgetConfig } from "../memory/scheduler.js";

export type MemoryBackend = "builtin";
export type MemoryCitationsMode = "auto" | "on" | "off";

export type MemoryConsolidationConfig = {
  /** Enable FadeMem consolidation (Ebbinghaus decay + merge). Default: true. */
  enabled?: boolean;
  /** Decay rate λ per-ms for the Ebbinghaus forgetting curve. Default: 5e-10 (~16-day half-life). */
  decayRate?: number;
  /** Importance score threshold to promote to long-term. Default: 0.7. */
  promoteThreshold?: number;
  /** Importance score below which chunks are forgotten. Default: 0.02. */
  forgetThreshold?: number;
  /** Cosine similarity threshold to merge overlapping chunks. Default: 0.92. */
  mergeOverlapThreshold?: number;
  /** Consolidation cycle interval in minutes. Default: 30. */
  intervalMinutes?: number;
};

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  consolidation?: MemoryConsolidationConfig;
  /** Dream Engine: offline cross-domain pattern discovery. */
  dream?: DreamEngineConfig;
  /** Curiosity Engine: intrinsic motivation and gap detection. */
  curiosity?: CuriosityConfig;
  /** Emotional valence: affective memory modulation. */
  emotional?: EmotionalConfig;
  /** Memory scheduler: operation priority and budget management. */
  scheduler?: BudgetConfig;
  /** GCCRF: Geodesic Crystal-Field Curiosity Reward Function configuration. */
  gccrf?: Partial<GCCRFConfig>;
  /** RLM: Recursive Language Model for deep recall over full conversation history. */
  rlm?: RLMConfig;
  /** Session fact extraction pipeline (Mem0/Hindsight-inspired). */
  extraction?: {
    /** Enable LLM-powered fact extraction from session transcripts (default: true). */
    enabled?: boolean;
    /** LLM model for extraction (default: same as dream model). */
    model?: string;
    /** Minimum session content delta in chars before re-extraction (default: 2000). */
    minSessionDelta?: number;
    /** Maximum facts to extract per session (default: 20). */
    maxFactsPerSession?: number;
  };
};
