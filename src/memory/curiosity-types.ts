/**
 * Curiosity Engine types: knowledge regions, exploration targets, surprise
 * assessment, and configuration.
 */

export type KnowledgeRegion = {
  id: string;
  label: string;
  centroid: number[];
  chunkCount: number;
  totalAccesses: number;
  meanImportance: number;
  predictionError: number;
  learningProgress: number;
  createdAt: number;
  lastUpdatedAt: number;
};

export type SearchQueryRecord = {
  id: string;
  query: string;
  queryEmbedding: number[];
  resultCount: number;
  topScore: number;
  meanScore: number;
  regionId: string | null;
  timestamp: number;
};

export type ExplorationTargetType =
  | "knowledge_gap"
  | "contradiction"
  | "stale_region"
  | "frontier";

export type ExplorationTarget = {
  id: string;
  type: ExplorationTargetType;
  description: string;
  priority: number;
  regionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  resolvedAt: number | null;
  expiresAt: number;
};

export type SurpriseAssessment = {
  chunkId: string;
  noveltyScore: number;
  surpriseFactor: number;
  informationGain: number;
  contradictionScore: number;
  compositeReward: number;
  regionId: string | null;
  assessedAt: number;
  /** GCCRF component breakdown (when unified scoring is active). */
  gccrfComponents?: {
    eta: number;
    deltaEta: number;
    iAlpha: number;
    empowerment: number;
    strategic: number;
  };
  /** GCCRF final reward [0,1] (when unified scoring is active). */
  gccrfReward?: number;
};

export type LearningProgressEntry = {
  id: string;
  regionId: string;
  predictionError: number;
  timestamp: number;
};

export type EmergenceEvent = {
  id: string;
  type: "convergence" | "bridge" | "cluster_formation";
  description: string;
  involvedRegions: string[];
  strength: number;
  detectedAt: number;
  metadata: Record<string, unknown>;
};

export type CuriosityState = {
  regions: KnowledgeRegion[];
  targets: ExplorationTarget[];
  recentSurprises: SurpriseAssessment[];
  recentEmergence?: EmergenceEvent[];
  queryCount: number;
};

export type CuriosityWeights = {
  novelty: number;
  surprise: number;
  informationGain: number;
  contradiction: number;
};

export type CuriosityConfig = {
  /** Enable curiosity engine. Default: true. */
  enabled?: boolean;
  /** Component weights for reward computation (legacy heuristic — ignored when GCCRF active). */
  weights?: Partial<CuriosityWeights>;
  /** Composite reward threshold to boost importance. Default: 0.4. */
  boostThreshold?: number;
  /** Multiplier applied to importance when boost fires. Default: 1.3. */
  boostMultiplier?: number;
  /** Maximum number of knowledge regions. Default: 50. */
  maxRegions?: number;
  /** Maximum active exploration targets. Default: 10. */
  maxTargets?: number;
  /** Exploration target TTL in hours. Default: 168 (7 days). */
  targetTtlHours?: number;
  /** Maximum stored search queries for gap detection. Default: 200. */
  maxQueryHistory?: number;
  /** Score threshold below which a query indicates a gap. Default: 0.5. */
  gapScoreThreshold?: number;
  /** GCCRF reward function configuration. When provided, GCCRF replaces heuristic scoring. */
  gccrf?: import("./gccrf-reward.js").GCCRFConfig | Partial<import("./gccrf-reward.js").GCCRFConfig>;
};

export const DEFAULT_CURIOSITY_WEIGHTS: CuriosityWeights = {
  novelty: 0.3,
  surprise: 0.25,
  informationGain: 0.25,
  contradiction: 0.2,
};

export const DEFAULT_CURIOSITY_CONFIG = {
  enabled: true,
  weights: DEFAULT_CURIOSITY_WEIGHTS,
  boostThreshold: 0.4,
  boostMultiplier: 1.3,
  maxRegions: 50,
  maxTargets: 10,
  targetTtlHours: 48, // 48h keeps exploration targets fresh (was 168h/7 days — too stale)
  maxQueryHistory: 200,
  gapScoreThreshold: 0.5,
} as const;

export type EmotionalConfig = {
  /** Enable emotional valence modulation. Default: true. */
  enabled?: boolean;
  /** Max decay rate reduction from strong emotions. Default: 0.5. */
  decayResistance?: number;
  /** Sentiment analysis method. Default: "keyword". */
  sentimentAnalysis?: "keyword" | "hybrid" | "llm" | "none";
  /** Hormonal modulation configuration. */
  hormonal?: {
    enabled?: boolean;
    dopamineHalflife?: number;
    cortisolHalflife?: number;
    oxytocinHalflife?: number;
  };
  /** User model configuration. */
  userModel?: {
    enabled?: boolean;
    extractPreferences?: boolean;
    detectPatterns?: boolean;
  };
};

export const DEFAULT_EMOTIONAL_CONFIG = {
  enabled: true,
  decayResistance: 0.5,
  sentimentAnalysis: "keyword",
} as const;
