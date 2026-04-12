/**
 * Crystal helper layer: serialization/deserialization between DB rows
 * and KnowledgeCrystal objects, plus semantic type inference.
 */

import type {
  CrystalGovernance,
  CrystalLifecycle,
  CrystalOrigin,
  CrystalSemanticType,
  HormonalInfluence,
  KnowledgeCrystal,
} from "./crystal-types.js";
import type { MemorySource } from "./types.js";
import { parseEmbedding } from "./internal.js";

/**
 * Convert a DB row into a KnowledgeCrystal object.
 */
export function rowToCrystal(row: Record<string, unknown>): KnowledgeCrystal {
  const embeddingRaw = row.embedding;
  const embedding =
    typeof embeddingRaw === "string"
      ? parseEmbedding(embeddingRaw)
      : Array.isArray(embeddingRaw)
        ? (embeddingRaw as number[])
        : [];

  let governance: CrystalGovernance;
  try {
    const raw = row.governance_json;
    if (typeof raw === "string" && raw.length > 2) {
      const parsed = JSON.parse(raw);
      governance = {
        accessScope: parsed.accessScope ?? "private",
        lifespanPolicy: parsed.lifespanPolicy ?? "decay",
        ttlMs: parsed.ttlMs,
        priority: parsed.priority ?? 0.5,
        sensitivity: parsed.sensitivity ?? "normal",
        provenanceChain: parsed.provenanceChain ?? [],
      };
    } else {
      governance = defaultGovernance((row.source as MemorySource) ?? "memory");
    }
  } catch {
    governance = defaultGovernance((row.source as MemorySource) ?? "memory");
  }

  let provenanceChain: string[] = [];
  try {
    const raw = row.provenance_chain;
    if (typeof raw === "string" && raw.length > 2) {
      provenanceChain = JSON.parse(raw);
    }
  } catch {
    /* empty */
  }
  governance.provenanceChain = provenanceChain;

  const hormonalDopamine = row.hormonal_dopamine as number | null;
  const hormonalCortisol = row.hormonal_cortisol as number | null;
  const hormonalOxytocin = row.hormonal_oxytocin as number | null;
  const hasHormonal =
    hormonalDopamine !== null || hormonalCortisol !== null || hormonalOxytocin !== null;
  const hormonalInfluence: HormonalInfluence | null = hasHormonal
    ? {
        dopamine: (hormonalDopamine as number) ?? 0,
        cortisol: (hormonalCortisol as number) ?? 0,
        oxytocin: (hormonalOxytocin as number) ?? 0,
      }
    : null;

  return {
    id: row.id as string,
    text: row.text as string,
    embedding,
    path: row.path as string,
    source: (row.source as MemorySource) ?? "memory",
    startLine: (row.start_line as number) ?? 0,
    endLine: (row.end_line as number) ?? 0,
    hash: (row.hash as string) ?? "",
    semanticType: (row.semantic_type as CrystalSemanticType) ?? "general",
    origin: mapOrigin(row),
    lifecycle: mapLifecycle(row),
    version: (row.version as number) ?? 1,
    parentId: (row.parent_id as string) ?? null,
    createdAt: (row.created_at as number) ?? (row.updated_at as number) ?? Date.now(),
    updatedAt: (row.updated_at as number) ?? Date.now(),
    importanceScore: (row.importance_score as number) ?? 1.0,
    accessCount: (row.access_count as number) ?? 0,
    lastAccessedAt: (row.last_accessed_at as number) ?? null,
    emotionalValence: (row.emotional_valence as number) ?? null,
    hormonalInfluence,
    curiosityBoost: (row.curiosity_boost as number) ?? 0,
    dreamCount: (row.dream_count as number) ?? 0,
    lastDreamedAt: (row.last_dreamed_at as number) ?? null,
    governance,
  };
}

/**
 * Convert a KnowledgeCrystal into a flat record for DB insertion.
 */
export function crystalToRow(crystal: KnowledgeCrystal): Record<string, unknown> {
  return {
    id: crystal.id,
    text: crystal.text,
    embedding: JSON.stringify(crystal.embedding),
    path: crystal.path,
    source: crystal.source,
    start_line: crystal.startLine,
    end_line: crystal.endLine,
    hash: crystal.hash,
    semantic_type: crystal.semanticType,
    origin: crystal.origin,
    lifecycle: crystal.lifecycle,
    lifecycle_state: lifecycleToLegacy(crystal.lifecycle),
    memory_type: crystal.semanticType === "skill" ? "skill" : "plaintext",
    version: crystal.version,
    parent_id: crystal.parentId,
    created_at: crystal.createdAt,
    updated_at: crystal.updatedAt,
    importance_score: crystal.importanceScore,
    access_count: crystal.accessCount,
    last_accessed_at: crystal.lastAccessedAt,
    emotional_valence: crystal.emotionalValence,
    hormonal_dopamine: crystal.hormonalInfluence?.dopamine ?? 0,
    hormonal_cortisol: crystal.hormonalInfluence?.cortisol ?? 0,
    hormonal_oxytocin: crystal.hormonalInfluence?.oxytocin ?? 0,
    curiosity_boost: crystal.curiosityBoost,
    dream_count: crystal.dreamCount,
    last_dreamed_at: crystal.lastDreamedAt,
    governance_json: JSON.stringify({
      accessScope: crystal.governance.accessScope,
      lifespanPolicy: crystal.governance.lifespanPolicy,
      ttlMs: crystal.governance.ttlMs,
      priority: crystal.governance.priority,
      sensitivity: crystal.governance.sensitivity,
    }),
    provenance_chain: JSON.stringify(crystal.governance.provenanceChain),
  };
}

