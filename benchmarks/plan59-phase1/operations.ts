/**
 * PLAN-59 Phase 1: the two memory operations that apply on this store.
 *
 * Both run against a FORK of the sealed snapshot through a plain node:sqlite
 * connection. Neither deletes a chunk; both are reversible from the rows they
 * leave behind. A third operation the plan lists, re-embedding after a model
 * or index change, does not apply here: every chunk in the store carries one
 * embedding model and the live provider is that same model, so there is no
 * recorded change to re-embed after (`describeReembed` says so from the data).
 *
 * consolidate_cluster
 *   Candidates are connected components over `near_merge_hints` pairs at
 *   base_similarity >= 0.85 whose members are live (lifecycle generated or
 *   activated, not already demoted), capped at six members. A cluster
 *   qualifies only when its members co-surface: at least two of them in the
 *   fused top 5 of at least N development queries (N = 3, lowered to 2 by the
 *   runner when fewer than eight clusters qualify). Applying it inserts ONE new
 *   chunk whose text is the members' texts joined by a separator (no LLM
 *   rewriting), embedded with the normal provider, parent_id NULL,
 *   importance = max over members, access_count = sum, lifecycle generated.
 *   Members get parent_id = the new id, lifecycle `consolidated`
 *   (lifecycle_state `consolidated`), hygiene_done = 1, importance halved, and
 *   their rows are removed from chunks_vec and chunks_fts. That is the
 *   demotion convention the PLAN-40 Lane 2 merge writer used and that the
 *   indexer's re-index carry-over still honours; without the index-row removal
 *   a demotion is invisible to search, because neither search channel filters
 *   on lifecycle, lifecycle_state, parent_id or valid_time_end (see README).
 *
 * bound_validity
 *   For a canonical fact with `superseded_by` and `valid_until` set, set
 *   `valid_time_end = valid_until` on the chunks named in its
 *   evidence_chunk_ids where it is still NULL. No text changes.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { sha256 } from "./common.js";

export type OperationCost = {
  chunksTouched: number;
  embeddingCalls: number;
  /** wall time of the apply step, ms */
  estimatedMs: number;
};

export type ClusterCandidate = {
  kind: "consolidate_cluster";
  /** `cc_` + sha256 of the sorted member ids */
  id: string;
  /** distinct paths among members; one on this store (every hint pair is same-path) */
  families: string[];
  memberIds: string[];
  pairCount: number;
  minSimilarity: number;
  /** newest last_accessed_at over members, for the recency arm */
  lastAccessedAt: number | null;
  /** development queries with >= 2 members in the fused top 5; set by qualifyClusters */
  coSurfaceQueries?: number;
};

export type BoundValidityCandidate = {
  kind: "bound_validity";
  /** `bv_` + canonical fact id */
  id: string;
  factId: string;
  validUntil: number;
  /** evidence chunks whose valid_time_end is NULL on the snapshot */
  chunkIds: string[];
  families: string[];
  lastAccessedAt: number | null;
};

export type Operation = ClusterCandidate | BoundValidityCandidate;

/** Chunk ids an operation writes to (members, or evidence chunks). */
export function affectedChunkIds(op: Operation): string[] {
  return op.kind === "consolidate_cluster" ? op.memberIds : op.chunkIds;
}

export const SEPARATOR = "\n\n---\n\n";
/** text-embedding-3-small accepts 8,191 tokens; six long transcript chunks can exceed it. */
export const EMBED_INPUT_MAX_CHARS = 24_000;
export const DEFAULT_MIN_SIMILARITY = 0.85;
export const DEFAULT_MAX_MEMBERS = 6;

export function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name),
  );
}

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

/** Live for the purpose of clustering: searchable and not already demoted. */
const LIVE_MEMBER_SQL = `
  COALESCE(lifecycle, 'generated') IN ('generated', 'activated')
  AND (lifecycle_state IS NULL OR lifecycle_state = 'active')
  AND parent_id IS NULL
  AND model != 'pending'`;

type HintRow = { a: string; b: string; sim: number };
type MemberRow = {
  id: string;
  path: string;
  last_accessed_at: number | null;
};

