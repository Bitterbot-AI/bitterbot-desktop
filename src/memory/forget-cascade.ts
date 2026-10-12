/**
 * PLAN-55 Phase 3 (G5): what else goes when the owner forgets a memory.
 *
 * A memory is not only a row in `chunks`. Facts in the ledger cite it as
 * evidence, knowledge-graph links cite it, dream insights were drawn from it
 * (and some of those were promoted into searchable `dream_insight_*`
 * memories of their own), a curiosity finding may have become it, a learned
 * preference may cite it, and the dream-utility funnel may count it. Before
 * this module a forget deleted the row and left every one of those pointing
 * at nothing, still in force.
 *
 * Two steps, so the owner can see the cut before it is made:
 *
 * 1. planForgetCascade() reads (never writes) and returns the plan: what
 *    each of those stores would lose, and a `hash` over the plan. It yields
 *    to the event loop between windows of rows, so a preview over the live
 *    database does not starve the gateway.
 * 2. applyForgetCascade() writes the plan. A plan of up to APPLY_BATCH
 *    operations (every single-memory forget or edit) is applied in ONE
 *    transaction together with the chunk deletion, the suppression and the
 *    audit entry: all of it or none of it. A larger plan (a deleted session
 *    with hundreds of chunks) is applied in ordered batches, one
 *    transaction each, yielding between them: derived rows first, the
 *    chunk deletions last. A transaction is never held open across a yield
 *    (another writer on the same connection would join it), and a batch
 *    that fails leaves the chunks in place, so running the cascade again
 *    picks up exactly what is left.
 *
 * The rules (also in docs/memory/controls.md):
 *
 * - A fact whose evidence set becomes empty is retired with reason
 *   `evidence_removed` (never deleted; it keeps its history). A fact with
 *   an evidence ref that is not a forgotten transcript (a URL, a quote, a
 *   line in another conversation) still has evidence and is kept. The
 *   retire is bound to the planned row: a fact pinned again (or at the
 *   owner tier) between the plan and the apply is skipped and reported in
 *   `retireSkipped`. An owner-tier
 *   fact is never retired by the cascade: it loses the evidence id and is
 *   listed (`ownerKept`) so the owner can decide. A fact with other live
 *   evidence keeps it and loses only the forgotten id. Rows that are already
 *   history (superseded, retired) only lose the id.
 * - Edit: a fact citing the old memory is moved to the new one when its
 *   value is still in the new text (whole words, case and punctuation
 *   aside); otherwise it goes through the evidence-empty rule.
 * - A knowledge-graph link left with no evidence is closed (bitemporal:
 *   `valid_until` set, kept in the belief history with action
 *   `evidence_removed`); one with other evidence loses the id. On an edit a
 *   link whose two endpoint names are both in the new text moves to it.
 * - A dream insight drawn from a forgotten memory is flagged
 *   (`stale_fact`: forgotten_evidence), which keeps it from ever being
 *   promoted; a `dream_insight_*` memory promoted from it, or citing a
 *   forgotten memory directly, is forgotten too.
 * - A curiosity finding that became the memory loses its chunk id (moves to
 *   the new memory on an edit). A preference loses the id from its evidence
 *   (moves on an edit). Dream-utility rows for the memory are deleted.
 * - Session deletion (mode `session`): a fact whose evidence line ref
 *   points into the deleted transcript counts as evidence from it, so a
 *   fact captured from that conversation with no other evidence is retired.
 *
 * Every retire goes through CanonicalFactsStore.retire(), so
 * `canonical:changed` fires and the Phase 2 followers run after the commit.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalSourceTier,
  type CanonicalFactsStore,
  OWNER_TRUST_TIER,
} from "./canonical-facts.js";
import { parseInsightNotes, type InsightStaleNote } from "./canonical-supersede-insights.js";
import { yieldToEventLoop } from "./event-loop.js";
import {
  addSuppression,
  chunkTextHash,
  inSavepoint,
  isShortSessionText,
  normalizeLoose,
  sessionChunkSuppressionHash,
} from "./memory-suppressions.js";

/** Rows read per window while planning; a yield follows every window. */
export const PLAN_WINDOW_ROWS = 1000;
/** Writes per transaction when a plan is too big for one. */
export const APPLY_BATCH = 500;

