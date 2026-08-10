/**
 * Canonical skill-key derivation for skill crystals (audit 2026-08-09, F12).
 *
 * `chunks.skill_category` is the join key that groups 0..N crystals under one
 * skill for skills.metrics, skill_lifecycle, and the marketplace rollups. The
 * bootstrap sets it to the skill folder name, but the peer-ingest paths and
 * the dream refiner historically left it NULL, making every non-bootstrap
 * crystal invisible to those surfaces. This module is the single place that
 * derives the key, used by all creation paths and the v57 backfill migration.
 */
import type { DatabaseSync } from "node:sqlite";

/**
 * Forage response envelopes are named `response-<8-hex-request-id>-<skill>`;
 * the response is an execution/variant OF the skill, so it groups under the
 * skill's own key.
 */
const RESPONSE_PREFIX = /^response-[0-9a-f]{8}-/i;

/** Trim a candidate key and strip the forage response prefix. */
export function normalizeSkillKey(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) {
    return null;
  }
  const stripped = trimmed.replace(RESPONSE_PREFIX, "");
  return stripped || null;
}

/**
 * Derive the skill key from crystal content: the frontmatter `name:` line if
 * present, else the (normalized) fallback name — typically the envelope name
 * or the path basename.
 */
export function skillCategoryFromContent(
  text: string | null | undefined,
  fallbackName?: string | null,
): string | null {
  if (text) {
    const m = /^name:\s*(\S+)/m.exec(text.slice(0, 2000));
    const fromFrontmatter = normalizeSkillKey(m?.[1]);
    if (fromFrontmatter) {
      return fromFrontmatter;
    }
  }
  return normalizeSkillKey(fallbackName);
}

/**
 * One-time heal for existing rows (migration v57). Resolution order per
 * crystal: own frontmatter name → nearest categorized ancestor via parent_id
 * (iterated to a fixpoint, so a dream-mutation chain inherits from the peer
 * crystal at its root) → stable_skill_id → path basename. Row order is not
 * guaranteed parent-before-child, hence the fixpoint loop rather than one pass.
 */
export function backfillSkillCategories(db: DatabaseSync): {
  updated: number;
  unresolved: number;
} {
  const rows = db
    .prepare(
      `SELECT id, parent_id, stable_skill_id, path, skill_category,
              substr(text, 1, 2000) AS text
       FROM chunks
       WHERE COALESCE(memory_type, '') = 'skill'
          OR COALESCE(semantic_type, '') = 'skill'`,
    )
    .all() as unknown as Array<{
    id: string;
    parent_id: string | null;
    stable_skill_id: string | null;
    path: string | null;
    skill_category: string | null;
    text: string | null;
  }>;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const update = db.prepare(`UPDATE chunks SET skill_category = ? WHERE id = ?`);
  let updated = 0;

  const apply = (row: (typeof rows)[number], category: string) => {
    row.skill_category = category;
    update.run(category, row.id);
    updated++;
  };

  // Pass 1: derive from the crystal's own content.
  for (const row of rows) {
    if (row.skill_category) continue;
    const direct = skillCategoryFromContent(row.text);
    if (direct) apply(row, direct);
  }

  // Pass 2: inherit down parent chains until nothing changes.
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 32) {
    changed = false;
    for (const row of rows) {
      if (row.skill_category || !row.parent_id) continue;
      const inherited = byId.get(row.parent_id)?.skill_category;
      if (inherited) {
        apply(row, inherited);
        changed = true;
      }
    }
  }

  // Pass 3: lineage id / path basename so metrics can still group the row.
  let unresolved = 0;
  for (const row of rows) {
    if (row.skill_category) continue;
    const fallback =
      normalizeSkillKey(row.stable_skill_id) ?? normalizeSkillKey(row.path?.split("/").pop());
    if (fallback) {
      apply(row, fallback);
    } else {
      unresolved++;
    }
  }

  return { updated, unresolved };
}
