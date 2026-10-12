/**
 * The owner's controls over what their agent remembers (PLAN-53 G1): list,
 * view, edit, forget, export (PLAN-55 Phase 3: and import).
 *
 * What can be changed. The agent's own memories (facts, notes, insights,
 * distilled rules) are rows only this database holds, so editing or
 * forgetting them sticks. Memories indexed from files (MEMORY.md, skills)
 * are rebuilt from those files on every reindex, so here they are
 * read-only: change the file instead. Memories indexed from a conversation
 * transcript can be forgotten (their text is suppressed for the reindex)
 * but not edited. Frozen memories (skills) are read-only.
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
 * Forgetting cascades (PLAN-55 Phase 3, forget-cascade.ts). A forget or an
 * edit first computes what else rests on the memory (facts, graph links,
 * dream insights, curiosity findings, preference evidence, dream-utility
 * rows), which the owner can preview (`previewForget` / `previewEdit`) and
 * confirm by the plan's hash; the cut is then applied with the chunk
 * deletion, the suppression and the audit entry. Memories indexed from a
 * transcript can be forgotten too (the transcript line itself is not
 * edited; its text hash is suppressed so a reindex does not bring it back).
 * Memories indexed from files (MEMORY.md, memory/*.md, skills) stay
 * read-only: change the file instead. An edit is a forget of the old memory
 * plus a new memory with the new text.
 *
 * Every function here takes the database handle from the caller per call:
 * the manager swaps it during a reindex, so it must never be kept.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalFactsStore } from "./canonical-facts.js";
import { insertEditedChunkCopy } from "./chunk-writer.js";
import { yieldToEventLoop } from "./event-loop.js";
import {
  applyForgetCascade,
  type CascadeApplyResult,
  type CascadeChunk,
  type CascadePlanSummary,
  type CascadeTargets,
  emptyCounts as emptyCascadeCounts,
  type ForgetCascadePlan,
  type IndexTables,
  planForgetCascade,
  summarizeCascadePlan,
} from "./forget-cascade.js";
import { hashText } from "./internal.js";
import {
  type MemoryExportExtra,
  type MemoryExportStats,
  writeMemoryExport,
} from "./memory-export.js";
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
  actor: "owner" | "system" = "owner",
): void {
  db.prepare(
    `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), chunkId, event, Date.now(), actor, JSON.stringify(metadata));
}

export type { IndexTables };

type CascadeKind = CascadeChunk["kind"];

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

/** The plan changed between the owner's preview and the confirmation. */
export class CascadePlanChanged extends OwnerEditRefused {}

/**
 * A memory the owner may forget: one of the agent's own (not frozen), or
 * one indexed from a conversation transcript (PLAN-55 Phase 3). Memories
 * indexed from files stay read-only.
 */
function forgettableOrThrow(
  db: DatabaseSync,
  id: string,
): MemoryDetail & { forgetKind: "own" | "session" } {
  const memory = getMemory(db, id);
  if (!memory) {
    throw new OwnerEditRefused("There is no memory with that id.");
  }
  if (memory.kind === "file" && memory.source === "sessions" && memory.lifecycle !== "frozen") {
    return { ...memory, forgetKind: "session" };
  }
  return { ...editableOrThrow(db, id), forgetKind: "own" };
}

