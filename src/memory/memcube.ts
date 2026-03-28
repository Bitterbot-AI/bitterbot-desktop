/**
 * MemCube: MemOS-inspired memory unit abstraction with lifecycle state machine.
 *
 * Each memory chunk is enriched with lifecycle metadata, emotional valence,
 * curiosity signals, and an audit trail for full observability.
 */

export type MemoryType = "plaintext" | "activation" | "dream" | "skill" | "semantic";

export type LifecycleState = "active" | "consolidating" | "archived" | "forgotten";

export type MemoryOrigin =
  | "indexed"
  | "session"
  | "dream_synthesis"
  | "crystallized"
  | "curiosity_probe";

export type AuditEvent =
  | "created"
  | "accessed"
  | "scored"
  | "promoted"
  | "merged"
  | "archived"
  | "forgotten"
  | "purged"
  | "dream_processed"
  | "curiosity_assessed"
  | "emotional_tagged"
  | "lifecycle_transition";

export type AuditEntry = {
  event: AuditEvent;
  timestamp: number;
  actor: string;
  metadata?: Record<string, unknown>;
};

export type MemCube = {
  id: string;
  version: number;
  parentId?: string;
  text: string;
  path: string;
  embedding: number[];
  memoryType: MemoryType;
  origin: MemoryOrigin;
  lifecycleState: LifecycleState;
  importanceScore: number;
  accessCount: number;
  lastAccessedAt: number;
  emotionalValence: number | null;
  curiosityBoost: number;
  dreamCount: number;
  lastDreamedAt: number | null;
  auditTrail: AuditEntry[];
};