export type CascadeMode = "forget" | "edit" | "session";

export type CascadeChunk = {
  id: string;
  /** `own`: the agent's own memory; `session`: indexed from a transcript; `derived`: a promoted insight. */
  kind: "own" | "session" | "derived";
  /** Loose-normalised text hash (the suppression hash). */
  textHash: string;
  /**
   * A transcript passage too short to suppress by its text alone
   * (isShortSessionText): its transcript path, so the suppression is bound
   * to that transcript only. Unset otherwise.
   */
  sessionPath?: string;
};

export type CascadeFact = {
  id: string;
  key: string;
  value: string;
  source: string;
  status: string;
  /** The key's current row (valid_until IS NULL). */
  current: boolean;
};

export type CascadeFactRewrite = CascadeFact & { evidence: string[] };

export type ForgetCascadePlan = {
  mode: CascadeMode;
  chunks: CascadeChunk[];
  facts: {
    /** Current, active, below the owner tier, nothing left to stand on: retired. */
    retire: CascadeFactRewrite[];
    /** Owner tier, nothing left to stand on: kept active, listed for the owner. */
    ownerKept: CascadeFactRewrite[];
    /** Other evidence survives (or the row is history): the forgotten ids are removed. */
    strip: CascadeFactRewrite[];
    /** Edit: the value is still in the new text; evidence moves to the new memory. */
    relink: CascadeFactRewrite[];
  };
  edges: {
    close: Array<{ id: string; evidence: string[] }>;
    strip: Array<{ id: string; evidence: string[] }>;
    relink: Array<{ id: string; evidence: string[] }>;
  };
  /** dream_insights ids to flag, with the forgotten source ids each rests on. */
  insights: Array<{ id: string; chunkIds: string[] }>;
  curiosityFindings: Array<{ id: string; chunkId: string; to: string | null }>;
  preferences: Array<{ id: string; category: string; key: string; evidence: string[] }>;
  /** dream_utility row ids to delete. */
  dreamUtility: string[];
  counts: CascadeCounts;
  hash: string;
};

export type CascadeCounts = {
  chunks: number;
  derivedChunks: number;
  factsRetired: number;
  ownerFactsKept: number;
  factsEvidenceStripped: number;
  factsRelinked: number;
  edgesClosed: number;
  edgesStripped: number;
  edgesRelinked: number;
  insightsFlagged: number;
  curiosityFindings: number;
  preferences: number;
  dreamUtility: number;
};

export type CascadeTargets = {
  mode: CascadeMode;
  /** `path`: the chunk's indexed path (a transcript memory's `sessions/<file>`). */
  chunks: Array<{ id: string; text: string; kind: "own" | "session"; path?: string | null }>;
  /** Edit only: the memory that replaces the forgotten one. */
  replacement?: { id: string; text: string };
  /** Session only: the deleted transcripts (absolute paths). */
  sessionFiles?: string[];
};

const parseIds = (raw: unknown): string[] => {
  if (typeof raw !== "string" || raw === "" || raw === "[]") {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const tableExists = (db: DatabaseSync, table: string): boolean => {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
    );
  } catch {
    return false;
  }
};

/** Whole-word containment after loose normalisation ("api.acme.com" in "use api acme com"). */
export function textStatesValue(text: string, value: string): boolean {
  const v = normalizeLoose(value);
  if (!v) {
    return false;
  }
  return ` ${normalizeLoose(text)} `.includes(` ${v} `);
}

