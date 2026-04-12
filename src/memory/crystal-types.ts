/**
 * Knowledge Crystal type system — MemOS-inspired unified memory unit.
 *
 * Replaces the MemCube abstraction with richer lifecycle, governance,
 * hormonal influence, and semantic classification metadata.
 */

import type { MemorySource } from "./types.js";

// ── Lifecycle ──
export type CrystalLifecycle =
  | "generated" // Just created/indexed
  | "activated" // Frequently accessed, high importance
  | "consolidated" // Merged with related crystals
  | "archived" // Low importance, retained for lineage
  | "expired" // Marked for purge
  | "frozen"; // Immutable (skills, critical memories)

// ── Origin Signature ──
export type CrystalOrigin =
  | "indexed" // File-based memory
  | "session" // Conversation transcript
  | "skill" // Crystallized skill
  | "dream" // Dream synthesis output
  | "user_input" // Direct user statement
  | "inferred" // Extracted by LLM
  | "peer"; // Received from P2P peer

// ── Semantic Type ──
export type CrystalSemanticType =
  | "fact" // Factual knowledge
  | "preference" // User preference
  | "task_pattern" // Recurring task pattern
  | "skill" // Executable skill
  | "episode" // Episodic memory (event)
  | "insight" // Dream-synthesized insight
  | "relationship" // User relationship/social
  | "goal" // User goal/objective
  | "general"; // Default

// ── Governance ──
export type CrystalGovernance = {
  accessScope: "private" | "shared" | "public";
  lifespanPolicy: "permanent" | "ttl" | "decay";
  ttlMs?: number;
  priority: number;
  sensitivity: "normal" | "personal" | "confidential";
  provenanceChain: string[];
  peerOrigin?: string;
};

// ── Provenance DAG Node ──
export type ProvenanceNode = {
  crystalId: string;
  operation: "created" | "mutated" | "merged" | "imported" | "forked";
  actor: string; // "local_agent" | "dream_engine" | "peer:<pubkey>"
  timestamp: number;
  parentIds: string[]; // multiple parents for merges
  metadata?: Record<string, unknown>;
};

// ── Skill Identity (versioning) ──
export type SkillIdentity = {
  stableId: string; // persists across versions (UUID, assigned at first creation)
  version: number; // increments on each mutation promotion
  previousVersionId: string | null; // crystal ID of the prior version
  deprecated: boolean;
  deprecatedBy: string | null; // stableId of replacement skill
  tags: string[];
  category: string; // e.g. "code-generation", "debugging", "devops"
};

// ── Hormonal State (per-crystal influence) ──
export type HormonalInfluence = {
  dopamine: number; // -1 to 1: reward/achievement signal
  cortisol: number; // -1 to 1: stress/urgency signal
  oxytocin: number; // -1 to 1: social/relational signal
};

// ── Embedding Perspectives ──
export type EmbeddingPerspective = "semantic" | "procedural" | "causal" | "entity";

export type MultiPerspectiveEmbedding = {
  semantic: number[];
  procedural: number[];
  causal: number[];
  entity: number[];
};

// ── Skill Hierarchy ──
export type DomainProfile = {
  factual: number; // What: facts, entities, knowledge
  procedural: number; // How: steps, tools, execution
  affective: number; // Why: goals, motivations, context
};

export type SkillHierarchy = {
  level3: number; // Overall capability score (0-1)
  level2: DomainProfile; // 3 domains: What/How/Why
  level1: {
    // 6 groups
    factual: number;
    temporal: number;
    causal: number;
    relational: number;
    qualitative: number;
    implementation: number;
  };
  level0: number[]; // Raw 4-perspective embedding similarities
};

// ── Skill Edge Types ──
export type SkillEdgeType = "prerequisite" | "enables" | "contradicts" | "composes" | "similar";

export type SkillEdge = {
  id: string;
  sourceSkillId: string;
  targetSkillId: string;
  edgeType: SkillEdgeType;
  weight: number;
  steeringReward: number;
  confidence: number;
  discoveredBy: "llm" | "embedding" | "execution" | "user";
  createdAt: number;
  updatedAt: number;
};

