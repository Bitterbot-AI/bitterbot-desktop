/**
 * PLAN-55 Phase 3 (D5): restore a memory export (version 1 or 2).
 *
 * What comes back: the agent's own memories (facts, notes, insights, the
 * rest of OWNER_EDITABLE_PREFIXES), the facts ledger and learned
 * preferences. Memories indexed from files and transcripts are skipped and
 * counted: they come back by copying the files and reindexing, and an
 * imported copy would be a second, unmanaged version of them.
 *
 * The rules, in order, for every item:
 *
 * 1. Validated with zod; an item that does not parse is counted `invalid`
 *    and skipped (the import as a whole fails only when the document is not
 *    an export at all).
 * 2. Suppressions win. A memory whose text hash, a fact whose key/value, or
 *    a preference whose key or value the owner suppressed on THIS agent is
 *    skipped and counted `suppressed`. Importing never lifts a suppression.
 * 3. Dedupe. A memory whose id or exact text already exists, a fact whose
 *    key already holds the same value, a preference whose category/key
 *    already exists: `duplicate`.
 * 4. Trust tier. Imported facts are written with source `import` (tier 1,
 *    the extraction tier). A fact keeps the `owner` tier only when it was
 *    `owner` (or its alias `user_directive`) in the export AND the import is
 *    owner-initiated (`actor: "owner"`, which the admin-scoped RPC and the
 *    CLI pass). An imported fact never replaces an active fact of a higher
 *    tier (counted `lowerTier`); against an equal or lower tier the ledger's
 *    own pin rules decide, so the change is recorded and propagated like any
 *    other. A key the ledger does not have yet is restored with its full
 *    history (superseded and retired rows included).
 * 5. Credentials. A fact whose key or value has the shape of a secret is
 *    refused (`secret`), as the ledger refuses it from any source.
 *
 * Imported memories land unembedded (model "pending") and keyword-indexed;
 * the caller re-embeds them in the background. Preferences have no source
 * column; imported rows get an `import_` id. One `owner_import` audit entry
 * records the counts. Writes are batched (one transaction per batch, a yield
 * between batches). `dryRun` makes every decision and writes nothing.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  canonicalSourceTier,
  type CanonicalFactsStore,
  type CanonicalSource,
  normalizeCanonicalKey,
  normalizeCanonicalScope,
} from "./canonical-facts.js";
import { insertImportedChunk } from "./chunk-writer.js";
import { yieldToEventLoop } from "./event-loop.js";
import { hashText } from "./internal.js";
import {
  chunkTextHash,
  factKeyValueHash,
  inSavepoint,
  isSuppressed,
  normalizeExact,
  preferenceKeyHash,
  preferenceValueHash,
} from "./memory-suppressions.js";
import { secretRejectionReason } from "./secret-shape.js";

/** Largest export accepted as text (the gateway's WebSocket frame cap is lower, 8 MiB). */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const BATCH = 200;

const OWN_PREFIXES = [
  "fact_",
  "note_",
  "scratch_",
  "dream_insight_",
  "distill_",
  "crule_",
  "hygiene_merge_",
  "seed_",
];

const num = z.number().finite().nullable().optional();
const str = z.string().nullable().optional();

const MemorySchema = z
  .object({
    id: z.string().min(1).max(300),
    kind: z.string().optional(),
    source: str,
    path: str,
    semanticType: str,
    lifecycle: str,
    importance: num,
    createdAt: num,
    updatedAt: num,
    text: z.string().min(1).max(100_000),
    epistemicLayer: str,
    sensitivity: str,
  })
  .passthrough();

const FactSchema = z
  .object({
    id: z.string().min(1).max(300).optional(),
    key: z.string().min(1).max(300),
    value: z.string().min(1).max(5_000),
    statement: str,
    category: str,
    confidence: num,
    mention_count: num,
    first_seen_at: num,
    last_confirmed_at: num,
    status: z.string().optional(),
    valid_from: num,
    valid_until: num,
    superseded_by: str,
    source: z.string().optional(),
    evidence_chunk_ids: str,
    scope: str,
    evidence_ref: str,
  })
  .passthrough();

const PreferenceSchema = z
  .object({
    id: z.string().optional(),
    category: z.string().min(1).max(200),
    key: z.string().min(1).max(300),
    value: z.string().min(1).max(5_000),
    confidence: num,
    evidence_ids: str,
    created_at: num,
    updated_at: num,
  })
  .passthrough();

const ExportSchema = z
  .object({
    format: z.string().optional(),
    version: z.union([z.literal(1), z.literal(2)]).optional(),
    exportedAt: z.string().optional(),
    agentId: z.string().optional(),
    memories: z.array(z.unknown()),
    facts: z.array(z.unknown()).optional(),
    preferences: z.array(z.unknown()).optional(),
  })
  .passthrough();

