/**
 * BioMemEval Adapter Interface
 *
 * Defines the behavioral contract for any memory system to be benchmarked.
 * Implement this interface to score your system against BioMemEval.
 *
 * Competitors that lack biological memory features (hormonal modulation,
 * reconsolidation, Zeigarnik open loops, prospective memory) will score 0
 * on the corresponding suites — by design.
 */

export interface HormonalState {
  dopamine: number;   // 0-1
  cortisol: number;   // 0-1
  oxytocin: number;   // 0-1
}

export interface StoredMemory {
  id: string;
  text: string;
  importance: number;
  context?: string;
}

export interface TemporalRelationship {
  entityName: string;
  relationType: string;
  validFrom?: number;
  validUntil?: number;
}

export interface SomaticVerdict {
  verdict: "proceed" | "caution" | "trusted";
}

export interface MemorySystemAdapter {
  readonly name: string;
  readonly version: string;

  // ── Lifecycle ──
  setup(): Promise<void>;
  teardown(): Promise<void>;

  // ── Suite 1: Zeigarnik Proactivity ──
  storeMemory(params: { id: string; text: string; importance: number }): Promise<void>;
  detectOpenLoop(text: string): Promise<{ detected: boolean; context?: string }>;
  markOpenLoop(memoryId: string, context: string): Promise<boolean>;
  closeOpenLoop(memoryId: string): Promise<boolean>;
  getUnpromptedOpenLoops(limit?: number): Promise<StoredMemory[]>;

  // ── Suite 2: Mood-Congruent Retrieval ──
  setEmotionalState(state: HormonalState): Promise<void>;
  computeRetrievalBias(params: {
    emotionalValence: number | null;
    semanticType: string | null;
  }): Promise<number>;

  // ── Suite 3: Reconsolidation ──
  markLabile(memoryId: string): Promise<boolean>;
  isLabile(memoryId: string): Promise<boolean>;
  strengthenMemory(memoryId: string): Promise<boolean>;
  flagContradiction(memoryId: string, info: string): Promise<boolean>;
  restabilizeExpired(): Promise<number>;

  // ── Suite 4: Temporal Reasoning ──
  upsertEntity(entity: { name: string; type: string }): Promise<{ id: string }>;
  upsertRelationship(params: {
    sourceName: string; sourceType: string;
    targetName: string; targetType: string;
    relationType: string;
    validFrom?: number; validUntil?: number | null;
    evidenceChunkIds?: string[];
  }): Promise<{ id: string }>;
  queryAtTime(
    entityName: string, entityType: string, relationType: string, atTime: number,
  ): Promise<TemporalRelationship[]>;

  // ── Suite 5: Identity Continuity ──
  createDirective(params: {
    type: string; question: string; context?: string; priority?: number;
  }): Promise<{ id: string } | null>;
  getSessionDirectives(): Promise<Array<{ id: string; question: string; priority: number }>>;
  resolveDirective(directiveId: string, resolution: string): Promise<boolean>;
  detectContradictions(): Promise<Array<{ question: string }>>;
  assessSomaticMarkers(memoryIds: string[]): Promise<SomaticVerdict>;

  // ── Suite 6: Prospective Memory ──
  createProspectiveMemory(params: {
    triggerCondition: string; action: string; triggerEmbedding?: number[];
    expiresAt?: number;
  }): Promise<{ id: string } | null>;
  checkTriggers(params: {
    messageText: string; messageEmbedding?: number[];
  }): Promise<Array<{ id: string; action: string }>>;
  cleanExpired(): Promise<number>;
}