// ── Execution Tracking ──
export type ExecutionOutcome = {
  success: boolean;
  rewardScore?: number; // 0-1
  errorType?: string | null;
  errorDetail?: string | null;
  executionTimeMs?: number;
  toolCallsCount?: number;
};

export type SkillMetrics = {
  totalExecutions: number;
  successRate: number; // 0-1
  avgRewardScore: number; // 0-1
  avgExecutionTimeMs: number;
  userFeedbackScore: number; // -1 to 1 (weighted average)
  lastExecutedAt: number;
  errorBreakdown: Record<string, number>;
};

export type PeerSkillMetrics = {
  peerPubkey: string;
  totalSkills: number;
  avgSuccessRate: number;
  avgRewardScore: number;
};

// ── Peer Reputation ──
export type TrustLevel = "banned" | "untrusted" | "provisional" | "trusted" | "verified";

export type PeerReputation = {
  peerPubkey: string;
  peerId: string | null;
  displayName: string | null;
  skillsReceived: number;
  skillsAccepted: number;
  skillsRejected: number;
  avgSkillQuality: number;
  reputationScore: number;
  firstSeenAt: number;
  lastSeenAt: number;
  isTrusted: boolean;
  trustLevel: TrustLevel;
};

// ── Divergence Detection ──
export type DivergenceReport = {
  severity: "high" | "medium" | "low" | "none";
  novelScores: Record<EmbeddingPerspective, number>;
  weakPerspectives: EmbeddingPerspective[];
  suggestedAction: "explore" | "acquire_skill" | "none";
};

// ── Marketplace ──
export type MarketplaceEntry = {
  stableSkillId: string;
  name: string;
  description: string;
  version: number;
  authorPeerId: string;
  authorReputation: number;
  successRate: number;
  downloadCount: number;
  tags: string[];
  category: string;
  createdAt: number;
  isVerified?: boolean;
  verifiedBy?: string | null;
};

export type MarketplaceFilters = {
  category?: string;
  minSuccessRate?: number;
  minAuthorReputation?: number;
  tags?: string[];
  sortBy?: "relevance" | "trending" | "newest" | "top_rated";
};

// ── Mutation Strategies ──
export type MutationStrategy =
  | "generic" // current behavior
  | "error_driven" // analyze failure logs, suggest fixes
  | "adversarial" // find edge cases and harden
  | "compositional" // combine best aspects of multiple skills
  | "parametric"; // vary thresholds/timeouts/strategies

// ── Full Knowledge Crystal ──
export type KnowledgeCrystal = {
  id: string;
  // Payload
  text: string;
  embedding: number[];
  // Descriptive metadata
  path: string;
  source: MemorySource;
  startLine: number;
  endLine: number;
  hash: string;
  semanticType: CrystalSemanticType;
  origin: CrystalOrigin;
  // Lifecycle
  lifecycle: CrystalLifecycle;
  version: number;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  // Behavioral
  importanceScore: number;
  accessCount: number;
  lastAccessedAt: number | null;
  emotionalValence: number | null;
  hormonalInfluence: HormonalInfluence | null;
  curiosityBoost: number;
  dreamCount: number;
  lastDreamedAt: number | null;
  // Governance
  governance: CrystalGovernance;
  // Versioning (Phase 6)
  stableSkillId?: string | null;
  skillVersion?: number;
  previousVersionId?: string | null;
  deprecated?: boolean;
  deprecatedBy?: string | null;
  skillTags?: string[];
  skillCategory?: string | null;
  // Steering (Phase 3)
  steeringReward?: number;
  // Provenance DAG (Phase 5)
  provenanceDag?: ProvenanceNode[];
  // Multi-Perspective Embeddings (Phase 8)
  embeddingProcedural?: number[];
  embeddingCausal?: number[];
  embeddingEntity?: number[];
  // Hierarchy (Phase 10)
  skillHierarchy?: SkillHierarchy | null;
  // Marketplace (Phase 9)
  marketplaceListed?: boolean;
  marketplaceDescription?: string | null;
  downloadCount?: number;
};