export function findClusterCandidates(
  db: DatabaseSync,
  opts?: { minSimilarity?: number; maxMembers?: number },
): ClusterCandidate[] {
  const minSim = opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const maxMembers = opts?.maxMembers ?? DEFAULT_MAX_MEMBERS;
  if (!hasTable(db, "near_merge_hints")) {
    return [];
  }
  const pairs = db
    .prepare(
      `SELECT h.chunk_id_a AS a, h.chunk_id_b AS b, h.base_similarity AS sim
         FROM near_merge_hints h
         JOIN chunks ca ON ca.id = h.chunk_id_a
         JOIN chunks cb ON cb.id = h.chunk_id_b
        WHERE h.base_similarity >= ?
          AND h.chunk_id_a != h.chunk_id_b
          AND ${LIVE_MEMBER_SQL.replaceAll(/\b(lifecycle|lifecycle_state|parent_id|model)\b/g, "ca.$1")}
          AND ${LIVE_MEMBER_SQL.replaceAll(/\b(lifecycle|lifecycle_state|parent_id|model)\b/g, "cb.$1")}
        ORDER BY h.chunk_id_a, h.chunk_id_b`,
    )
    .all(minSim) as unknown as HintRow[];
  if (pairs.length === 0) {
    return [];
  }

  // Union-find over the pairs.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) {
      r = parent.get(r)!;
    }
    let cur = x;
    while (parent.get(cur) !== undefined && parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (x: string, y: string) => {
    if (!parent.has(x)) parent.set(x, x);
    if (!parent.has(y)) parent.set(y, y);
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) {
      // deterministic root: the smaller id
      if (rx < ry) parent.set(ry, rx);
      else parent.set(rx, ry);
    }
  };
  for (const p of pairs) {
    union(p.a, p.b);
  }
  const components = new Map<string, Set<string>>();
  for (const p of pairs) {
    const root = find(p.a);
    const set = components.get(root) ?? new Set<string>();
    set.add(p.a);
    set.add(p.b);
    components.set(root, set);
  }
  // Weighted degree per member, for the cap.
  const degree = new Map<string, number>();
  for (const p of pairs) {
    degree.set(p.a, (degree.get(p.a) ?? 0) + p.sim);
    degree.set(p.b, (degree.get(p.b) ?? 0) + p.sim);
  }
  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const memberRows = new Map<string, MemberRow>();
  const stmt = db.prepare(`SELECT id, path, last_accessed_at FROM chunks WHERE id = ?`);
  for (const id of ids) {
    const row = stmt.get(id) as unknown as MemberRow | undefined;
    if (row) memberRows.set(id, row);
  }

  const out: ClusterCandidate[] = [];
  for (const set of components.values()) {
    let members = [...set].toSorted(
      (x, y) => (degree.get(y) ?? 0) - (degree.get(x) ?? 0) || (x < y ? -1 : 1),
    );
    if (members.length > maxMembers) {
      members = members.slice(0, maxMembers);
    }
    members = members.toSorted();
    const memberSet = new Set(members);
    const inner = pairs.filter((p) => memberSet.has(p.a) && memberSet.has(p.b));
    const families = [...new Set(members.map((m) => memberRows.get(m)?.path ?? ""))].toSorted();
    let lastAccessedAt: number | null = null;
    for (const m of members) {
      const t = memberRows.get(m)?.last_accessed_at ?? null;
      if (t !== null && (lastAccessedAt === null || t > lastAccessedAt)) lastAccessedAt = t;
    }
    out.push({
      kind: "consolidate_cluster",
      id: `cc_${sha256(members.join("\n")).slice(0, 16)}`,
      families,
      memberIds: members,
      pairCount: inner.length,
      minSimilarity: inner.length ? Math.min(...inner.map((p) => p.sim)) : minSim,
      lastAccessedAt,
    });
  }
  return out.toSorted((x, y) => (x.id < y.id ? -1 : 1));
}

/**
 * Keep the clusters whose members co-surface: at least two members in the
 * fused top 5 of at least `minQueries` development queries. `topFives` is one
 * ordered id list per development query (the baseline run on an unchanged fork).
 */
export function qualifyClusters(
  candidates: readonly ClusterCandidate[],
  topFives: ReadonlyArray<readonly string[]>,
  minQueries: number,
): ClusterCandidate[] {
  const out: ClusterCandidate[] = [];
  for (const c of candidates) {
    const members = new Set(c.memberIds);
    let n = 0;
    for (const top of topFives) {
      let hits = 0;
      for (const id of top.slice(0, 5)) {
        if (members.has(id)) hits++;
      }
      if (hits >= 2) n++;
    }
    if (n >= minQueries) {
      out.push({ ...c, coSurfaceQueries: n });
    }
  }
  return out;
}

