/**
 * The owner's controls over what their agent remembers (PLAN-53 G1): list,
 * view, edit, forget, export.
 *
 * What can be changed. The agent's own memories (facts, notes, insights,
 * distilled rules) are rows only this database holds, so editing or
 * forgetting them sticks. Memories indexed from files (sessions, MEMORY.md,
 * skills) are rebuilt from those files on every reindex, so here they are
 * read-only: change the file instead. Frozen memories (skills) are read-only.
 *
 * Forgetting is a real delete from the memory table, the keyword index and
 * the vector index in one transaction. A soft "expired" mark would leave the
 * memory findable by search until the 14-day purge. The audit log records
 * that something was forgotten, never what it said.
 *
 * Forgetting sticks (PLAN-55 Phase 0). A forget records the memory's text
 * hash, a fact retire records the key/value, a preference removal records
 * the key, all in `memory_suppressions`; the background writers that would
 * otherwise regrow them from the same transcript consult that table first.
 * Every owner write goes through here so the gateway RPCs and the CLI get
 * the suppression for free.
 *
 * Every function here takes the database handle from the caller per call:
 * the manager swaps it during a reindex, so it must never be kept.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalFactsStore } from "./canonical-facts.js";
import { setChunkText } from "./chunk-writer.js";
import { yieldToEventLoop } from "./event-loop.js";
import { hashText } from "./internal.js";
import {
  addSuppression,
  chunkTextHash,
  inSavepoint,
  normalizeLoose,
  preferenceKeyHash,
  preferenceValueHash,
} from "./memory-suppressions.js";

/** Id prefixes of memories that exist only in the database (the agent's own). */
export const OWNER_EDITABLE_PREFIXES = [
  "fact_",
  "note_",
  "scratch_",
  "dream_insight_",
  "distill_",
  "crule_",
  "hygiene_merge_",
  "seed_",
] as const;

export type MemoryKind = "own" | "file";

export type MemorySummary = {
  id: string;
  kind: MemoryKind;
  editable: boolean;
  source: string;
  semanticType: string | null;
  lifecycle: string | null;
  importance: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  path: string | null;
  /** The first part of the text. */
  preview: string;
};

export type MemoryDetail = MemorySummary & {
  text: string;
  sensitivity: string | null;
  accessCount: number | null;
  lastAccessedAt: number | null;
  version: number | null;
};

type ChunkRow = {
  rowid: number;
  id: string;
  source: string | null;
  path: string | null;
  semantic_type: string | null;
  lifecycle: string | null;
  lifecycle_state: string | null;
  importance_score: number | null;
  created_at: number | null;
  updated_at: number | null;
  text: string;
  governance_json: string | null;
  access_count: number | null;
  last_accessed_at: number | null;
  version: number | null;
};

const kindOf = (id: string): MemoryKind =>
  OWNER_EDITABLE_PREFIXES.some((p) => id.startsWith(p)) ? "own" : "file";

const isEditable = (row: Pick<ChunkRow, "id" | "lifecycle">): boolean =>
  kindOf(row.id) === "own" && row.lifecycle !== "frozen";

const SUMMARY_COLUMNS =
  "rowid, id, source, path, semantic_type, lifecycle, lifecycle_state, importance_score, created_at, updated_at, substr(text, 1, 240) AS text";

function toSummary(row: ChunkRow): MemorySummary {
  return {
    id: row.id,
    kind: kindOf(row.id),
    editable: isEditable(row),
    source: row.source ?? "",
    semanticType: row.semantic_type,
    lifecycle: row.lifecycle,
    importance: row.importance_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    path: row.path,
    preview: row.text.replace(/\s+/g, " ").trim().slice(0, 240),
  };
}

export type ListOptions = {
  /** "own" (default): the agent's own memories. "file": indexed from files. "all". */
  kind?: MemoryKind | "all";
  /** Text that must appear (case-insensitive). */
  q?: string;
  semanticType?: string;
  /** Page after this cursor (a rowid from the previous page). */
  cursor?: number;
  limit?: number;
};

