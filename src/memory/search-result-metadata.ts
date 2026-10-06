import type { DatabaseSync } from "node:sqlite";

/**
 * Give merged search results the fields the post-fusion boosts key on: the
 * memory's semantic type (mood-congruent bonus), epistemic layer (how fast it
 * ages) and creation time (its age). The search channels do not select them,
 * so without this the mood bonus never saw a type, every result aged at the
 * default rate, and age was measured from "now". One query for the whole set.
 */
export function attachResultMetadata(
  db: DatabaseSync,
  merged: Array<{ id: string; updatedAt?: number | null }>,
): void {
  if (merged.length === 0) {
    return;
  }
  try {
    const ids = merged.map((e) => e.id);
    const rows = db
      .prepare(
        `SELECT id, semantic_type, epistemic_layer, created_at FROM chunks WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as unknown as Array<{
      id: string;
      semantic_type: string | null;
      epistemic_layer: string | null;
      created_at: number | null;
    }>;
    const meta = new Map(rows.map((r) => [r.id, r]));
    for (const entry of merged) {
      const m = meta.get(entry.id);
      if (m) {
        Object.assign(entry, {
          semanticType: m.semantic_type,
          epistemicLayer: m.epistemic_layer,
          createdAt: m.created_at ?? entry.updatedAt ?? undefined,
        });
      }
    }
  } catch {
    // Missing columns on an old index: the boosts fall back to their defaults.
  }
}
