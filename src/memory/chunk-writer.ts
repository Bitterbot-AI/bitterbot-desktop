/**
 * PLAN-46 Phase 0: the single write path for the `chunks` table.
 *
 * `chunks` is a 72-column table written by ~20 subsystems. Before this module,
 * each issued its own `UPDATE chunks SET ...`, so writes to shared columns
 * (lifecycle, provenance, the reward/importance scalars) could clobber each
 * other with no ownership, and every subsystem had to know the schema. The
 * 2026-09-07 memory audit traced a real divergence bug to exactly this (the
 * lifecycle / lifecycle_state columns).
 *
 * Every write to `chunks` goes through a scoped function here. Each function
 * names only the columns its subsystem owns, so a write can never silently
 * touch another subsystem's column. `scripts/check-chunk-writes.mjs` fails the
 * lint on any raw `UPDATE chunks` / `INSERT INTO chunks` outside this module and
 * the migration runner.
 *
 * Invariant I1 (PLAN-46 §3): one write path.
 */

import type { DatabaseSync } from "node:sqlite";

type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Build and run a scoped `UPDATE chunks SET <fields> WHERE id = ?`. Only the
 * provided (non-undefined) fields are written; the column allow-list is the set
 * of keys the caller passes, so a cluster function can only ever write its own
 * columns. Returns the number of rows changed.
 */
function updateFields(
  db: DatabaseSync,
  id: string,
  fields: Record<string, SqlValue | undefined>,
): number {
  const cols = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (cols.length === 0) {
    return 0;
  }
  const set = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => fields[c] as SqlValue);
  const res = db.prepare(`UPDATE chunks SET ${set} WHERE id = ?`).run(...values, id);
  return Number(res.changes);
}

// ── Lifecycle (the tangled cluster the audit's C1 bug lived in) ──────────────

// Two columns, two vocabularies, one concept (kept for migration history).
// `lifecycle` is the fine-grained state machine; `lifecycle_state` is the
// coarse retrieval gate. They are NOT a bijection (a merge loser is
// `archived` + `forgotten`), so a read that means "is this chunk live?" must
// check BOTH, and only with each column's own vocabulary. Use
// liveChunkPredicate() rather than writing the check by hand: the skill
// resolver once tested lifecycle_state for "expired", a value only `lifecycle`
// can hold, so the filter matched nothing and returned expired skills (Agent Memory Atlas review,
// 2026-09-19). lifecycle-vocabulary.test.ts fails on any SQL that compares a
// column with the other column's vocabulary.
export type LifecycleState = "active" | "archived" | "consolidated" | "forgotten";
export const LIFECYCLE_STATE_VALUES: readonly LifecycleState[] = [
  "active",
  "archived",
  "consolidated",
  "forgotten",
];
export type Lifecycle =
  | "generated"
  | "activated"
  | "frozen"
  | "consolidated"
  | "archived"
  | "expired";
export const LIFECYCLE_VALUES: readonly Lifecycle[] = [
  "generated",
  "activated",
  "frozen",
  "consolidated",
  "archived",
  "expired",
];

/**
 * SQL condition: the chunk is live (neither forgotten nor expired). NULL in
 * either column means "not set" and stays live; `col <> 'x'` alone would drop
 * those rows under three-valued logic.
 */
export function liveChunkPredicate(alias?: string): string {
  const a = alias ? `${alias}.` : "";
  return (
    `(${a}lifecycle_state IS NULL OR ${a}lifecycle_state <> 'forgotten') ` +
    `AND (${a}lifecycle IS NULL OR ${a}lifecycle <> 'expired')`
  );
}

/**
 * Set lifecycle. `lifecycle` and `lifecycle_state` are kept consistent: if you
 * set one, derive the other unless you pass it explicitly. This is the single
 * place that reconciles the two columns (audit C1).
 */