/** One page, newest first. Forgotten and expired memories are not listed. */
export function listMemories(
  db: DatabaseSync,
  opts: ListOptions = {},
): { memories: MemorySummary[]; nextCursor: number | null } {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const where: string[] = [
    "(lifecycle_state IS NULL OR lifecycle_state <> 'forgotten')",
    "(lifecycle IS NULL OR lifecycle <> 'expired')",
  ];
  const args: Array<string | number> = [];
  const kind = opts.kind ?? "own";
  if (kind !== "all") {
    const prefixMatch = OWNER_EDITABLE_PREFIXES.map(() => "id LIKE ?").join(" OR ");
    where.push(kind === "own" ? `(${prefixMatch})` : `NOT (${prefixMatch})`);
    args.push(...OWNER_EDITABLE_PREFIXES.map((p) => `${p}%`));
  }
  if (opts.semanticType) {
    where.push("semantic_type = ?");
    args.push(opts.semanticType);
  }
  const q = opts.q?.trim();
  if (q) {
    where.push("text LIKE ? ESCAPE '\\'");
    args.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (typeof opts.cursor === "number") {
    where.push("rowid < ?");
    args.push(opts.cursor);
  }
  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM chunks WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as unknown as ChunkRow[];
  const page = rows.slice(0, limit);
  return {
    memories: page.map(toSummary),
    nextCursor: rows.length > limit ? (page.at(-1)?.rowid ?? null) : null,
  };
}

export function getMemory(db: DatabaseSync, id: string): MemoryDetail | null {
  const row = db
    .prepare(
      `SELECT rowid, id, source, path, semantic_type, lifecycle, lifecycle_state, importance_score,
              created_at, updated_at, text, governance_json, access_count, last_accessed_at, version
         FROM chunks WHERE id = ?`,
    )
    .get(id) as unknown as ChunkRow | undefined;
  if (!row) {
    return null;
  }
  let sensitivity: string | null = null;
  try {
    sensitivity =
      (JSON.parse(row.governance_json || "{}") as { sensitivity?: string }).sensitivity ?? null;
  } catch {
    sensitivity = null;
  }
  return {
    ...toSummary(row),
    text: row.text,
    sensitivity,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    version: row.version,
  };
}

export class OwnerEditRefused extends Error {}

function editableOrThrow(db: DatabaseSync, id: string): MemoryDetail {
  const memory = getMemory(db, id);
  if (!memory) {
    throw new OwnerEditRefused("There is no memory with that id.");
  }
  if (memory.kind === "file") {
    throw new OwnerEditRefused(
      `This memory is indexed from ${memory.path ?? "a file"} and is rebuilt from it; change the file instead.`,
    );
  }
  if (!memory.editable) {
    throw new OwnerEditRefused(
      "This memory is frozen (a skill or a protected memory) and cannot be changed here.",
    );
  }
  return memory;
}

/** Audit entry that must land with the write it describes (call inside the transaction). */
function writeAudit(
  db: DatabaseSync,
  chunkId: string,
  event: string,
  metadata: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), chunkId, event, Date.now(), "owner", JSON.stringify(metadata));
}

export type IndexTables = { ftsTable: string | null; vectorTable: string | null };

const tryRun = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => {
  try {
    db.prepare(sql).run(...args);
  } catch {
    // The table is not there on this database (no FTS, or sqlite-vec not loaded).
  }
};

/**
 * Text hashes this memory carried before the owner edited it (recorded by
 * editMemory in the audit log as hashes, never as text), so a forget also
 * suppresses the original extraction text.
 */
function previousTextHashes(db: DatabaseSync, id: string): string[] {
  try {
    const rows = db
      .prepare(`SELECT metadata FROM memory_audit_log WHERE chunk_id = ? AND event = 'owner_edit'`)
      .all(id) as unknown as Array<{ metadata: string | null }>;
    const hashes = new Set<string>();
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.metadata ?? "{}") as { previousHash?: unknown };
        if (typeof meta.previousHash === "string" && /^[0-9a-f]{64}$/.test(meta.previousHash)) {
          hashes.add(meta.previousHash);
        }
      } catch {
        // Unparseable metadata from another writer; nothing to carry.
      }
    }
    return [...hashes];
  } catch {
    return [];
  }
}

/**
 * Delete one of the agent's own memories, everywhere it is indexed. The
 * delete, the suppressions and the audit entry commit together: a memory is
 * never gone without the record that keeps it gone.
 */
