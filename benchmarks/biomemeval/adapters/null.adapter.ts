/**
 * Null Adapter: baseline that returns 0/false/empty for every operation.
 *
 * Represents a memory system with NO biological capabilities.
 * Expected BioMemEval composite score: 0%.
 *
 * Use this as a reference when implementing adapters for other systems.
 */

import type {
  MemorySystemAdapter,
  StoredMemory,
  SomaticVerdict,
  TemporalRelationship,
} from "../adapter.js";

export class NullAdapter implements MemorySystemAdapter {
  readonly name = "null-baseline";
  readonly version = "0.0.0";

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}

  // Zeigarnik
  async storeMemory(): Promise<void> {}
  async detectOpenLoop(): Promise<{ detected: boolean }> {
    return { detected: false };
  }
  async markOpenLoop(): Promise<boolean> {
    return false;
  }
  async closeOpenLoop(): Promise<boolean> {
    return false;
  }
  async getUnpromptedOpenLoops(): Promise<StoredMemory[]> {
    return [];
  }

  // Mood-Congruent
  async setEmotionalState(): Promise<void> {}
  async computeRetrievalBias(): Promise<number> {
    return 0;
  }

  // Reconsolidation
  async markLabile(): Promise<boolean> {
    return false;
  }
  async isLabile(): Promise<boolean> {
    return false;
  }
  async strengthenMemory(): Promise<boolean> {
    return false;
  }
  async flagContradiction(): Promise<boolean> {
    return false;
  }
  async restabilizeExpired(): Promise<number> {
    return 0;
  }

  // Temporal Reasoning
  async upsertEntity(): Promise<{ id: string }> {
    return { id: "" };
  }
  async upsertRelationship(): Promise<{ id: string }> {
    return { id: "" };
  }
  async queryAtTime(): Promise<TemporalRelationship[]> {
    return [];
  }

  // Identity Continuity
  async createDirective(): Promise<null> {
    return null;
  }
  async getSessionDirectives(): Promise<[]> {
    return [];
  }
  async resolveDirective(): Promise<boolean> {
    return false;
  }
  async detectContradictions(): Promise<[]> {
    return [];
  }
  async assessSomaticMarkers(): Promise<SomaticVerdict> {
    return { verdict: "proceed" };
  }

  // Prospective Memory
  async createProspectiveMemory(): Promise<null> {
    return null;
  }
  async checkTriggers(): Promise<[]> {
    return [];
  }
  async cleanExpired(): Promise<number> {
    return 0;
  }
}
