/**
 * Multi-Resolution Skill Hierarchy: computes 4-level hierarchy from
 * multi-perspective embeddings for O(1) capability checks and
 * resolution-adaptive queries.
 */

import type { DatabaseSync } from "node:sqlite";
import type { SkillHierarchy, DomainProfile, MultiPerspectiveEmbedding } from "./crystal-types.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/skill-hierarchy");

/**
 * Compute the 4-level hierarchy from multi-perspective embeddings.
 *
 * Level 0: Raw 4-perspective embedding similarities (against a reference corpus)
 * Level 1: 6 groups rolled up from perspectives
 * Level 2: 3 domains (Factual, Procedural, Affective)
 * Level 3: Single overall capability score
 */
export function computeHierarchy(
  perspectiveEmbeddings: MultiPerspectiveEmbedding,
  referenceCentroids?: {
    semantic?: number[];
    procedural?: number[];
    causal?: number[];
    entity?: number[];
  },
): SkillHierarchy {
  // Level 0: raw perspective scores
  // If we have reference centroids, compute similarity; otherwise use embedding norms
  const level0: number[] = [];
  for (const perspective of ["semantic", "procedural", "causal", "entity"] as const) {
    const emb = perspectiveEmbeddings[perspective];
    if (emb.length === 0) {
      level0.push(0);
      continue;
    }
    const ref = referenceCentroids?.[perspective];
    if (ref && ref.length > 0) {
      level0.push(Math.max(0, cosineSimilarity(emb, ref)));
    } else {
      // Self-score: use L2 norm as a proxy for embedding quality
      const norm = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
      level0.push(Math.min(1, norm));
    }
  }

  const [semScore, procScore, causScore, entScore] = level0 as [number, number, number, number];

  // Level 1: 6 groups
  const level1 = {
    factual: semScore * 0.6 + entScore * 0.4,
    temporal: procScore * 0.7 + causScore * 0.3,
    causal: causScore * 0.7 + semScore * 0.3,
    relational: entScore * 0.5 + semScore * 0.3 + causScore * 0.2,
    qualitative: semScore * 0.5 + causScore * 0.3 + procScore * 0.2,
    implementation: procScore * 0.6 + entScore * 0.4,
  };

  // Level 2: 3 domains
  const level2: DomainProfile = {
    factual: (level1.factual + level1.relational) / 2,   // What
    procedural: (level1.temporal + level1.implementation) / 2, // How
    affective: (level1.causal + level1.qualitative) / 2,      // Why
  };

  // Level 3: weighted average
  const level3 = level2.factual * 0.3 + level2.procedural * 0.4 + level2.affective * 0.3;

  return { level3, level2, level1, level0 };
}

/**
 * Fast capability check: does the agent have skills in a given category?
 * Returns 0-1 capability score without needing embeddings.
 */
export function quickCapabilityCheck(
  db: DatabaseSync,
  category: string,
): number {
  const rows = db
    .prepare(
      `SELECT skill_hierarchy FROM chunks
       WHERE skill_category = ?
         AND COALESCE(deprecated, 0) = 0
         AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
         AND skill_hierarchy IS NOT NULL
       LIMIT 20`,
    )
    .all(category) as Array<{ skill_hierarchy: string }>;

  if (rows.length === 0) return 0;

  let totalScore = 0;
  let counted = 0;
  for (const row of rows) {
    try {
      const hierarchy: SkillHierarchy = JSON.parse(row.skill_hierarchy);
      totalScore += hierarchy.level3;
      counted++;
    } catch {}
  }

  return counted > 0 ? totalScore / counted : 0;
}

/**
 * Get the version history for a stable skill ID.
 */
export function getVersionHistory(
  db: DatabaseSync,
  stableSkillId: string,
): Array<{ crystalId: string; version: number; createdAt: number; deprecated: boolean }> {
  const rows = db
    .prepare(
      `SELECT id, skill_version, created_at, deprecated FROM chunks
       WHERE stable_skill_id = ?
       ORDER BY skill_version ASC`,
    )
    .all(stableSkillId) as Array<{
      id: string;
      skill_version: number;
      created_at: number;
      deprecated: number;
    }>;

  return rows.map((r) => ({
    crystalId: r.id,
    version: r.skill_version,
    createdAt: r.created_at,
    deprecated: r.deprecated === 1,
  }));
}

/**
 * Get the latest non-deprecated version of a stable skill.
 */
export function getLatestVersion(
  db: DatabaseSync,
  stableSkillId: string,
): { crystalId: string; version: number } | null {
  const row = db
    .prepare(
      `SELECT id, skill_version FROM chunks
       WHERE stable_skill_id = ?
         AND COALESCE(deprecated, 0) = 0
       ORDER BY skill_version DESC
       LIMIT 1`,
    )
    .get(stableSkillId) as { id: string; skill_version: number } | undefined;

  if (!row) return null;
  return { crystalId: row.id, version: row.skill_version };
}

/**
 * Store computed hierarchy on a crystal.
 */
export function storeHierarchy(
  db: DatabaseSync,
  crystalId: string,
  hierarchy: SkillHierarchy,
): void {
  db.prepare(`UPDATE chunks SET skill_hierarchy = ? WHERE id = ?`).run(
    JSON.stringify(hierarchy),
    crystalId,
  );
}