/**
 * Infer semantic type from content, source, and origin.
 */
export function inferSemanticType(
  text: string,
  source: MemorySource,
  origin: CrystalOrigin,
): CrystalSemanticType {
  if (source === "skills" || origin === "skill") {
    return "skill";
  }
  if (origin === "dream") {
    return "insight";
  }

  const lower = text.toLowerCase();

  // Preference patterns
  if (/\b(?:prefer|favorite|always use|i like|i want|i need|my style|i choose)\b/i.test(lower)) {
    return "preference";
  }

  // Goal patterns
  if (
    /\b(?:goal|objective|plan to|aim to|intend to|want to achieve|target|milestone)\b/i.test(lower)
  ) {
    return "goal";
  }

  // Task pattern indicators
  if (
    /\b(?:workflow|pipeline|process|step \d|procedure|routine|always do|every time)\b/i.test(lower)
  ) {
    return "task_pattern";
  }

  // Relationship/social
  if (
    /\b(?:team|colleague|manager|friend|partner|client|user|customer|stakeholder)\b/i.test(lower) &&
    /\b(?:works with|reports to|manages|helps|supports|collaborates)\b/i.test(lower)
  ) {
    return "relationship";
  }

  // Episode/event
  if (source === "sessions") {
    return "episode";
  }

  // Fact (default for indexed files)
  if (source === "memory") {
    return "fact";
  }

  return "general";
}

/**
 * Return sensible governance defaults for a given source.
 */
export function defaultGovernance(source: MemorySource): CrystalGovernance {
  if (source === "skills") {
    return {
      accessScope: "shared",
      lifespanPolicy: "permanent",
      priority: 0.8,
      sensitivity: "normal",
      provenanceChain: [],
    };
  }
  if (source === "sessions") {
    return {
      accessScope: "private",
      lifespanPolicy: "decay",
      priority: 0.5,
      sensitivity: "personal",
      provenanceChain: [],
    };
  }
  return {
    accessScope: "private",
    lifespanPolicy: "decay",
    priority: 0.5,
    sensitivity: "normal",
    provenanceChain: [],
  };
}

// ── Internal helpers ──

function mapOrigin(row: Record<string, unknown>): CrystalOrigin {
  const origin = row.origin as string | null;
  if (
    origin === "indexed" ||
    origin === "session" ||
    origin === "skill" ||
    origin === "dream" ||
    origin === "user_input" ||
    origin === "inferred"
  ) {
    return origin;
  }
  // Map legacy origins
  if (origin === "dream_synthesis") {
    return "dream";
  }
  if (origin === "crystallized") {
    return "skill";
  }
  if (origin === "curiosity_probe") {
    return "inferred";
  }
  return "indexed";
}

function mapLifecycle(row: Record<string, unknown>): CrystalLifecycle {
  // Prefer new 'lifecycle' column if it exists
  const lifecycle = row.lifecycle as string | null;
  if (lifecycle && lifecycle !== "generated") {
    if (
      lifecycle === "generated" ||
      lifecycle === "activated" ||
      lifecycle === "consolidated" ||
      lifecycle === "archived" ||
      lifecycle === "expired" ||
      lifecycle === "frozen"
    ) {
      return lifecycle;
    }
  }

  // Fall back to legacy lifecycle_state
  const state = (row.lifecycle_state as string) ?? "active";
  const memoryType = (row.memory_type as string) ?? "plaintext";

  if (memoryType === "skill") {
    return "frozen";
  }
  if (state === "forgotten") {
    return "expired";
  }
  if (state === "archived") {
    return "archived";
  }
  if (state === "consolidating") {
    return "consolidated";
  }

  // 'active' — check importance to differentiate generated vs activated
  const importance = (row.importance_score as number) ?? 1.0;
  if (importance >= 0.8) {
    return "activated";
  }
  return "generated";
}

function lifecycleToLegacy(lifecycle: CrystalLifecycle): string {
  switch (lifecycle) {
    case "generated":
    case "activated":
      return "active";
    case "consolidated":
      return "consolidating";
    case "archived":
      return "archived";
    case "expired":
      return "forgotten";
    case "frozen":
      return "active";
    default:
      return "active";
  }
}