/** The transcript file a `session:<path>[#L<n>]` evidence ref points at, or null. */
export function sessionRefFile(ref: string | null | undefined): string | null {
  if (!ref || !ref.startsWith("session:")) {
    return null;
  }
  const body = ref.slice("session:".length).replace(/#L\d+$/, "");
  return body ? path.basename(body) : null;
}

/**
 * Page through a table by rowid, handing each window to `visit`, yielding
 * after every window. `sql` selects `rowid AS rid, ...` with `rowid > ?` and
 * `LIMIT ?` placeholders, in that order.
 */
async function scanWindows<T extends { rid: number }>(
  db: DatabaseSync,
  sql: string,
  visit: (rows: T[]) => void,
): Promise<void> {
  const stmt = db.prepare(sql);
  let after = 0;
  for (;;) {
    const rows = stmt.all(after, PLAN_WINDOW_ROWS) as unknown as T[];
    if (rows.length === 0) {
      return;
    }
    visit(rows);
    after = rows[rows.length - 1]!.rid;
    await yieldToEventLoop();
    if (rows.length < PLAN_WINDOW_ROWS) {
      return;
    }
  }
}

/** Which of `ids` still exist as chunks (and are not being removed). */
function liveIds(db: DatabaseSync, ids: string[], removed: Set<string>): string[] {
  const candidates = [...new Set(ids)].filter((id) => !removed.has(id));
  if (candidates.length === 0) {
    return [];
  }
  const live = new Set<string>();
  for (let i = 0; i < candidates.length; i += 200) {
    const slice = candidates.slice(i, i + 200);
    const rows = db
      .prepare(`SELECT id FROM chunks WHERE id IN (${slice.map(() => "?").join(",")})`)
      .all(...slice) as Array<{ id: string }>;
    for (const r of rows) {
      live.add(r.id);
    }
  }
  return candidates.filter((id) => live.has(id));
}

export function emptyCounts(): CascadeCounts {
  return {
    chunks: 0,
    derivedChunks: 0,
    factsRetired: 0,
    ownerFactsKept: 0,
    factsEvidenceStripped: 0,
    factsRelinked: 0,
    edgesClosed: 0,
    edgesStripped: 0,
    edgesRelinked: 0,
    insightsFlagged: 0,
    curiosityFindings: 0,
    preferences: 0,
    dreamUtility: 0,
  };
}

/** sha256 over the plan's decisions (ids and the evidence each row ends with), order-independent. */
export function hashCascadePlan(plan: Omit<ForgetCascadePlan, "hash" | "counts">): string {
  const ids = <T extends { id: string }>(xs: T[], extra?: (x: T) => string) =>
    xs.map((x) => (extra ? `${x.id}=${extra(x)}` : x.id)).toSorted();
  const ev = (x: { evidence: string[] }) => x.evidence.toSorted().join(",");
  const canonical = {
    mode: plan.mode,
    chunks: plan.chunks
      .map((c) => `${c.kind}:${c.id}:${c.textHash}${c.sessionPath ? `@${c.sessionPath}` : ""}`)
      .toSorted(),
    retire: ids(plan.facts.retire),
    ownerKept: ids(plan.facts.ownerKept),
    strip: ids(plan.facts.strip, ev),
    relink: ids(plan.facts.relink, ev),
    close: ids(plan.edges.close),
    edgeStrip: ids(plan.edges.strip, ev),
    edgeRelink: ids(plan.edges.relink, ev),
    insights: ids(plan.insights, (x) => x.chunkIds.toSorted().join(",")),
    curiosity: ids(plan.curiosityFindings, (x) => String(x.to)),
    preferences: ids(plan.preferences, ev),
    dreamUtility: plan.dreamUtility.toSorted(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Compute what forgetting `targets` would change. Read-only; yields between
 * windows. The caller has already checked that the targets may be forgotten.
 */
export async function planForgetCascade(
  db: DatabaseSync,
  targets: CascadeTargets,
): Promise<ForgetCascadePlan> {
  const removed = new Set(targets.chunks.map((c) => c.id));
  const chunks: CascadeChunk[] = targets.chunks.map((c) => ({
    id: c.id,
    kind: c.kind,
    textHash: chunkTextHash(c.text),
    ...(c.kind === "session" && c.path && isShortSessionText(c.text)
      ? { sessionPath: c.path }
      : {}),
  }));
  const replacement = targets.replacement ?? null;
  const sessionFiles = new Set((targets.sessionFiles ?? []).map((f) => path.basename(f)));

  // 1. Dream insights drawn from a forgotten memory.
  const insights: ForgetCascadePlan["insights"] = [];
  if (tableExists(db, "dream_insights")) {
    await scanWindows<{ rid: number; id: string; source_chunk_ids: string | null }>(
      db,
      `SELECT rowid AS rid, id, source_chunk_ids FROM dream_insights
        WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      (rows) => {
        for (const row of rows) {
          const hit = parseIds(row.source_chunk_ids).filter((id) => removed.has(id));
          if (hit.length > 0) {
            insights.push({ id: row.id, chunkIds: hit });
          }
        }
      },
    );
  }

  // 2. Promoted insight memories derived from those insights, or citing a
  //    forgotten memory directly. They are forgotten with it.
  const flagged = new Set(insights.map((i) => i.id));
  {
    // A primary-key range, not LIKE: LIKE cannot use the index and would
    // scan the whole chunks table in one synchronous statement.
    const page = db.prepare(
      `SELECT id, text, evidence_refs FROM chunks
        WHERE id > ? AND id < ? ORDER BY id LIMIT ?`,
    );
    let after = "dream_insight_";
    for (;;) {
      // "`" sorts right after "_", so this is every id starting dream_insight_.
      const rows = page.all(after, "dream_insight`", PLAN_WINDOW_ROWS) as unknown as Array<{
        id: string;
        text: string;
        evidence_refs: string | null;
      }>;
      for (const row of rows) {
        if (removed.has(row.id) || !row.evidence_refs) {
          continue;
        }
        let refs: unknown;
        try {
          refs = JSON.parse(row.evidence_refs);
        } catch {
          continue;
        }
        if (!Array.isArray(refs)) {
          continue;
        }
        const derived = refs.some((r) => {
          if (!r || typeof r !== "object") {
            return false;
          }
          const { insightId, sourceId } = r as { insightId?: unknown; sourceId?: unknown };
          return (
            (typeof insightId === "string" && flagged.has(insightId)) ||
            (typeof sourceId === "string" && removed.has(sourceId))
          );
        });
        if (derived) {
          chunks.push({ id: row.id, kind: "derived", textHash: chunkTextHash(row.text) });
          removed.add(row.id);
        }
      }
      await yieldToEventLoop();
      if (rows.length < PLAN_WINDOW_ROWS) {
        break;
      }
      after = rows[rows.length - 1]!.id;
    }
  }

  // 3. Facts in the ledger.
  const facts: ForgetCascadePlan["facts"] = { retire: [], ownerKept: [], strip: [], relink: [] };
  if (tableExists(db, "canonical_facts")) {
    type FactRow = {
      rid: number;
      id: string;
      key: string;
      value: string;
      source: string;
      status: string;
      valid_until: number | null;
      evidence_chunk_ids: string | null;
      evidence_ref: string | null;
    };
    const hasRef = (
      db.prepare("PRAGMA table_info(canonical_facts)").all() as Array<{ name: string }>
    ).some((c) => c.name === "evidence_ref");
    const touched: FactRow[] = [];
    await scanWindows<FactRow>(
      db,
      `SELECT rowid AS rid, id, key, value, source, status, valid_until, evidence_chunk_ids,
              ${hasRef ? "evidence_ref" : "NULL AS evidence_ref"}
         FROM canonical_facts WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      (rows) => {
        for (const row of rows) {
          const cites = parseIds(row.evidence_chunk_ids).some((id) => removed.has(id));
          const fromSession =
            sessionFiles.size > 0 && sessionFiles.has(sessionRefFile(row.evidence_ref) ?? "");
          if (cites || fromSession) {
            touched.push(row);
          }
        }
      },
    );
    for (const row of touched) {
      const evidence = parseIds(row.evidence_chunk_ids);
      const fact: CascadeFact = {
        id: row.id,
        key: row.key,
        value: row.value,
        source: row.source,
        status: row.status,
        current: row.valid_until === null,
      };
      const kept = evidence.filter((id) => !removed.has(id));
      // A line ref into a transcript that is not being deleted is evidence
      // too (the per-turn correction capture cites the owner's line that way),
      // and so is any other evidence ref (a URL, a quote): it does not live
      // in the chunks being forgotten.
      const refFile = sessionRefFile(row.evidence_ref);
      const refPresent = typeof row.evidence_ref === "string" && row.evidence_ref.trim() !== "";
      const refLive = refPresent && (refFile === null || !sessionFiles.has(refFile));
      const live = liveIds(db, kept, removed);
      const citedRemoved = evidence.some((id) => removed.has(id));
      if (replacement && citedRemoved && textStatesValue(replacement.text, row.value)) {
        facts.relink.push({ ...fact, evidence: [...kept, replacement.id] });
        continue;
      }
      const activeCurrent = fact.current && row.status === "active";
      if (!activeCurrent) {
        if (citedRemoved) {
          facts.strip.push({ ...fact, evidence: kept });
        }
        continue;
      }
      if (live.length > 0 || refLive) {
        // Other evidence survives. A session-ref-only hit with live chunk
        // evidence is a survivor with nothing to rewrite.
        facts.strip.push({ ...fact, evidence: kept });
        continue;
      }
      if (canonicalSourceTier(row.source) >= OWNER_TRUST_TIER) {
        facts.ownerKept.push({ ...fact, evidence: kept });
      } else {
        facts.retire.push({ ...fact, evidence: kept });
      }
    }
  }

  // 4. Knowledge-graph links.
  const edges: ForgetCascadePlan["edges"] = { close: [], strip: [], relink: [] };
  if (tableExists(db, "relationships")) {
    type EdgeRow = {
      rid: number;
      id: string;
      valid_until: number | null;
      evidence_chunk_ids: string | null;
      source_entity_id: string;
      target_entity_id: string;
    };
    const touched: Array<{ row: EdgeRow; evidence: string[] }> = [];
    await scanWindows<EdgeRow>(
      db,
      `SELECT rowid AS rid, id, valid_until, evidence_chunk_ids, source_entity_id, target_entity_id
         FROM relationships WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      (rows) => {
        for (const row of rows) {
          const evidence = parseIds(row.evidence_chunk_ids);
          if (evidence.some((id) => removed.has(id))) {
            touched.push({ row, evidence });
          }
        }
      },
    );
    const entityName = (id: string): string => {
      try {
        return (
          (
            db.prepare(`SELECT name FROM entities WHERE id = ?`).get(id) as
              | { name: string }
              | undefined
          )?.name ?? ""
        );
      } catch {
        return "";
      }
    };
    for (const { row, evidence } of touched) {
      const kept = evidence.filter((id) => !removed.has(id));
      if (
        replacement &&
        textStatesValue(replacement.text, entityName(row.source_entity_id)) &&
        textStatesValue(replacement.text, entityName(row.target_entity_id))
      ) {
        edges.relink.push({ id: row.id, evidence: [...kept, replacement.id] });
        continue;
      }
      if (row.valid_until === null && liveIds(db, kept, removed).length === 0) {
        edges.close.push({ id: row.id, evidence: kept });
      } else {
        edges.strip.push({ id: row.id, evidence: kept });
      }
    }
  }

  const removedList = [...removed];
  const inBatches = <T>(sql: (placeholders: string) => string, map: (r: unknown) => T): T[] => {
    const out: T[] = [];
    for (let i = 0; i < removedList.length; i += 200) {
      const slice = removedList.slice(i, i + 200);
      try {
        for (const r of db.prepare(sql(slice.map(() => "?").join(","))).all(...slice)) {
          out.push(map(r));
        }
      } catch {
        // The table is not on this database.
      }
    }
    return out;
  };

  // 5. Curiosity findings that became a forgotten memory.
  const curiosityFindings = inBatches(
    (p) => `SELECT id, chunk_id FROM curiosity_findings WHERE chunk_id IN (${p})`,
    (r) => {
      const row = r as { id: string; chunk_id: string };
      return {
        id: row.id,
        chunkId: row.chunk_id,
        to:
          replacement && targets.chunks.some((c) => c.id === row.chunk_id) ? replacement.id : null,
      };
    },
  );
  await yieldToEventLoop();

  // 6. Learned preferences citing a forgotten memory.
  const preferences: ForgetCascadePlan["preferences"] = [];
  if (tableExists(db, "user_preferences")) {
    await scanWindows<{
      rid: number;
      id: string;
      category: string;
      key: string;
      evidence_ids: string | null;
    }>(
      db,
      `SELECT rowid AS rid, id, category, key, evidence_ids FROM user_preferences
        WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      (rows) => {
        for (const row of rows) {
          const evidence = parseIds(row.evidence_ids);
          const hit = evidence.filter((id) => removed.has(id));
          if (hit.length === 0) {
            continue;
          }
          const kept = evidence.filter((id) => !removed.has(id));
          const moved =
            replacement && hit.some((id) => targets.chunks.some((c) => c.id === id))
              ? [...kept, replacement.id]
              : kept;
          preferences.push({ id: row.id, category: row.category, key: row.key, evidence: moved });
        }
      },
    );
  }

  // 7. Dream-utility rows counting a forgotten memory.
  const dreamUtility = inBatches(
    (p) => `SELECT id FROM dream_utility WHERE artifact_id IN (${p})`,
    (r) => (r as { id: string }).id,
  );

  const body = {
    mode: targets.mode,
    chunks,
    facts,
    edges,
    insights,
    curiosityFindings,
    preferences,
    dreamUtility,
  };
  const counts = emptyCounts();
  counts.chunks = chunks.length;
  counts.derivedChunks = chunks.filter((c) => c.kind === "derived").length;
  counts.factsRetired = facts.retire.length;
  counts.ownerFactsKept = facts.ownerKept.length;
  counts.factsEvidenceStripped = facts.strip.length;
  counts.factsRelinked = facts.relink.length;
  counts.edgesClosed = edges.close.length;
  counts.edgesStripped = edges.strip.length;
  counts.edgesRelinked = edges.relink.length;
  counts.insightsFlagged = insights.length;
  counts.curiosityFindings = curiosityFindings.length;
  counts.preferences = preferences.length;
  counts.dreamUtility = dreamUtility.length;
  return { ...body, counts, hash: hashCascadePlan(body) };
}

export type IndexTables = { ftsTable: string | null; vectorTable: string | null };

export type CascadeApplyContext = {
  store: CanonicalFactsStore | null;
  tables: IndexTables;
  /** Record a text-hash suppression for each forgotten memory of these kinds. */
  suppressKinds: ReadonlySet<CascadeChunk["kind"]>;
  /**
   * How an evidence-empty fact is retired. `evidence_removed` (the default)
   * is the owner's cascade and propagates like the owner's retire;
   * `evidence_removed_system` is automatic housekeeping (PLAN-55 Phase 3
   * review M4) and propagates like the agent's.
   */
  retireReason?: "evidence_removed" | "evidence_removed_system";
  /** Extra hashes per chunk id to suppress with it (an edited memory's earlier texts). */
  extraHashes?: ReadonlyMap<string, string[]>;
  /** Runs first, in the same transaction as the rest when the plan fits one. */
  before?: () => void;
  /** Runs last, in the final transaction (the audit entry). Gets the suppression ids. */
  after?: (suppressionIds: string[]) => void;
  batchSize?: number;
};

export type CascadeApplyResult = {
  planHash: string;
  counts: CascadeCounts;
  retiredFacts: Array<{ key: string; value: string }>;
  ownerFactsKept: Array<{ key: string; value: string }>;
  /**
   * Planned retires that were not made because the fact changed after the
   * plan (a newer pin, possibly the owner's). Reported, never forced.
   */
  retireSkipped: Array<{ key: string; value: string }>;
  suppressionIds: string[];
  batches: number;
};

const tryRun = (db: DatabaseSync, sql: string, ...args: Array<string | number | null>) => {
  try {
    db.prepare(sql).run(...args);
  } catch {
    // The table is not there on this database.
  }
};

/** Delete one memory everywhere it is indexed (no suppression, no audit). */
export function deleteChunkEverywhere(db: DatabaseSync, id: string, tables: IndexTables): void {
  if (tables.vectorTable) tryRun(db, `DELETE FROM ${tables.vectorTable} WHERE id = ?`, id);
  if (tables.ftsTable) tryRun(db, `DELETE FROM ${tables.ftsTable} WHERE id = ?`, id);
  // near_merge_hints pairs two chunks (chunk_id_a, chunk_id_b); a hint
  // naming the forgotten memory on either side goes.
  tryRun(db, `DELETE FROM near_merge_hints WHERE chunk_id_a = ? OR chunk_id_b = ?`, id, id);
  for (const table of ["orphan_replay_queue", "curiosity_surprises", "chunk_supersessions"]) {
    tryRun(db, `DELETE FROM ${table} WHERE chunk_id = ?`, id);
  }
  db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
}

/**
 * Write a plan. See the module comment for the transaction rule. The plan
 * must be fresh (the caller recomputes it right before, under the
 * maintenance lock, and compares hashes when the owner previewed one).
 */
export async function applyForgetCascade(
  db: DatabaseSync,
  plan: ForgetCascadePlan,
  ctx: CascadeApplyContext,
): Promise<CascadeApplyResult> {
  const now = Date.now();
  const setFactEvidence = db.prepare(
    `UPDATE canonical_facts SET evidence_chunk_ids = ? WHERE id = ?`,
  );
  const derivedOps: Array<() => void> = [];
  const retiredFacts: CascadeApplyResult["retiredFacts"] = [];
  const retireSkipped: CascadeApplyResult["retireSkipped"] = [];
  const retireReason = ctx.retireReason ?? "evidence_removed";

  for (const f of [...plan.facts.strip, ...plan.facts.relink, ...plan.facts.ownerKept]) {
    derivedOps.push(() => {
      setFactEvidence.run(JSON.stringify(f.evidence), f.id);
    });
  }
  const forgottenIds = new Set(plan.chunks.map((c) => c.id));
  const factEvidence = db.prepare(`SELECT evidence_chunk_ids FROM canonical_facts WHERE id = ?`);
  for (const f of plan.facts.retire) {
    derivedOps.push(() => {
      // Evidence added to the row since the plan (a re-extraction confirmed
      // it) means it no longer rests only on what is forgotten: strip the
      // forgotten ids, keep the fact.
      const row = factEvidence.get(f.id) as { evidence_chunk_ids: string | null } | undefined;
      const remaining = parseIds(row?.evidence_chunk_ids).filter((id) => !forgottenIds.has(id));
      if (remaining.some((id) => !f.evidence.includes(id))) {
        setFactEvidence.run(JSON.stringify(remaining), f.id);
        retireSkipped.push({ key: f.key, value: f.value });
        return;
      }
      setFactEvidence.run(JSON.stringify(f.evidence), f.id);
      // Bound to the planned row: the store refuses when the key's current
      // row is another one or now at the owner tier (H3).
      const ok = ctx.store
        ? ctx.store.retire(f.key, { reason: retireReason, expectedId: f.id })
        : Number(
            db
              .prepare(
                `UPDATE canonical_facts SET status = 'retired'
                  WHERE id = ? AND status = 'active' AND valid_until IS NULL
                    AND source NOT IN ('owner', 'user_directive')`,
              )
              .run(f.id).changes,
          ) > 0;
      if (ok) {
        retiredFacts.push({ key: f.key, value: f.value });
      } else {
        retireSkipped.push({ key: f.key, value: f.value });
      }
    });
  }
  for (const e of [...plan.edges.strip, ...plan.edges.relink]) {
    derivedOps.push(() =>
      tryRun(
        db,
        `UPDATE relationships SET evidence_chunk_ids = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(e.evidence),
        now,
        e.id,
      ),
    );
  }
  for (const e of plan.edges.close) {
    derivedOps.push(() => {
      tryRun(
        db,
        `UPDATE relationships SET valid_until = ?, updated_at = ?, evidence_chunk_ids = ?
          WHERE id = ? AND valid_until IS NULL`,
        now,
        now,
        JSON.stringify(e.evidence),
        e.id,
      );
      tryRun(
        db,
        `INSERT INTO relationship_belief_history
           (id, relationship_id, action, prev_weight, new_weight, evidence_chunk_ids,
            valid_from, valid_until, created_at)
         VALUES (?, ?, 'evidence_removed', NULL, NULL, ?, NULL, ?, ?)`,
        crypto.randomUUID(),
        e.id,
        JSON.stringify(e.evidence),
        now,
        now,
      );
    });
  }
  for (const ins of plan.insights) {
    derivedOps.push(() => {
      const row = db.prepare(`SELECT stale_fact FROM dream_insights WHERE id = ?`).get(ins.id) as
        | { stale_fact: string | null }
        | undefined;
      if (!row) {
        return;
      }
      const notes = parseInsightNotes(row.stale_fact);
      // Idempotent: a rerun of a batched apply that failed part-way does not
      // add the same note again.
      const want = ins.chunkIds.toSorted().join(",");
      if (
        notes.some(
          (n) => n.reason === "forgotten_evidence" && n.chunkIds.toSorted().join(",") === want,
        )
      ) {
        return;
      }
      const note: InsightStaleNote = {
        reason: "forgotten_evidence",
        chunkIds: ins.chunkIds,
        at: now,
      };
      db.prepare(`UPDATE dream_insights SET stale_fact = ? WHERE id = ?`).run(
        JSON.stringify([...notes, note]),
        ins.id,
      );
    });
  }
  for (const c of plan.curiosityFindings) {
    derivedOps.push(() =>
      tryRun(db, `UPDATE curiosity_findings SET chunk_id = ? WHERE id = ?`, c.to, c.id),
    );
  }
  for (const p of plan.preferences) {
    derivedOps.push(() =>
      tryRun(
        db,
        `UPDATE user_preferences SET evidence_ids = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(p.evidence),
        now,
        p.id,
      ),
    );
  }
  for (const id of plan.dreamUtility) {
    derivedOps.push(() => tryRun(db, `DELETE FROM dream_utility WHERE id = ?`, id));
  }

  const suppressionIds: string[] = [];
  const chunkOps: Array<() => void> = plan.chunks.map((c) => () => {
    deleteChunkEverywhere(db, c.id, ctx.tables);
    if (ctx.suppressKinds.has(c.kind)) {
      // A short transcript passage ("ok", "thanks!") is suppressed for its
      // own transcript only: by text alone it would also hide the same words
      // in every other conversation.
      if (c.kind === "session" && c.sessionPath) {
        suppressionIds.push(
          addSuppression(db, {
            kind: "session_chunk",
            hash: sessionChunkSuppressionHash(c.sessionPath, c.textHash),
            reason: "owner_forget",
          }).id,
        );
        return;
      }
      const hashes = new Set([c.textHash, ...(ctx.extraHashes?.get(c.id) ?? [])]);
      for (const hash of hashes) {
        suppressionIds.push(
          addSuppression(db, {
            kind: "chunk_hash",
            hash,
            reason: c.kind === "derived" ? "owner_forget_cascade" : "owner_forget",
          }).id,
        );
      }
    }
  });

  const ops: Array<() => void> = [
    ...(ctx.before ? [ctx.before] : []),
    ...derivedOps,
    ...chunkOps,
    () => ctx.after?.([...new Set(suppressionIds)]),
  ];
  const batchSize = Math.max(1, ctx.batchSize ?? APPLY_BATCH);
  let batches = 0;
  if (ops.length <= batchSize) {
    inSavepoint(db, "owner_forget_cascade", () => {
      for (const op of ops) op();
    });
    batches = 1;
  } else {
    for (let i = 0; i < ops.length; i += batchSize) {
      const slice = ops.slice(i, i + batchSize);
      inSavepoint(db, "owner_forget_cascade", () => {
        for (const op of slice) op();
      });
      batches += 1;
      await yieldToEventLoop();
    }
  }
  return {
    planHash: plan.hash,
    counts: plan.counts,
    retiredFacts,
    ownerFactsKept: plan.facts.ownerKept.map((f) => ({ key: f.key, value: f.value })),
    retireSkipped,
    suppressionIds: [...new Set(suppressionIds)],
    batches,
  };
}

/** The owner-facing summary of a plan (no memory text). */
export function summarizeCascadePlan(plan: ForgetCascadePlan) {
  return {
    planHash: plan.hash,
    mode: plan.mode,
    counts: plan.counts,
    chunks: plan.chunks.map((c) => ({ id: c.id, kind: c.kind })),
    factsRetired: plan.facts.retire.map((f) => ({ key: f.key, value: f.value, source: f.source })),
    ownerFactsKept: plan.facts.ownerKept.map((f) => ({ key: f.key, value: f.value })),
    factsKeptWithOtherEvidence: plan.facts.strip
      .filter((f) => f.current && f.status === "active")
      .map((f) => ({ key: f.key, value: f.value, source: f.source })),
    factsRelinked: plan.facts.relink.map((f) => ({ key: f.key, value: f.value })),
    edgesClosed: plan.edges.close.map((e) => e.id),
    insightsFlagged: plan.insights.map((i) => i.id),
  };
}

export type CascadePlanSummary = ReturnType<typeof summarizeCascadePlan>;
