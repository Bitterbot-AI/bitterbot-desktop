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
 * 4. Trust tier (Victor's rule C). Imported facts are written with source
 *    `import` (tier 1, the extraction tier). By default NO fact gets the
 *    owner tier: a fact that was `owner` (or `user_directive`) in the export
 *    is imported at tier 1 and listed in `ownerFactsUnconfirmed` (the audit
 *    entry records it with `exportedTier: "owner"`); the owner confirms one
 *    by pinning it (`memory.pinFact`). A hand-edited or third-party export
 *    must not carry owner authority by accident. Opt-in: `keepOwnerTier`
 *    with an owner-initiated import (`actor: "owner"`) writes those facts at
 *    the owner tier, and only when `confirmOwnerTierGrantsHash` equals the
 *    hash of the exact grants computed at apply time (`ownerTierGrantsHash`:
 *    sha256 over the sorted key/value/scope of every grant, which a dry run
 *    reports with the count and `replacesOwnerValues`, how many grants
 *    replace one of this agent's own owner-tier values); a missing or
 *    different hash is refused, like a stale planHash, so a confirmation is
 *    bound to content, not to a count. Only the current value of a key is
 *    ever written at the owner tier; its history rows are written as
 *    `import`. An imported fact never replaces an active fact of a higher
 *    tier (counted `lowerTier`); against an equal or lower tier the ledger's
 *    own pin rules decide, so the change is recorded and propagated like any
 *    other. A key the ledger does not have yet is restored with its history
 *    (superseded and retired rows included).
 * 5. Credentials. A fact whose key or value has the shape of a secret is
 *    refused (`secret`), as the ledger refuses it from any source; a fact or
 *    preference whose value holds the export's `[redacted]` placeholder is
 *    skipped (`redacted`). History rows get the same checks as the current
 *    one: a suppressed or credential-shaped history row is dropped
 *    (`historyDropped`), so an import never restores a suppressed value in
 *    any status.
 * 6. Capacity. Facts that would become active are written only into the
 *    ledger's free capacity (CanonicalFactsStore.freeSlots); the rest are
 *    skipped and counted (`overCapacity`, also on a dry run). An import never
 *    evicts a fact this agent already has.
 * 7. Clamping. Imported values never outrank native ones by construction:
 *    a fact's mention count is capped at MAX_IMPORTED_MENTIONS and its
 *    timestamps are clamped to [2000-01-01, now]; a memory's importance to
 *    [0, 1]; a preference's confidence to IMPORTED_PREFERENCE_CONFIDENCE
 *    (the extraction default). A memory's `directive` epistemic layer and a
 *    preference's `identity` or `directive` category (the ones proactive
 *    recall always includes or ranks first) are downgraded (to `experience`
 *    and `personal`, counted `downgraded`); the owner re-states what still
 *    holds. Imported memories are stamped `session_trust = 'untrusted'`, so
 *    nothing treats them as first-party.
 *
 * Imported memories land unembedded (model "pending") and keyword-indexed;
 * the caller re-embeds them in the background. Preferences have no source
 * column; imported rows get an `import_` id. One `owner_import` audit entry
 * records the counts. Every decision loop yields to the event loop every
 * YIELD_EVERY items, and writes are batched (one transaction per batch, a
 * yield between batches). `dryRun` makes every decision and writes nothing.
 * The RPC's JSON.parse of the export is synchronous; it is bounded by the
 * gateway's 8 MiB frame cap (the CLI's file import by MAX_IMPORT_BYTES).
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
  OWNER_TRUST_TIER,
} from "./canonical-facts.js";
import { insertImportedChunk } from "./chunk-writer.js";
import { makeYieldEvery, yieldToEventLoop } from "./event-loop.js";
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
import { SECRET_REDACTION, secretRejectionReason } from "./secret-shape.js";

/** Largest export accepted as text (the gateway's WebSocket frame cap is lower, 8 MiB). */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const BATCH = 200;
/** Decision-loop items between yields to the event loop. */
export const YIELD_EVERY = 250;
/** An imported fact's mention count is capped here, so it cannot outscore native facts. */
export const MAX_IMPORTED_MENTIONS = 3;
/** Imported preferences never start above the extraction default. */
export const IMPORTED_PREFERENCE_CONFIDENCE = 0.5;
/** Earliest timestamp an import keeps (2000-01-01); earlier or later values are clamped. */
const MIN_IMPORT_TS = Date.UTC(2000, 0, 1);
/** Preference categories proactive recall always includes or ranks first. */
const PRIVILEGED_PREFERENCE_CATEGORIES = new Set(["identity", "directive"]);

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
  /** Rule C opt-in: write facts that were owner-tier in the export at the owner tier. */
  keepOwnerTier?: boolean;
  /** Required with keepOwnerTier (not on a dry run): the dry run's `ownerTierGrantsHash`. */
  confirmOwnerTierGrantsHash?: string;
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
  memories: Tally & { fileBacked: number; forgotten: number; downgraded: number };
  facts: Tally & {
    lowerTier: number;
    secret: number;
    redacted: number;
    historyRows: number;
    /** History rows dropped because they were suppressed, credential-shaped or redacted. */
    historyDropped: number;
    /** Facts skipped because the ledger had no free capacity for them. */
    overCapacity: number;
    ledgerOff: number;
  };
  preferences: Tally & { redacted: number; downgraded: number };
  /** How many facts this import writes (or would write) at the owner tier. */
  ownerTierGrants: number;
  /** sha256 over the sorted key/value/scope of the owner-tier grants (what keepOwnerTier confirms). */
  ownerTierGrantsHash: string;
  /** Owner-tier grants that replace a different owner-tier value this agent already holds. */
  replacesOwnerValues: number;
  /** Whether keepOwnerTier was used. */
  keepOwnerTier: boolean;
  /** Owner-tier facts in the export imported below the owner tier; pin one to confirm it. */
  ownerFactsUnconfirmed: Array<{ key: string; value: string; scope: string }>;
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