export function findBoundValidityCandidates(db: DatabaseSync): BoundValidityCandidate[] {
  if (!hasTable(db, "canonical_facts") || !hasColumn(db, "chunks", "valid_time_end")) {
    return [];
  }
  const facts = db
    .prepare(
      `SELECT id, valid_until, evidence_chunk_ids FROM canonical_facts
        WHERE superseded_by IS NOT NULL AND valid_until IS NOT NULL
        ORDER BY id`,
    )
    .all() as unknown as Array<{ id: string; valid_until: number; evidence_chunk_ids: string }>;
  const chunkStmt = db.prepare(
    `SELECT id, path, last_accessed_at FROM chunks WHERE id = ? AND valid_time_end IS NULL`,
  );
  const out: BoundValidityCandidate[] = [];
  for (const f of facts) {
    let ids: unknown;
    try {
      ids = JSON.parse(f.evidence_chunk_ids);
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    const chunkIds: string[] = [];
    const families = new Set<string>();
    let lastAccessedAt: number | null = null;
    for (const raw of ids) {
      if (typeof raw !== "string") continue;
      const row = chunkStmt.get(raw) as unknown as MemberRow | undefined;
      if (!row) continue;
      chunkIds.push(row.id);
      families.add(row.path);
      if (
        row.last_accessed_at !== null &&
        (lastAccessedAt === null || row.last_accessed_at > lastAccessedAt)
      ) {
        lastAccessedAt = row.last_accessed_at;
      }
    }
    if (chunkIds.length === 0) continue;
    out.push({
      kind: "bound_validity",
      id: `bv_${f.id}`,
      factId: f.id,
      validUntil: Number(f.valid_until),
      chunkIds: chunkIds.toSorted(),
      families: [...families].toSorted(),
      lastAccessedAt,
    });
  }
  return out;
}

export type EmbedFn = (text: string) => Promise<number[]>;

export type ApplyContext = {
  embed: EmbedFn;
  /** frozen clock for created_at / updated_at / audit rows */
  now: number;
};

export type ConsolidateResult = {
  kind: "consolidate_cluster";
  parentId: string;
  memberIds: string[];
  cost: OperationCost;
};

export type BoundValidityResult = {
  kind: "bound_validity";
  changed: string[];
  cost: OperationCost;
};

export type ApplyResult = ConsolidateResult | BoundValidityResult;

const float32Blob = (vec: number[]): Uint8Array => {
  const f = new Float32Array(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
};

export function parentIdFor(memberIds: readonly string[]): string {
  return `plan59c_${sha256([...memberIds].toSorted().join("\n")).slice(0, 24)}`;
}

type FullMemberRow = {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  model: string;
  text: string;
  importance_score: number | null;
  access_count: number | null;
  last_accessed_at: number | null;
  semantic_type: string | null;
  memory_type: string | null;
  parent_id: string | null;
  created_at: number | null;
};

export async function applyConsolidateCluster(
  db: DatabaseSync,
  op: ClusterCandidate,
  ctx: ApplyContext,
): Promise<ConsolidateResult> {
  const t0 = performance.now();
  const placeholders = op.memberIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, path, source, start_line, end_line, model, text, importance_score, access_count,
              last_accessed_at, semantic_type, memory_type, parent_id, created_at
         FROM chunks WHERE id IN (${placeholders})
        ORDER BY start_line, id`,
    )
    .all(...op.memberIds) as unknown as FullMemberRow[];
  if (rows.length !== op.memberIds.length) {
    throw new Error(`cluster ${op.id}: ${rows.length}/${op.memberIds.length} members present`);
  }
  if (rows.some((r) => r.parent_id !== null)) {
    throw new Error(`cluster ${op.id}: a member is already demoted; apply on a fresh fork`);
  }
  const text = rows.map((r) => r.text).join(SEPARATOR);
  const embedding = await ctx.embed(text.slice(0, EMBED_INPUT_MAX_CHARS));
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`cluster ${op.id}: empty embedding`);
  }
  const parentId = parentIdFor(op.memberIds);
  const path = rows[0]!.path;
  const source = rows[0]!.source;
  const model = rows[0]!.model;
  // Parents sit at a negative, per-path-unique line span so the live-recall
  // hit rule (same path, overlapping lines) never counts a parent as a raw
  // hit for a member; the parent-mapped rank does that explicitly.
  const minLine = (
    db
      .prepare(`SELECT MIN(start_line) AS m FROM chunks WHERE path = ? AND start_line < 0`)
      .get(path) as { m: number | null } | undefined
  )?.m;
  const lineTag = minLine === null || minLine === undefined ? -1 : minLine - 1;
  const importance = Math.max(...rows.map((r) => r.importance_score ?? 0));
  const accessCount = rows.reduce((s, r) => s + (r.access_count ?? 0), 0);
  const lastAccessed = rows.reduce<number | null>(
    (m, r) =>
      r.last_accessed_at !== null && (m === null || r.last_accessed_at > m)
        ? r.last_accessed_at
        : m,
    null,
  );
  const semanticType = mostCommon(rows.map((r) => r.semantic_type ?? "general"));
  const memoryType = mostCommon(rows.map((r) => r.memory_type ?? "plaintext"));
  const createdAt = Math.min(...rows.map((r) => r.created_at ?? ctx.now));

  const cols: Record<string, SQLInputValue> = {
    id: parentId,
    path,
    source,
    start_line: lineTag,
    end_line: lineTag,
    hash: sha256(text),
    model,
    text,
    embedding: float32Blob(embedding),
    updated_at: ctx.now,
  };
  const optional: Record<string, SQLInputValue> = {
    created_at: createdAt,
    importance_score: importance,
    access_count: accessCount,
    last_accessed_at: lastAccessed,
    lifecycle: "generated",
    lifecycle_state: "active",
    semantic_type: semanticType,
    memory_type: memoryType,
    origin: "plan59_consolidation",
    parent_id: null,
    hygiene_done: 0,
    version: 1,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (hasColumn(db, "chunks", k)) cols[k] = v;
  }
  const names = Object.keys(cols);
  const vecTable = hasTable(db, "chunks_vec");
  const ftsTable = hasTable(db, "chunks_fts");
  const auditTable = hasTable(db, "memory_audit_log");

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO chunks (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ).run(...names.map((n) => cols[n]!));
    if (vecTable) {
      db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`).run(
        parentId,
        float32Blob(embedding),
      );
    }
    if (ftsTable) {
      db.prepare(
        `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(text, parentId, path, source, model, lineTag, lineTag);
    }
    const demote = db.prepare(
      `UPDATE chunks SET parent_id = ?, lifecycle = 'consolidated', lifecycle_state = 'consolidated',
              importance_score = COALESCE(importance_score, 0) / 2, updated_at = ?
              ${hasColumn(db, "chunks", "hygiene_done") ? ", hygiene_done = 1" : ""}
        WHERE id = ?`,
    );
    const dropVec = vecTable ? db.prepare(`DELETE FROM chunks_vec WHERE id = ?`) : null;
    const dropFts = ftsTable ? db.prepare(`DELETE FROM chunks_fts WHERE id = ?`) : null;
    const audit = auditTable
      ? db.prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
      : null;
    for (const r of rows) {
      demote.run(parentId, ctx.now, r.id);
      dropVec?.run(r.id);
      dropFts?.run(r.id);
      audit?.run(
        `plan59_${sha256(`${parentId}:${r.id}`).slice(0, 32)}`,
        r.id,
        "merged",
        ctx.now,
        "plan59-phase1",
        JSON.stringify({ parent_id: parentId, op: op.id }),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    kind: "consolidate_cluster",
    parentId,
    memberIds: [...op.memberIds],
    cost: {
      chunksTouched: rows.length + 1,
      embeddingCalls: 1,
      estimatedMs: performance.now() - t0,
    },
  };
}

export function applyBoundValidity(
  db: DatabaseSync,
  op: BoundValidityCandidate,
  ctx: Pick<ApplyContext, "now">,
): BoundValidityResult {
  const t0 = performance.now();
  const stmt = db.prepare(
    `UPDATE chunks SET valid_time_end = ?, updated_at = ? WHERE id = ? AND valid_time_end IS NULL`,
  );
  const changed: string[] = [];
  db.exec("BEGIN");
  try {
    for (const id of op.chunkIds) {
      if (Number(stmt.run(op.validUntil, ctx.now, id).changes) > 0) changed.push(id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    kind: "bound_validity",
    changed,
    cost: { chunksTouched: changed.length, embeddingCalls: 0, estimatedMs: performance.now() - t0 },
  };
}

export async function applyOperation(
  db: DatabaseSync,
  op: Operation,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  return op.kind === "consolidate_cluster"
    ? await applyConsolidateCluster(db, op, ctx)
    : applyBoundValidity(db, op, ctx);
}

/** The cost the pilot QUOTES before applying (the apply step measures the real one). */
export function quotedCost(op: Operation): OperationCost {
  return op.kind === "consolidate_cluster"
    ? { chunksTouched: op.memberIds.length + 1, embeddingCalls: 1, estimatedMs: 400 }
    : { chunksTouched: op.chunkIds.length, embeddingCalls: 0, estimatedMs: 5 };
}

/**
 * Re-embedding applies only after a recorded model or index change. With one
 * embedding model across every indexed chunk and the live provider on that
 * same model there is none, so the operation type is reported as inapplicable.
 */
export function describeReembed(
  db: DatabaseSync,
  liveModel: string,
): { applicable: boolean; reason: string; models: Array<{ model: string; chunks: number }> } {
  const models = (
    db
      .prepare(
        `SELECT model, COUNT(*) AS chunks FROM chunks WHERE model != 'pending' GROUP BY model`,
      )
      .all() as unknown as Array<{ model: string; chunks: number }>
  ).map((r) => ({ model: r.model, chunks: Number(r.chunks) }));
  const stale = models.filter((m) => m.model !== liveModel);
  if (stale.length === 0) {
    return {
      applicable: false,
      reason: `every indexed chunk is embedded with the live model (${liveModel}); no model or index change to re-embed after`,
      models,
    };
  }
  return {
    applicable: true,
    reason: `${stale.reduce((s, m) => s + m.chunks, 0)} chunks carry a model other than ${liveModel}`,
    models,
  };
}

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
}

export type ClusterDiagnostic = {
  id: string;
  members: number;
  /** development queries with >= 2 members in the fused top 5 (the qualification rule) */
  coSurfaceTop5: number;
  /** same with the top 10 */
  coSurfaceTop10: number;
  /** development queries with >= 1 member anywhere in the top 10 */
  anyMemberTop10: number;
  /** development queries whose gold is a member, with their parent-mapped ranks */
  goldQueries: number;
  goldRanks: Array<number | null>;
};

/**
 * Why clusters do or do not qualify: how often their members reach the
 * development top 5 and top 10 at all, together or alone, and how the
 * questions written about their members rank. Diagnostic only; never used for
 * selection.
 */
export function clusterDiagnostics(
  candidates: readonly ClusterCandidate[],
  dev: ReadonlyArray<{ chunkId: string; fusedRank: number | null; topTenIds: readonly string[] }>,
): {
  clusters: ClusterDiagnostic[];
  clustersWithAnyMemberTop10: number;
  devQueriesWithAnyMemberTop10: number;
  devQueriesWithGoldInCluster: number;
} {
  const memberOf = new Map<string, string>();
  for (const c of candidates) for (const m of c.memberIds) memberOf.set(m, c.id);
  const clusters: ClusterDiagnostic[] = candidates.map((c) => {
    const members = new Set(c.memberIds);
    let top5 = 0;
    let top10 = 0;
    let any10 = 0;
    const goldRanks: Array<number | null> = [];
    for (const q of dev) {
      const in5 = q.topTenIds.slice(0, 5).filter((id) => members.has(id)).length;
      const in10 = q.topTenIds.slice(0, 10).filter((id) => members.has(id)).length;
      if (in5 >= 2) top5++;
      if (in10 >= 2) top10++;
      if (in10 >= 1) any10++;
      if (members.has(q.chunkId)) goldRanks.push(q.fusedRank);
    }
    return {
      id: c.id,
      members: c.memberIds.length,
      coSurfaceTop5: top5,
      coSurfaceTop10: top10,
      anyMemberTop10: any10,
      goldQueries: goldRanks.length,
      goldRanks,
    };
  });
  return {
    clusters,
    clustersWithAnyMemberTop10: clusters.filter((c) => c.anyMemberTop10 > 0).length,
    devQueriesWithAnyMemberTop10: dev.filter((q) =>
      q.topTenIds.slice(0, 10).some((id) => memberOf.has(id)),
    ).length,
    devQueriesWithGoldInCluster: dev.filter((q) => memberOf.has(q.chunkId)).length,
  };
}
