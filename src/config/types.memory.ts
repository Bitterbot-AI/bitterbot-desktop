import type { RLMConfig } from "../agents/rlm/types.js";
import type { CuriosityConfig, EmotionalConfig } from "../memory/curiosity-types.js";
import type { DreamEngineConfig } from "../memory/dream-types.js";
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
  /**
   * Days to retain forgotten/expired chunks before they are physically deleted
   * by the consolidation GC (`purgeExpired`). Tombstones are kept this long so a
   * recently-forgotten memory can still be restabilized/rescued before its row,
   * vector, and FTS entry are reclaimed. Default: 14. Set to 0 to purge as soon
   * as a chunk is forgotten; negative disables purging.
   */
  forgottenRetentionDays?: number;
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
  /** PLAN-24 HORMA Phase 0: provenance pointers from synthesized memories to raw sources. */
  provenance?: {
    /**
     * Persist evidence_refs on extracted facts / dream insights and expose the
     * memory_expand tool to resolve them back to verbatim source (default: true).
     */
    enabled?: boolean;
  };
  /** PLAN-24 HORMA Phase 3: self-evolving memory-architect rule library. */
  architectEvolution?: {
    /**
     * Inject learned construction rules into the extraction prompt and evolve
     * them during dreams from construction_feedback (under a validation gate).
     * Default true; rule injection is a no-op until rules are learned.
     */
    enabled?: boolean;
  };
  /** PLAN-24 HORMA Phase 5: build summary nodes over the SAGE graph for coarse-to-fine retrieval. */
  graphAbstraction?: {
    /**
     * During dreams, community-detect the entity graph and synthesize summary
     * entities so the reader has an O(log N) coarse entry point (default: true).
     */
    enabled?: boolean;
  };
  /** PLAN-24 HORMA Phase 1: deterministic construction-vs-retrieval blame router on recall miss. */
  coverageDiagnostics?: {
    /**
     * On a zero-result recall, diagnose whether the answer was never indexed
     * (exogenous / construction loss → construction_feedback) or indexed but not
     * retrieved (endogenous → graph training pair), or a genuine gap (default: true).
     */
    enabled?: boolean;
  };
  /** PLAN-11 Gap 6: daily digest of autonomous skill-pipeline activity. */
  digest?: {
    /** Enable the daily digest (default: true). */
    enabled?: boolean;
    /** Local clock time in 24h "HH:MM" format for daily delivery. Default: "09:00". */
    time?: string;
    /** Lookback window in hours. Default: 24. */
    lookbackHours?: number;
    /** Delivery channels. Empty = file only. */
    channels?: Array<
      | {
          kind: "file";
          /** Directory override. Default: <state>/memory/digest/ */
          dir?: string;
        }
      | { kind: "log" }
      | {
          kind: "message";
          /** Channel target (e.g. "telegram:user:123"). Uses the agent's configured channel routing. */
          target: string;
        }
    >;
  };
};