export function forgetMemory(db: DatabaseSync, id: string, tables: IndexTables): void {
  const memory = editableOrThrow(db, id);
  db.exec("BEGIN");
  try {
    if (tables.vectorTable) tryRun(db, `DELETE FROM ${tables.vectorTable} WHERE id = ?`, id);
    if (tables.ftsTable) tryRun(db, `DELETE FROM ${tables.ftsTable} WHERE id = ?`, id);
    for (const table of ["near_merge_hints", "orphan_replay_queue", "curiosity_surprises"]) {
      tryRun(db, `DELETE FROM ${table} WHERE chunk_id = ?`, id);
    }
    db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
    // The text hash keeps re-extraction, curiosity and dream promotion from
    // writing the same memory back under a new id; an edited memory's
    // earlier texts are suppressed too, or the original would regrow.
    const hashes = [chunkTextHash(memory.text), ...previousTextHashes(db, id)];
    const suppressionIds = [...new Set(hashes)].map(
      (hash) => addSuppression(db, { kind: "chunk_hash", hash, reason: "owner_forget" }).id,
    );
    writeAudit(db, id, "owner_forget", {
      length: memory.text.length,
      semanticType: memory.semanticType,
      suppressionId: suppressionIds[0] ?? null,
      suppressionIds,
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Retire a settled fact as the owner (PLAN-55 Phase 0): the row becomes
 * `owner_retired` and its key/value is suppressed, so extraction, promotion
 * and the agent's own pins cannot bring it back. Only unretireFact() or an
 * owner-tier pin (pinFact) lifts it. Status, suppression and audit entry
 * commit together.
 */
export function retireFact(db: DatabaseSync, store: CanonicalFactsStore, key: string): boolean {
  return inSavepoint(db, "owner_retire_fact", () => {
    const ok = store.retire(key, { reason: "owner" });
    if (ok) {
      writeAudit(db, `fact:${store.get(key)?.key ?? key}`, "owner_retire_fact", {});
    }
    return ok;
  });
}

/** Lift a retirement, whoever made it, and the suppression that came with it. */
export function unretireFact(db: DatabaseSync, store: CanonicalFactsStore, key: string): boolean {
  return inSavepoint(db, "owner_unretire_fact", () => {
    const ok = store.unretire(key);
    if (ok) {
      writeAudit(db, `fact:${store.get(key)?.key ?? key}`, "owner_unretire_fact", {});
    }
    return ok;
  });
}

export type OwnerPinResult =
  | { ok: true; op: "add" | "strengthen" | "supersede"; key: string; value: string }
  | { ok: false; reason: string };

/**
 * Pin a fact as the owner (PLAN-55 Phase 0, the `owner` tier's writer): the
 * value the owner states outranks the agent's pins and every background
 * source, reactivates an owner-retired fact and lifts its suppression.
 */
export function pinFact(
  db: DatabaseSync,
  store: CanonicalFactsStore,
  input: { key: string; value: string; category?: string; statement?: string },
): OwnerPinResult {
  return inSavepoint(db, "owner_pin_fact", () => {
    const result = store.pin({
      key: input.key,
      value: input.value,
      statement: input.statement,
      category: input.category,
      confidence: 0.95,
      source: "owner",
    });
    if (result.op === "rejected") {
      return { ok: false, reason: result.reason };
    }
    writeAudit(db, `fact:${result.fact.key}`, "owner_pin_fact", { op: result.op });
    return { ok: true, op: result.op, key: result.fact.key, value: result.fact.value };
  });
}

/** Replace the text of one of the agent's own memories. Re-embedding follows. */
export function editMemory(
  db: DatabaseSync,
  id: string,
  text: string,
  tables: IndexTables,
): MemoryDetail {
  const next = text.trim();
  if (!next) {
    throw new OwnerEditRefused("The new text is empty; forget the memory instead.");
  }
  if (next.length > 20_000) {
    throw new OwnerEditRefused("That is too long for one memory (20,000 characters at most).");
  }
  const memory = editableOrThrow(db, id);
  const now = Date.now();
  db.exec("BEGIN");
  try {
    setChunkText(db, id, {
      text: next,
      hash: hashText(next),
      updatedAt: now,
      version: (memory.version ?? 0) + 1,
    });
    // The old vector no longer describes the text; drop it until re-embedding.
    if (tables.vectorTable) tryRun(db, `DELETE FROM ${tables.vectorTable} WHERE id = ?`, id);
    if (tables.ftsTable) {
      tryRun(db, `DELETE FROM ${tables.ftsTable} WHERE id = ?`, id);
      tryRun(
        db,
        `INSERT INTO ${tables.ftsTable} (text, id, path, source, model, start_line, end_line)
         VALUES (?, ?, ?, ?, 'pending', 0, 0)`,
        next,
        id,
        memory.path ?? "",
        memory.source,
      );
    }
    // The hash (never the text) of what was replaced, so a later forget can
    // suppress the original extraction text as well as the edited one.
    writeAudit(db, id, "owner_edit", {
      before: memory.text.length,
      after: next.length,
      previousHash: chunkTextHash(memory.text),
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getMemory(db, id) as MemoryDetail;
}

/**
 * Write everything the agent remembers to a JSON file: memories with their
 * metadata (no embeddings), the facts ledger with its history, and learned
 * preferences. Batched with yields so the gateway stays responsive.
 */
export async function exportMemories(
  db: DatabaseSync,
  outFile: string,
  extra: { agentId: string; workingMemory?: string | null },
): Promise<{ file: string; memories: number; facts: number; preferences: number }> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  const out = fs.openSync(outFile, "w", 0o600);
  let memories = 0;
  const write = (s: string) => fs.writeSync(out, s);
  try {
    write(
      `{"exportedAt":${JSON.stringify(new Date().toISOString())},"agentId":${JSON.stringify(extra.agentId)},"memories":[`,
    );
    let cursor = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = db
        .prepare(
          `SELECT rowid, id, source, path, semantic_type, lifecycle, lifecycle_state, importance_score,
                  created_at, updated_at, text, governance_json, access_count, last_accessed_at, version
             FROM chunks WHERE rowid < ? ORDER BY rowid DESC LIMIT 200`,
        )
        .all(cursor) as unknown as ChunkRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        write(
          `${memories > 0 ? "," : ""}${JSON.stringify({
            id: row.id,
            kind: kindOf(row.id),
            source: row.source,
            path: row.path,
            semanticType: row.semantic_type,
            lifecycle: row.lifecycle_state === "forgotten" ? "forgotten" : row.lifecycle,
            importance: row.importance_score,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            text: row.text,
          })}`,
        );
        memories += 1;
      }
      cursor = rows.at(-1)!.rowid;
      await yieldToEventLoop();
    }
    const select = (sql: string) => {
      try {
        return db.prepare(sql).all() as unknown[];
      } catch {
        return [];
      }
    };
    const facts = select(
      "SELECT key, value, statement, category, confidence, status, valid_from, valid_until, superseded_by, source FROM canonical_facts ORDER BY key, valid_from",
    );
    const preferences = select(
      "SELECT category, key, value, confidence, created_at, updated_at FROM user_preferences ORDER BY category, key",
    );
    write(`],"facts":${JSON.stringify(facts)},"preferences":${JSON.stringify(preferences)}`);
    write(`,"workingMemory":${JSON.stringify(extra.workingMemory ?? null)}}`);
    return { file: outFile, memories, facts: facts.length, preferences: preferences.length };
  } finally {
    fs.closeSync(out);
  }
}

/** Learned preferences, which the owner can remove one at a time. */
export function listPreferences(
  db: DatabaseSync,
): Array<{ category: string; key: string; value: string; confidence: number | null }> {
  try {
    return db
      .prepare(
        "SELECT category, key, value, confidence FROM user_preferences ORDER BY category, key",
      )
      .all() as unknown as Array<{
      category: string;
      key: string;
      value: string;
      confidence: number | null;
    }>;
  } catch {
    return [];
  }
}

/**
 * Remove a learned preference. Both the key and the (loosely normalised)
 * value are suppressed, in the same transaction as the delete: the
 * directive writer dedupes restatements by word overlap, so a reworded
 * "always reply in Spanish" would otherwise mint a new key.
 */
export function deletePreference(db: DatabaseSync, category: string, key: string): boolean {
  return inSavepoint(db, "owner_forget_preference", () => {
    const row = db
      .prepare("SELECT value FROM user_preferences WHERE category = ? AND key = ?")
      .get(category, key) as { value: string } | undefined;
    if (!row) {
      return false;
    }
    db.prepare("DELETE FROM user_preferences WHERE category = ? AND key = ?").run(category, key);
    const keySuppression = addSuppression(db, {
      kind: "preference_key",
      hash: preferenceKeyHash(category, key),
      reason: "owner_forget_preference",
    });
    const valueSuppression = addSuppression(db, {
      kind: "preference_value",
      hash: preferenceValueHash(category, row.value ?? ""),
      text: normalizeLoose(row.value ?? ""),
      reason: "owner_forget_preference",
    });
    writeAudit(db, `pref:${category}:${key}`, "owner_forget_preference", {
      suppressionId: keySuppression.id,
      suppressionIds: [keySuppression.id, valueSuppression.id],
    });
    return true;
  });
}

export type AuditEntry = {
  id: string;
  chunkId: string | null;
  event: string;
  operation: string | null;
  actor: string;
  timestamp: number;
};

/**
 * The memory audit log, newest first (PLAN-53 G2). Metadata is left out: some
 * writers put memory text there, and this list is for seeing what happened,
 * not re-reading what was forgotten.
 */
export function listAuditLog(
  db: DatabaseSync,
  opts: { limit?: number; before?: number; event?: string } = {},
): AuditEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (opts.before != null) {
    where.push("timestamp < ?");
    args.push(opts.before);
  }
  if (opts.event) {
    where.push("event = ?");
    args.push(opts.event);
  }
  const hasOperation = (
    db.prepare("PRAGMA table_info(memory_audit_log)").all() as Array<{ name: string }>
  ).some((c) => c.name === "operation");
  try {
    const rows = db
      .prepare(
        `SELECT id, chunk_id, event, ${hasOperation ? "operation" : "NULL AS operation"}, actor, timestamp
           FROM memory_audit_log ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...args, limit) as unknown as Array<{
      id: string;
      chunk_id: string | null;
      event: string;
      operation: string | null;
      actor: string;
      timestamp: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      chunkId: r.chunk_id,
      event: r.event,
      operation: r.operation,
      actor: r.actor,
      timestamp: r.timestamp,
    }));
  } catch {
    return [];
  }
}