/** Deterministic id for an edit's new memory, so a preview and its apply agree. */
function editedChunkId(oldId: string, text: string): string {
  const prefix = OWNER_EDITABLE_PREFIXES.find((p) => oldId.startsWith(p)) ?? "note_";
  const digest = crypto.createHash("sha256").update(`${oldId}\u0000${text}`).digest("hex");
  return `${prefix}${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function forgetTargets(db: DatabaseSync, id: string): CascadeTargets {
  const memory = forgettableOrThrow(db, id);
  return {
    mode: "forget",
    chunks: [{ id, text: memory.text, kind: memory.forgetKind, path: memory.path }],
  };
}

function editTargets(db: DatabaseSync, id: string, text: string): CascadeTargets {
  const next = text.trim();
  if (!next) {
    throw new OwnerEditRefused("The new text is empty; forget the memory instead.");
  }
  if (next.length > 20_000) {
    throw new OwnerEditRefused("That is too long for one memory (20,000 characters at most).");
  }
  const memory = getMemory(db, id);
  if (memory?.kind === "file" && memory.source === "sessions") {
    throw new OwnerEditRefused(
      "This memory is part of a conversation transcript, which is not edited here; forget it, then pin the correction as a fact.",
    );
  }
  editableOrThrow(db, id);
  // A change of case, spacing or punctuation only is not an edit: the old
  // text's suppression would also suppress the new one.
  if (normalizeLoose(next) === normalizeLoose(memory!.text)) {
    throw new OwnerEditRefused(
      "The new text is the same as the old one apart from case, spacing or punctuation; nothing to change.",
    );
  }
  return {
    mode: "edit",
    chunks: [{ id, text: memory!.text, kind: "own" }],
    replacement: { id: editedChunkId(id, next), text: next },
  };
}

/** What forgetting this memory would also change, with the hash that confirms it. */
export async function previewForget(db: DatabaseSync, id: string): Promise<CascadePlanSummary> {
  return summarizeCascadePlan(await planForgetCascade(db, forgetTargets(db, id)));
}

/** What replacing this memory's text would also change (the old memory is forgotten). */
export async function previewEdit(
  db: DatabaseSync,
  id: string,
  text: string,
): Promise<CascadePlanSummary & { newId: string }> {
  const targets = editTargets(db, id, text);
  return {
    ...summarizeCascadePlan(await planForgetCascade(db, targets)),
    newId: targets.replacement!.id,
  };
}

export type OwnerCascadeOptions = {
  /** The ledger, so retired facts emit canonical:changed. Null when the ledger is off. */
  store?: CanonicalFactsStore | null;
  /** The hash of the plan the owner previewed; refused when the plan changed since. */
  planHash?: string;
};

function checkPlanHash(plan: ForgetCascadePlan, expected: string | undefined): void {
  if (expected && expected.trim() && expected.trim() !== plan.hash) {
    throw new CascadePlanChanged(
      "What this would change is different from the preview (the memory or what rests on it changed since). Preview again.",
    );
  }
}

export type ForgetResult = CascadeApplyResult & { id: string };

/**
 * Forget a memory and everything that rests on it only (forget-cascade.ts),
 * everywhere it is indexed. The deletion, the cascade, the suppressions and
 * the audit entry commit together: a memory is never gone without the
 * record that keeps it gone. A transcript memory is suppressed by its text
 * hash so a reindex of the transcript skips it.
 */
export async function forgetMemory(
  db: DatabaseSync,
  id: string,
  tables: IndexTables,
  opts: OwnerCascadeOptions = {},
): Promise<ForgetResult> {
  const targets = forgetTargets(db, id);
  const memory = targets.chunks[0]!;
  const plan = await planForgetCascade(db, targets);
  checkPlanHash(plan, opts.planHash);
  const result = await applyForgetCascade(db, plan, {
    store: opts.store ?? null,
    tables,
    suppressKinds: new Set<CascadeKind>(["own", "session", "derived"]),
    // An edited memory's earlier texts are suppressed too, or the original
    // would regrow.
    extraHashes: new Map([[id, previousTextHashes(db, id)]]),
    after: (suppressionIds) =>
      writeAudit(db, id, "owner_forget", {
        length: memory.text.length,
        kind: memory.kind,
        suppressionId: suppressionIds[0] ?? null,
        suppressionIds,
        planHash: plan.hash,
        cascade: plan.counts,
      }),
  });
  return { ...result, id };
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
  | {
      ok: true;
      op: "add" | "strengthen" | "supersede";
      key: string;
      value: string;
      /** PLAN-55 Phase 1: the scope the fact now carries. */
      scope: string;
      /** The value this pin replaced (supersede only). */
      previousValue?: string;
    }
  | { ok: false; reason: string };

export type OwnerPinInput = {
  key: string;
  value: string;
  category?: string;
  statement?: string;
  /** PLAN-55 Phase 1: `global` (default) | `project:<name>` | `person:<name>`. */
  scope?: string;
  /** PLAN-55 Phase 1: session line ref (`session:<path>#L<n>`) or short quote. */
  evidenceRef?: string;
  /**
   * PLAN-55 Phase 1: who is asking. `owner` is the Memory page / RPC / CLI;
   * `correction` is the per-turn capture of the owner's own message;
   * `directive_answer` is the owner choosing one of the values a "which is
   * current?" question offered. Audit only: all write at the owner tier.
   */
  actor?: "owner" | "correction" | "directive_answer";
};

/**
 * Pin a fact as the owner (PLAN-55 Phase 0, the `owner` tier's writer): the
 * value the owner states outranks the agent's pins and every background
 * source, reactivates an owner-retired fact and lifts its suppression.
 */
export function pinFact(db: DatabaseSync, store: CanonicalFactsStore, input: OwnerPinInput) {
  return inSavepoint(db, "owner_pin_fact", (): OwnerPinResult => {
    const previous = store.get(input.key);
    const result = store.pin({
      key: input.key,
      value: input.value,
      statement: input.statement,
      category: input.category,
      confidence: 0.95,
      source: "owner",
      scope: input.scope,
      evidenceRef: input.evidenceRef,
    });
    if (result.op === "rejected" || result.op === "held") {
      return { ok: false, reason: result.reason };
    }
    writeAudit(db, `fact:${result.fact.key}`, "owner_pin_fact", {
      op: result.op,
      scope: result.fact.scope,
      actor: input.actor ?? "owner",
    });
    return {
      ok: true,
      op: result.op,
      key: result.fact.key,
      value: result.fact.value,
      scope: result.fact.scope,
      ...(result.op === "supersede" && previous ? { previousValue: previous.value } : {}),
    };
  });
}