/** A timestamp from the export, clamped to [2000-01-01, now]; `fallback` when missing. */
const clampTs = (t: number | null | undefined, now: number, fallback: number): number =>
  typeof t === "number" && Number.isFinite(t)
    ? Math.min(now, Math.max(MIN_IMPORT_TS, t))
    : fallback;

const isRedacted = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.includes(SECRET_REDACTION);

/** The rule C confirmation hash: stable over the sorted key/value/scope of every grant. */
export function hashOwnerTierGrants(
  grants: Array<{ key: string; value: string; scope: string }>,
): string {
  const lines = grants.map((g) => `${g.key}\u0000${g.value}\u0000${g.scope}`).toSorted();
  return crypto.createHash("sha256").update(JSON.stringify(lines)).digest("hex");
}

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

const wasOwner = (raw: string | undefined): boolean => raw === "owner" || raw === "user_directive";

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
  const keepOwnerTier = opts.keepOwnerTier === true;
  if (keepOwnerTier && opts.actor !== "owner") {
    throw new MemoryImportRefused("Only the owner can import facts at the owner tier.");
  }
  const mappedSource = (raw: string | undefined): CanonicalSource =>
    keepOwnerTier && wasOwner(raw) ? "owner" : "import";
  const result: MemoryImportResult = {
    version: doc.version ?? 1,
    dryRun,
    memories: { ...tally(), fileBacked: 0, forgotten: 0, downgraded: 0 },
    facts: {
      ...tally(),
      lowerTier: 0,
      secret: 0,
      redacted: 0,
      historyRows: 0,
      historyDropped: 0,
      overCapacity: 0,
      ledgerOff: 0,
    },
    preferences: { ...tally(), redacted: 0, downgraded: 0 },
    ownerTierGrants: 0,
    ownerTierGrantsHash: hashOwnerTierGrants([]),
    replacesOwnerValues: 0,
    keepOwnerTier,
    ownerFactsUnconfirmed: [],
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
  const memTick = makeYieldEvery(YIELD_EVERY);
  for (const raw of doc.memories) {
    await memTick();
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
    // A directive is what the owner told the agent to do; an export cannot
    // say that on their behalf.
    const epistemicLayer = mem.epistemicLayer === "directive" ? "experience" : mem.epistemicLayer;
    if (epistemicLayer !== mem.epistemicLayer) {
      result.memories.downgraded += 1;
    }
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
        importance:
          typeof mem.importance === "number" ? Math.min(1, Math.max(0, mem.importance)) : null,
        createdAt: clampTs(mem.createdAt, now, now),
        updatedAt: now,
        epistemicLayer: epistemicLayer ?? null,
        sessionTrust: "untrusted",
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

  // ── Facts ──
  const factRows: Array<z.infer<typeof FactSchema>> = [];
  const factTick = makeYieldEvery(YIELD_EVERY);
  for (const raw of doc.facts ?? []) {
    await factTick();
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
  const grants: Array<{ key: string; value: string; scope: string }> = [];
  const noteOwnerTier = (
    key: string,
    row: { value: string; scope?: string | null; source?: string },
    source: CanonicalSource,
  ) => {
    if (source === "owner") {
      result.ownerTierGrants += 1;
      grants.push({
        key,
        value: row.value,
        scope: normalizeCanonicalScope(row.scope ?? "global") ?? "global",
      });
    } else if (wasOwner(row.source)) {
      result.ownerFactsUnconfirmed.push({
        key,
        value: row.value,
        scope: normalizeCanonicalScope(row.scope ?? "global") ?? "global",
      });
    }
  };
  const factOps: Array<() => void> = [];
  const pinOps: Array<() => void> = [];
  // H1: what may become active is bounded by the ledger's free capacity, so
  // an import never makes the next pin evict this agent's own facts.
  let freeSlots = store ? store.freeSlots() : 0;
  const keyTick = makeYieldEvery(YIELD_EVERY);
  for (const [key, allRows] of byKey) {
    await keyTick();
    if (!store) {
      result.facts.ledgerOff += 1;
      continue;
    }
    const current =
      allRows
        .filter((r) => r.valid_until == null)
        .toSorted((a, b) => (b.valid_from ?? 0) - (a.valid_from ?? 0))[0] ?? null;
    const head = current ?? allRows[0]!;
    if (secretRejectionReason(key, head.value)) {
      result.facts.secret += 1;
      continue;
    }
    if (isRedacted(head.value)) {
      result.facts.redacted += 1;
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
      const source = mappedSource(current.source);
      if (
        existing.status === "owner_retired" ||
        (existing.status === "active" &&
          canonicalSourceTier(existing.source) > canonicalSourceTier(source))
      ) {
        result.facts.lowerTier += 1;
        continue;
      }
      // A key with no active row becomes active again: that takes a slot.
      if (existing.status !== "active") {
        if (freeSlots <= 0) {
          result.facts.overCapacity += 1;
          continue;
        }
        freeSlots -= 1;
      }
      if (
        source === "owner" &&
        existing.status === "active" &&
        canonicalSourceTier(existing.source) >= OWNER_TRUST_TIER
      ) {
        result.replacesOwnerValues += 1;
      }
      noteOwnerTier(key, current, source);
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
    // A key this ledger has never seen: restore it with its history. A
    // suppressed value never comes back, as the current row or as history.
    const valueSuppressed = (value: string) =>
      Boolean(isSuppressed(db, "fact_key_value", factKeyValueHash(key, value)));
    if (current && valueSuppressed(current.value)) {
      result.facts.suppressed += 1;
      continue;
    }
    const rows = allRows.filter(
      (r) =>
        r === current ||
        !(valueSuppressed(r.value) || secretRejectionReason(key, r.value) || isRedacted(r.value)),
    );
    result.facts.historyDropped += allRows.length - rows.length;
    if (rows.length === 0) {
      continue; // nothing left to restore for this key
    }
    const becomesActive = current !== null && (current.status ?? "active") === "active";
    if (becomesActive) {
      if (freeSlots <= 0) {
        result.facts.overCapacity += 1;
        continue;
      }
      freeSlots -= 1;
    }
    result.facts.imported += 1;
    result.facts.historyRows += rows.length - (current ? 1 : 0);
    if (current) {
      noteOwnerTier(key, current, mappedSource(current.source));
    }
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
        // Only the current value can carry the owner tier (and is counted in
        // the grants); history rows are written as `import`.
        const source: CanonicalSource = isCurrent ? mappedSource(r.source) : "import";
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
          Math.min(MAX_IMPORTED_MENTIONS, Math.max(1, Math.floor(r.mention_count ?? 1))),
          clampTs(r.first_seen_at, now, now),
          clampTs(r.last_confirmed_at, now, now),
          clampTs(r.valid_from, now, now),
          isCurrent ? null : clampTs(r.valid_until ?? r.valid_from, now, now),
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
  // Rule C: owner authority is granted only for the exact grants the owner
  // confirmed from a dry run (their hash, not their number); checked before
  // anything is written.
  result.ownerTierGrantsHash = hashOwnerTierGrants(grants);
  if (keepOwnerTier && !dryRun && opts.confirmOwnerTierGrantsHash !== result.ownerTierGrantsHash) {
    throw new MemoryImportRefused(
      `This import would give ${result.ownerTierGrants} fact(s) owner authority, but ${
        opts.confirmOwnerTierGrantsHash === undefined
          ? "no confirmation hash was given"
          : "the confirmation hash does not match them"
      }. Dry-run again and confirm the ownerTierGrantsHash it reports.`,
    );
  }
  await runBatched(db, memoryOps, "owner_import_memories");
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
  const prefTick = makeYieldEvery(YIELD_EVERY);
  for (const raw of prefStmt ? (doc.preferences ?? []) : []) {
    await prefTick();
    const p = PreferenceSchema.safeParse(raw);
    if (!p.success) {
      result.preferences.invalid += 1;
      continue;
    }
    const parsedPref = p.data;
    if (isRedacted(parsedPref.value)) {
      result.preferences.redacted += 1;
      continue;
    }
    // `identity` and `directive` are what proactive recall always includes
    // or ranks first; an export cannot put words there for the owner.
    const downgrade = PRIVILEGED_PREFERENCE_CATEGORIES.has(parsedPref.category);
    const pref = downgrade ? { ...parsedPref, category: "personal" } : parsedPref;
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
    if (downgrade) {
      result.preferences.downgraded += 1;
    }
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
        Math.min(Math.max(pref.confidence ?? 0.5, 0), IMPORTED_PREFERENCE_CONFIDENCE),
        typeof pref.evidence_ids === "string" ? pref.evidence_ids : "[]",
        clampTs(pref.created_at, now, now),
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
          keepOwnerTier,
          ownerTierGrants: result.ownerTierGrants,
          ownerTierGrantsHash: result.ownerTierGrantsHash,
          replacesOwnerValues: result.replacesOwnerValues,
          ownerFactsUnconfirmed: result.ownerFactsUnconfirmed.map((f) => ({
            key: f.key,
            exportedTier: "owner",
          })),
          memories: result.memories,
          facts: result.facts,
          preferences: result.preferences,
        }),
      );
    });
  }
  return result;
}