export function setChunkLifecycle(
  db: DatabaseSync,
  id: string,
  opts: {
    lifecycle?: Lifecycle;
    lifecycleState?: LifecycleState;
    parentId?: string | null;
    hygieneDone?: boolean;
    lastConsolidatedAt?: number;
    bumpVersion?: boolean;
    updatedAt?: number;
  },
): number {
  const derived = opts.lifecycleState ?? deriveLifecycleState(opts.lifecycle);
  const fields: Record<string, SqlValue | undefined> = {
    lifecycle: opts.lifecycle ?? deriveLifecycle(opts.lifecycleState),
    lifecycle_state: derived,
    parent_id: opts.parentId,
    hygiene_done: opts.hygieneDone === undefined ? undefined : opts.hygieneDone ? 1 : 0,
    last_consolidated_at: opts.lastConsolidatedAt,
    updated_at: opts.updatedAt,
  };
  const cols = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (opts.bumpVersion) {
    const set = [...cols.map((c) => `${c} = ?`), "version = COALESCE(version, 1) + 1"].join(", ");
    const values = cols.map((c) => fields[c] as SqlValue);
    return Number(db.prepare(`UPDATE chunks SET ${set} WHERE id = ?`).run(...values, id).changes);
  }
  return updateFields(db, id, fields);
}

/** The lifecycle_state that corresponds to a lifecycle value (audit C1). */
export function deriveLifecycleState(lifecycle: Lifecycle | undefined): LifecycleState | undefined {
  switch (lifecycle) {
    case undefined:
      return undefined;
    case "consolidated":
      return "consolidated";
    case "archived":
      return "archived";
    // Expired = scheduled for purge, which is what `forgotten` means on the
    // coarse axis. Mapping it to `archived` (as before) made a forgotten chunk
    // that round-tripped through `lifecycle` come back merely archived.
    case "expired":
      return "forgotten";
    case "generated":
    case "activated":
    case "frozen":
      return "active";
  }
}

/**
 * The lifecycle for a lifecycle_state, when a caller sets only the coarse
 * state. Undefined for `active`: which active sub-state applies (generated /
 * activated / frozen) is not derivable, so the existing value is kept.
 */
export function deriveLifecycle(state: LifecycleState | undefined): Lifecycle | undefined {
  switch (state) {
    case "forgotten":
      return "expired";
    case "archived":
      return "archived";
    case "consolidated":
      return "consolidated";
    case "active":
    case undefined:
      return undefined;
  }
}

// ── Retrieval / ranking ──────────────────────────────────────────────────────