export type EditResult = MemoryDetail & {
  /** The memory this one replaced (forgotten by the edit). */
  previousId: string;
  cascade: CascadeApplyResult;
};

/**
 * Replace the text of one of the agent's own memories (PLAN-55 Phase 3: an
 * edit is a forget plus a new memory). The new memory gets a new id and the
 * old one's metadata; the old one goes through the forget cascade, except
 * that what still holds in the new text moves to it: a fact whose value is
 * in the new text, a graph link whose two names are, curiosity findings and
 * preference evidence. The old text is suppressed so re-extraction does not
 * bring it back. Re-embedding follows (the new memory is keyword-searchable
 * at once).
 */
export async function editMemory(
  db: DatabaseSync,
  id: string,
  text: string,
  tables: IndexTables,
  opts: OwnerCascadeOptions = {},
): Promise<EditResult> {
  const targets = editTargets(db, id, text);
  const memory = getMemory(db, id)!;
  const replacement = targets.replacement!;
  const plan = await planForgetCascade(db, targets);
  checkPlanHash(plan, opts.planHash);
  const now = Date.now();
  const cascade = await applyForgetCascade(db, plan, {
    store: opts.store ?? null,
    tables,
    suppressKinds: new Set<CascadeKind>(["own", "derived"]),
    extraHashes: new Map([[id, previousTextHashes(db, id)]]),
    before: () => {
      const inserted = insertEditedChunkCopy(db, id, replacement.id, {
        text: replacement.text,
        hash: hashText(replacement.text),
        updatedAt: now,
        version: (memory.version ?? 0) + 1,
      });
      if (inserted !== 1) {
        throw new OwnerEditRefused("The memory changed while it was being edited; try again.");
      }
      if (tables.ftsTable) {
        tryRun(
          db,
          `INSERT INTO ${tables.ftsTable} (text, id, path, source, model, start_line, end_line)
           VALUES (?, ?, ?, ?, 'pending', 0, 0)`,
          replacement.text,
          replacement.id,
          memory.path ?? "",
          memory.source,
        );
      }
    },
    // The hash (never the text) of what was replaced, so a later forget of
    // the new memory suppresses the original extraction text as well.
    after: (suppressionIds) =>
      writeAudit(db, replacement.id, "owner_edit", {
        before: memory.text.length,
        after: replacement.text.length,
        previousId: id,
        previousHash: chunkTextHash(memory.text),
        suppressionIds,
        planHash: plan.hash,
        cascade: plan.counts,
      }),
  });
  return {
    ...(getMemory(db, replacement.id) as MemoryDetail),
    previousId: id,
    cascade,
  };
}

/** A fact that rested on a deleted conversation and was kept, and why. */
export type SessionFactSurvivor = {
  key: string;
  value: string;
  reason: "owner" | "other_evidence";
};

/**
 * PLAN-55 §3.5b: a conversation was deleted. Its indexed memories go, with
 * the cascade: a fact whose only evidence came from the conversation (its
 * memories, or a line ref into the transcript) is retired unless it is at
 * the owner tier; facts that survive (owner tier, or other evidence) are
 * returned so the owner can see them. Memories extracted from the
 * transcript (`fact_*` with the transcript as their path) go too. No text
 * suppression is written: the transcript is gone, so nothing re-extracts it,
 * and restoring the file on purpose is allowed to bring its memories back.
 */
/**
 * The memories a deleted conversation leaves in the index: its indexed
 * chunks (`sessions/<file>`) and the memories extracted from it (`fact_*`
 * with the transcript as their path). Read-only; uses the path index.
 */