export class MemoryImportRefused extends Error {}

export type ImportActor = "owner" | "system";

export type MemoryImportOptions = {
  /** Who is importing. Only `owner` keeps owner-tier facts at the owner tier. */
  actor: ImportActor;
  dryRun?: boolean;
  store: CanonicalFactsStore | null;
  tables: { ftsTable: string | null };
};

type Tally = {
  imported: number;
  duplicate: number;
  suppressed: number;
  invalid: number;
};

export type MemoryImportResult = {
  version: 1 | 2;
  dryRun: boolean;
  memories: Tally & { fileBacked: number; forgotten: number };
  facts: Tally & { lowerTier: number; secret: number; historyRows: number; ledgerOff: number };
  preferences: Tally;
  /** Ids of imported memories (to re-embed). Empty on a dry run. */
  importedChunkIds: string[];
};

/** Parse an export from text, with the size cap and a clear error. */
export function parseMemoryExport(raw: unknown, maxBytes: number = MAX_IMPORT_BYTES): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > maxBytes) {
    throw new MemoryImportRefused(
      `The export is ${(bytes / 1024 / 1024).toFixed(1)} MB; imports are capped at ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new MemoryImportRefused("That is not JSON; expected a Bitterbot memory export.");
  }
}

const tally = (): Tally => ({ imported: 0, duplicate: 0, suppressed: 0, invalid: 0 });

/** Run `ops` in batches, one transaction each, yielding between batches. */
async function runBatched(db: DatabaseSync, ops: Array<() => void>, name: string): Promise<void> {
  for (let i = 0; i < ops.length; i += BATCH) {
    const slice = ops.slice(i, i + BATCH);
    inSavepoint(db, name, () => {
      for (const op of slice) op();
    });
    await yieldToEventLoop();
  }
}

function mappedSource(raw: string | undefined, actor: ImportActor): CanonicalSource {
  const owner = raw === "owner" || raw === "user_directive";
  return owner && actor === "owner" ? "owner" : "import";
}

export async function importMemories(
  db: DatabaseSync,
  input: unknown,
  opts: MemoryImportOptions,
): Promise<MemoryImportResult> {
  const parsed = ExportSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryImportRefused(
      "That is not a Bitterbot memory export (expected an object with a memories list).",
    );
  }
  const doc = parsed.data;
  if (doc.format && doc.format !== "bitterbot-memory-export") {
    throw new MemoryImportRefused(`Unknown export format "${doc.format}".`);
  }
  const dryRun = opts.dryRun === true;
  const result: MemoryImportResult = {
    version: doc.version ?? 1,
    dryRun,
    memories: { ...tally(), fileBacked: 0, forgotten: 0 },
    facts: { ...tally(), lowerTier: 0, secret: 0, historyRows: 0, ledgerOff: 0 },
    preferences: tally(),
    importedChunkIds: [],
  };
  const now = Date.now();

  // ── Memories ──
  // Exact-text dedupe against this agent's own memories only (the only kind
  // an import writes), read by primary-key range so a large database is not
  // scanned whole: "`" sorts right after "_", so [prefix, prefix-with-"`")
  // is every id starting with the prefix.
  const existingHashes = new Set<string>();
  {
    const stmt = db.prepare(
      `SELECT id, hash FROM chunks WHERE id > ? AND id < ? ORDER BY id LIMIT 2000`,
    );
    for (const prefix of OWN_PREFIXES) {
      const upper = `${prefix.slice(0, -1)}\u0060`;
      let after = prefix;
      for (;;) {
        const rows = stmt.all(after, upper) as Array<{ id: string; hash: string | null }>;
        for (const r of rows) {
          if (r.hash) existingHashes.add(r.hash);
        }
        if (rows.length < 2000) break;
        after = rows[rows.length - 1]!.id;
        await yieldToEventLoop();
      }
    }
  }
  const idExists = db.prepare(`SELECT 1 FROM chunks WHERE id = ?`);
  const seenIds = new Set<string>();
  const memoryOps: Array<() => void> = [];
  for (const raw of doc.memories) {
    const m = MemorySchema.safeParse(raw);
    if (!m.success) {
      result.memories.invalid += 1;
      continue;
    }
    const mem = m.data;
    if (!OWN_PREFIXES.some((p) => mem.id.startsWith(p))) {
      result.memories.fileBacked += 1;
      continue;
    }
    if (mem.lifecycle === "forgotten" || mem.lifecycle === "expired") {
      result.memories.forgotten += 1;
      continue;
    }
    if (isSuppressed(db, "chunk_hash", chunkTextHash(mem.text))) {
      result.memories.suppressed += 1;
      continue;
    }
    const hash = hashText(mem.text);
    if (seenIds.has(mem.id) || existingHashes.has(hash) || idExists.get(mem.id)) {
      result.memories.duplicate += 1;
      continue;
    }
    seenIds.add(mem.id);
    existingHashes.add(hash);
    result.memories.imported += 1;
    if (dryRun) {
      continue;
    }
    result.importedChunkIds.push(mem.id);
    memoryOps.push(() => {
      const inserted = insertImportedChunk(db, {
        id: mem.id,
        path: `import/${mem.id}`,
        source: "memory",
        text: mem.text,
        hash,
        semanticType: mem.semanticType ?? null,
        lifecycle: "generated",
        importance: mem.importance ?? null,
        createdAt: mem.createdAt ?? now,
        updatedAt: now,
        epistemicLayer: mem.epistemicLayer ?? null,
        governanceJson: mem.sensitivity ? JSON.stringify({ sensitivity: mem.sensitivity }) : null,
      });
      if (inserted && opts.tables.ftsTable) {
        try {
          db.prepare(
            `INSERT INTO ${opts.tables.ftsTable} (text, id, path, source, model, start_line, end_line)
             VALUES (?, ?, ?, 'memory', 'pending', 0, 0)`,
          ).run(mem.text, mem.id, `import/${mem.id}`);
        } catch {
          // No keyword index on this database.
        }
      }
    });
  }
  await runBatched(db, memoryOps, "owner_import_memories");

  // ── Facts ──
  const factRows: Array<z.infer<typeof FactSchema>> = [];
  for (const raw of doc.facts ?? []) {
    const f = FactSchema.safeParse(raw);
    if (!f.success || !normalizeCanonicalKey(f.data.key)) {
      result.facts.invalid += 1;
      continue;
    }
    factRows.push({ ...f.data, key: normalizeCanonicalKey(f.data.key)! });
  }
  const byKey = new Map<string, typeof factRows>();
  for (const row of factRows) {
    const list = byKey.get(row.key) ?? [];
    list.push(row);
    byKey.set(row.key, list);
  }
  const store = opts.store;
  const factOps: Array<() => void> = [];
  const pinOps: Array<() => void> = [];
  let keysSeen = 0;
  for (const [key, rows] of byKey) {
    if (++keysSeen % BATCH === 0) {
      await yieldToEventLoop();
    }
    if (!store) {
      result.facts.ledgerOff += 1;
      continue;
    }
    const current =
      rows
        .filter((r) => r.valid_until == null)
        .toSorted((a, b) => (b.valid_from ?? 0) - (a.valid_from ?? 0))[0] ?? null;
    const head = current ?? rows[0]!;
    if (secretRejectionReason(key, head.value)) {
      result.facts.secret += 1;
      continue;
    }
    const existing = store.get(key);
    if (existing) {
      // The ledger already knows the key: only the export's active value is
      // considered, through the ledger's own tier rules.
      if (!current || (current.status ?? "active") !== "active") {
        result.facts.duplicate += 1;
        continue;
      }
      if (normalizeExact(existing.value) === normalizeExact(current.value)) {
        result.facts.duplicate += 1;
        continue;
      }
      if (isSuppressed(db, "fact_key_value", factKeyValueHash(key, current.value))) {
        result.facts.suppressed += 1;
        continue;
      }
      const source = mappedSource(current.source, opts.actor);
      if (
        existing.status === "owner_retired" ||
        (existing.status === "active" &&
          canonicalSourceTier(existing.source) > canonicalSourceTier(source))
      ) {
        result.facts.lowerTier += 1;
        continue;
      }
      if (dryRun) {
        result.facts.imported += 1;
        continue;
      }
      pinOps.push(() => {
        const res = store.pin({
          key,
          value: current.value,
          statement: current.statement ?? undefined,
          category: current.category ?? undefined,
          confidence: current.confidence ?? undefined,
          source,
          scope: current.scope ?? undefined,
          evidenceRef: current.evidence_ref ?? undefined,
        });
        if (res.op === "rejected" || res.op === "held") {
          result.facts.lowerTier += 1;
        } else {
          result.facts.imported += 1;
        }
      });
      continue;
    }
    // A key this ledger has never seen: restore it with its history.
    if (
      current &&
      (current.status ?? "active") === "active" &&
      isSuppressed(db, "fact_key_value", factKeyValueHash(key, current.value))
    ) {
      result.facts.suppressed += 1;
      continue;
    }
    result.facts.imported += 1;
    result.facts.historyRows += rows.length - (current ? 1 : 0);
    if (dryRun) {
      continue;
    }
    const idMap = new Map<string, string>();
    const factIdExists = db.prepare(`SELECT 1 FROM canonical_facts WHERE id = ?`);
    for (const r of rows) {
      const id = r.id && !factIdExists.get(r.id) ? r.id : crypto.randomUUID();
      if (r.id) idMap.set(r.id, id);
    }
    const ordered = [...rows.filter((r) => r !== current), ...(current ? [current] : [])];
    for (const r of ordered) {
      factOps.push(() => {
        const isCurrent = r === current;
        const source = mappedSource(r.source, opts.actor);
        // History rows keep their history status; an "active" row that is
        // not the current one cannot be active.
        const rawStatus = r.status ?? "active";
        const status = isCurrent
          ? rawStatus === "owner_retired" && source !== "owner"
            ? "retired"
            : rawStatus
          : rawStatus === "active"
            ? "superseded"
            : rawStatus;
        db.prepare(
          `INSERT INTO canonical_facts
             (id, key, value, statement, category, confidence, mention_count, first_seen_at,
              last_confirmed_at, valid_from, valid_until, superseded_by, source,
              evidence_chunk_ids, status, scope, evidence_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          (r.id && idMap.get(r.id)) || crypto.randomUUID(),
          key,
          r.value,
          r.statement ?? `${key}: ${r.value}`,
          r.category ?? key.split(".")[0] ?? "other",
          Math.min(Math.max(r.confidence ?? 0.7, 0), 1),
          Math.max(1, Math.floor(r.mention_count ?? 1)),
          r.first_seen_at ?? now,
          r.last_confirmed_at ?? now,
          r.valid_from ?? now,
          isCurrent ? null : (r.valid_until ?? r.valid_from ?? now),
          r.superseded_by ? (idMap.get(r.superseded_by) ?? null) : null,
          source,
          typeof r.evidence_chunk_ids === "string" ? r.evidence_chunk_ids : "[]",
          status,
          normalizeCanonicalScope(r.scope ?? "global") ?? "global",
          r.evidence_ref ?? null,
        );
      });
    }
  }
  await runBatched(db, factOps, "owner_import_facts");
  await runBatched(db, pinOps, "owner_import_pins");

  // ── Preferences ──
  const prefOps: Array<() => void> = [];
  let prefStmt: ReturnType<DatabaseSync["prepare"]> | null = null;
  try {
    prefStmt = db.prepare(`SELECT 1 FROM user_preferences WHERE category = ? AND key = ?`);
  } catch {
    prefStmt = null; // no user model on this database: preferences are not restored
  }
  const seenPrefs = new Set<string>();
  for (const raw of prefStmt ? (doc.preferences ?? []) : []) {
    const p = PreferenceSchema.safeParse(raw);
    if (!p.success) {
      result.preferences.invalid += 1;
      continue;
    }
    const pref = p.data;
    if (
      isSuppressed(db, "preference_key", preferenceKeyHash(pref.category, pref.key)) ||
      isSuppressed(db, "preference_value", preferenceValueHash(pref.category, pref.value))
    ) {
      result.preferences.suppressed += 1;
      continue;
    }
    const k = `${pref.category}\u0000${pref.key}`;
    if (seenPrefs.has(k) || prefStmt!.get(pref.category, pref.key)) {
      result.preferences.duplicate += 1;
      continue;
    }
    seenPrefs.add(k);
    result.preferences.imported += 1;
    if (dryRun) {
      continue;
    }
    prefOps.push(() => {
      db.prepare(
        `INSERT OR IGNORE INTO user_preferences
           (id, category, key, value, confidence, evidence_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `import_${crypto.randomUUID()}`,
        pref.category,
        pref.key,
        pref.value,
        Math.min(Math.max(pref.confidence ?? 0.5, 0), 1),
        typeof pref.evidence_ids === "string" ? pref.evidence_ids : "[]",
        pref.created_at ?? now,
        now,
      );
    });
  }
  await runBatched(db, prefOps, "owner_import_preferences");

  if (!dryRun) {
    inSavepoint(db, "owner_import_audit", () => {
      db.prepare(
        `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
         VALUES (?, ?, 'owner_import', ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        `import:${doc.exportedAt ?? "unknown"}`,
        Date.now(),
        opts.actor,
        JSON.stringify({
          version: result.version,
          sourceAgentId: doc.agentId ?? null,
          memories: result.memories,
          facts: result.facts,
          preferences: result.preferences,
        }),
      );
    });
  }
  return result;
}