export function bumpChunkAccess(db: DatabaseSync, id: string, now = Date.now()): number {
  return Number(
    db
      .prepare(
        `UPDATE chunks SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      )
      .run(now, id).changes,
  );
}

export function setChunkImportance(
  db: DatabaseSync,
  id: string,
  fields: { importanceScore?: number; semanticType?: string; lifecycle?: Lifecycle },
): number {
  return updateFields(db, id, {
    importance_score: fields.importanceScore,
    semantic_type: fields.semanticType,
    lifecycle: fields.lifecycle,
    lifecycle_state: deriveLifecycleState(fields.lifecycle),
  });
}

export function setChunkSpacing(
  db: DatabaseSync,
  id: string,
  fields: { accessTimestamps?: string; spacingScore?: number },
): number {
  return updateFields(db, id, {
    access_timestamps: fields.accessTimestamps,
    spacing_score: fields.spacingScore,
  });
}

// ── Reward scalars (shared: audit C2 double-decay lived adjacent) ────────────

export function decayChunkSteeringRewards(db: DatabaseSync, factor: number): number {
  return Number(
    db
      .prepare(
        `UPDATE chunks SET steering_reward = steering_reward * ? WHERE steering_reward IS NOT NULL`,
      )
      .run(factor).changes,
  );
}

export function setChunkCuriosityReward(db: DatabaseSync, id: string, reward: number): number {
  return updateFields(db, id, { curiosity_reward: reward });
}

// ── Dream ────────────────────────────────────────────────────────────────────

export function bumpChunkDreamCount(db: DatabaseSync, ids: string[], now = Date.now()): number {
  if (ids.length === 0) {
    return 0;
  }
  const placeholders = ids.map(() => "?").join(",");
  return Number(
    db
      .prepare(
        `UPDATE chunks SET dream_count = COALESCE(dream_count, 0) + 1, last_dreamed_at = ? WHERE id IN (${placeholders})`,
      )
      .run(now, ...ids).changes,
  );
}

// ── Provenance / trust (shared: 6 writers touched provenance_chain) ──────────

export function setChunkProvenance(
  db: DatabaseSync,
  id: string,
  fields: {
    provenanceChain?: string | null;
    provenanceDag?: string | null;
    governanceJson?: string | null;
  },
): number {
  return updateFields(db, id, {
    provenance_chain: fields.provenanceChain,
    provenance_dag: fields.provenanceDag,
    governance_json: fields.governanceJson,
  });
}

export function setChunkSessionTrust(db: DatabaseSync, id: string, trust: string): number {
  return updateFields(db, id, { session_trust: trust });
}

// ── Reconsolidation ──────────────────────────────────────────────────────────

export function setChunkLabile(db: DatabaseSync, id: string, labileUntil: number | null): number {
  return updateFields(db, id, { labile_until: labileUntil });
}

// ── Open loop (Zeigarnik) ─────────────────────────────────────────────────────

export function setChunkOpenLoop(
  db: DatabaseSync,
  id: string,
  open: boolean,
  context: string | null,
): number {
  return updateFields(db, id, {
    open_loop: open ? 1 : 0,
    open_loop_context: open ? context : null,
  });
}

// ── Embedding ──────────────────────────────────────────────────────────────────

export function setChunkEmbedding(
  db: DatabaseSync,
  id: string,
  embedding: Uint8Array,
  fields: {
    model?: string;
    updatedAt?: number;
    provenanceChain?: string;
    governanceJson?: string;
  } = {},
): number {
  return updateFields(db, id, {
    embedding,
    model: fields.model,
    updated_at: fields.updatedAt,
    provenance_chain: fields.provenanceChain,
    governance_json: fields.governanceJson,
  });
}

/**
 * The owner edited a memory's text (PLAN-53 G1). The embedding is cleared and
 * the model marked "pending" so the embedding backfill re-embeds it; the
 * caller replaces the keyword-index row and drops the vector row.
 */
export function setChunkText(
  db: DatabaseSync,
  id: string,
  fields: { text: string; hash: string; updatedAt: number; version: number },
): number {
  return updateFields(db, id, {
    text: fields.text,
    hash: fields.hash,
    model: "pending",
    embedding: new Uint8Array(0),
    updated_at: fields.updatedAt,
    version: fields.version,
  });
}

// ── Skills ──────────────────────────────────────────────────────────────────

export function setChunkSkillCategory(db: DatabaseSync, id: string, category: string): number {
  return updateFields(db, id, { skill_category: category });
}

export function setChunkSkillHierarchy(db: DatabaseSync, id: string, hierarchy: string): number {
  return updateFields(db, id, { skill_hierarchy: hierarchy });
}

// ── Marketplace / bounty / commerce ──────────────────────────────────────────

export function setChunkMarketplace(
  db: DatabaseSync,
  id: string,
  fields: {
    marketplaceListed?: boolean;
    marketplaceDescription?: string | null;
    publishVisibility?: string;
    publishedAt?: number | null;
    forSale?: boolean;
    bountyMatchId?: string | null;
    bountyPriorityBoost?: number | null;
    provenanceChain?: string;
  },
): number {
  return updateFields(db, id, {
    marketplace_listed:
      fields.marketplaceListed === undefined ? undefined : fields.marketplaceListed ? 1 : 0,
    marketplace_description: fields.marketplaceDescription,
    publish_visibility: fields.publishVisibility,
    published_at: fields.publishedAt,
    for_sale: fields.forSale === undefined ? undefined : fields.forSale ? 1 : 0,
    bounty_match_id: fields.bountyMatchId,
    bounty_priority_boost: fields.bountyPriorityBoost,
    provenance_chain: fields.provenanceChain,
  });
}

export function incrementChunkDownloadCount(db: DatabaseSync, id: string): number {
  return Number(
    db
      .prepare(`UPDATE chunks SET download_count = COALESCE(download_count, 0) + 1 WHERE id = ?`)
      .run(id).changes,
  );
}

// ── Bitemporal ────────────────────────────────────────────────────────────────

export function setChunkValidTimeEnd(db: DatabaseSync, id: string, validTimeEnd: number): number {
  return updateFields(db, id, { valid_time_end: validTimeEnd });
}