export async function collectSessionChunks(
  db: DatabaseSync,
  sessionFiles: string[],
): Promise<CascadeTargets["chunks"]> {
  const files = [...new Set(sessionFiles.filter((f) => typeof f === "string" && f.trim()))];
  const chunks: CascadeTargets["chunks"] = [];
  const editedStmt = db.prepare(
    `SELECT 1 FROM memory_audit_log WHERE chunk_id = ? AND event = 'owner_edit' LIMIT 1`,
  );
  const isOwnerEdited = (id: string): boolean => Boolean(editedStmt.get(id));
  const select = db.prepare(
    `SELECT rowid AS rid, id, path, source, text FROM chunks
      WHERE path IN (?, ?) AND rowid > ? ORDER BY rowid LIMIT 1000`,
  );
  for (const file of files) {
    const indexedPath = path.join("sessions", path.basename(file)).replace(/\\/g, "/");
    let after = 0;
    for (;;) {
      const rows = select.all(indexedPath, file, after) as unknown as Array<{
        rid: number;
        id: string;
        path: string;
        source: string | null;
        text: string;
      }>;
      for (const r of rows) {
        const own = kindOf(r.id) === "own";
        if (
          (!own && r.source === "sessions" && r.path === indexedPath) ||
          // The owner's edit of an extracted memory keeps the transcript as
          // its path (provenance) but is the owner's own text now: deleting
          // the conversation does not forget it.
          (own && r.id.startsWith("fact_") && r.path === file && !isOwnerEdited(r.id))
        ) {
          chunks.push({ id: r.id, text: r.text, kind: own ? "own" : "session", path: r.path });
        }
      }
      if (rows.length < 1000) {
        break;
      }
      after = rows[rows.length - 1]!.rid;
      await yieldToEventLoop();
    }
  }
  return chunks;
}

/** The collected memories that belong to `files` (by indexed or absolute transcript path). */
export function sessionChunksForFiles(
  chunks: CascadeTargets["chunks"],
  files: string[],
): CascadeTargets["chunks"] {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file);
    paths.add(path.join("sessions", path.basename(file)).replace(/\\/g, "/"));
  }
  return chunks.filter((c) => typeof c.path === "string" && paths.has(c.path));
}

export async function forgetSessionMemories(
  db: DatabaseSync,
  sessionFiles: string[],
  tables: IndexTables,
  opts: {
    store?: CanonicalFactsStore | null;
    /**
     * Who deleted the conversation (PLAN-55 Phase 3 review M4). `owner`
     * (the Control UI, the CLI): evidence-empty facts are retired with
     * `evidence_removed`, which propagates like the owner's retire.
     * `system` (automatic housekeeping such as the subagent archive sweep):
     * they are retired with `evidence_removed_system`, which propagates like
     * the agent's own retire (no preference deletion, no stale marks), and
     * no suppression is ever written.
     */
    initiator?: "owner" | "system";
    /** Collected earlier (collectSessionChunks), before the transcript was archived. */
    chunks?: CascadeTargets["chunks"];
  } = {},
): Promise<CascadeApplyResult & { survivors: SessionFactSurvivor[] }> {
  const files = [...new Set(sessionFiles.filter((f) => typeof f === "string" && f.trim()))];
  if (files.length === 0) {
    // Nothing was deleted (every archive failed): nothing to forget.
    return {
      planHash: "",
      counts: emptyCascadeCounts(),
      retiredFacts: [],
      ownerFactsKept: [],
      retireSkipped: [],
      suppressionIds: [],
      batches: 0,
      survivors: [],
    };
  }
  const chunks = opts.chunks ?? (await collectSessionChunks(db, files));
  const plan = await planForgetCascade(db, { mode: "session", chunks, sessionFiles: files });
  const summary = summarizeCascadePlan(plan);
  const initiator = opts.initiator ?? "owner";
  const result = await applyForgetCascade(db, plan, {
    store: opts.store ?? null,
    tables,
    suppressKinds: new Set<CascadeKind>(initiator === "owner" ? ["derived"] : []),
    retireReason: initiator === "owner" ? "evidence_removed" : "evidence_removed_system",
    after: () =>
      writeAudit(
        db,
        `session:${files.map((f) => path.basename(f)).join(",")}`,
        initiator === "owner" ? "owner_forget_session" : "system_forget_session",
        {
          initiator,
          planHash: plan.hash,
          cascade: plan.counts,
        },
        initiator,
      ),
  });
  return {
    ...result,
    survivors: [
      ...summary.ownerFactsKept.map((f) => ({ ...f, reason: "owner" as const })),
      ...summary.factsKeptWithOtherEvidence.map((f) => ({
        key: f.key,
        value: f.value,
        reason: "other_evidence" as const,
      })),
    ],
  };
}

/**
 * Write everything the agent remembers to a JSON file (export version 2,
 * memory-export.ts; version 1 readers still work): memories with their
 * metadata (no embeddings), the facts ledger with its history and
 * evidence, learned preferences, the knowledge graph, dream insights,
 * curiosity findings, conflicts and open questions, suppressions, the audit
 * log, MEMORY.md and GENOME.md. Credential-shaped text is redacted. Batched
 * with yields so the gateway stays responsive. The file is 0600.
 */
export async function exportMemories(
  db: DatabaseSync,
  outFile: string,
  extra: MemoryExportExtra,
): Promise<MemoryExportStats & { file: string }> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  const out = fs.openSync(outFile, "w", 0o600);
  try {
    const stats = await writeMemoryExport(db, (piece) => void fs.writeSync(out, piece), extra);
    return { file: outFile, ...stats };
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
