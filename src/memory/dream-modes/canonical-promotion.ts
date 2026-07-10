/**
 * PLAN-33 Phase 3 — offline canonical-fact promotion (systems consolidation).
 *
 * The hot-path extractor (Phase 2) only pins what it recognizes in the moment;
 * a single conversation lacks the statistics to know a fact is load-bearing.
 * This dream mode is the sleep-cycle counterpart: during calm cycles it drains
 * the backlog of factual crystals through a cheap LLM asking one narrow
 * question — "is this stable key-value ground truth?" — and pins the hits into
 * the canonical ledger with source `promotion` at LOW confidence (0.6). A
 * dream-promoted fact earns authority only through subsequent live
 * confirmation (each re-mention STRENGTHENs it +0.05), consistent with the
 * PLAN-21 slow-update posture: background inference proposes, lived experience
 * ratifies.
 *
 * Design constraints (mirroring relationship_mining, PLAN-28 A2):
 *   - **No LLM on the hot path.** Offline, batched, gated.
 *   - **Hormonally gated.** cortisol > 0.7 skips — don't restructure memory
 *     under stress.
 *   - **Idempotent cursor.** A `meta` marker over chunk rowids drains the
 *     backlog incrementally; re-running never double-scans. Duplicate
 *     promotions of the same key/value are harmless (they STRENGTHEN).
 *   - **Tolerant parsing.** Malformed LLM JSON is dropped, never thrown.
 *   - **Bias to reject.** The prompt states most facts are NOT canonical;
 *     ledger hygiene beats recall because the cap is the editorial pressure.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CanonicalFactsStore } from "../canonical-facts.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CANONICAL_CATEGORIES, normalizeCanonicalKey } from "../canonical-facts.js";

const log = createSubsystemLogger("memory/canonical-promotion");

const CURSOR_KEY = "canonical_promotion_cursor";
const CORTISOL_SKIP_THRESHOLD = 0.7;
const BATCH_SIZE = 10;
/** Dream-promoted facts enter low; live confirmation ratifies (see header). */
const PROMOTION_CONFIDENCE = 0.6;

type FactRow = { rowid: number; id: string; text: string };

type PromotedFact = {
  i?: number;
  key?: string;
  value?: string;
};

export type CanonicalPromotionResult = {
  chunksProcessed: number;
  factsPromoted: number;
  llmCalls: number;
  skippedCortisol: boolean;
};

const EMPTY: CanonicalPromotionResult = {
  chunksProcessed: 0,
  factsPromoted: 0,
  llmCalls: 0,
  skippedCortisol: false,
};

function readCursor(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(CURSOR_KEY) as
      | { value: string }
      | undefined;
    const n = row ? parseInt(row.value, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(db: DatabaseSync, rowid: number): void {
  try {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(CURSOR_KEY, String(rowid));
  } catch (err) {
    log.debug(`canonical-promotion cursor write failed: ${String(err)}`);
  }
}

/** Build the strict-JSON promotion prompt for a batch of numbered facts. */
function buildPrompt(batch: FactRow[]): string {
  const facts = batch.map((r, i) => `${i + 1}. ${r.text.replace(/\s+/g, " ").slice(0, 300)}`);
  return (
    `You maintain a small ledger of CANONICAL facts: stable key-value ground truth ` +
    `a user treats as durable and references across many sessions — repository names, ` +
    `service endpoints, people's names/roles, standing tool or workflow choices.\n\n` +
    `For each memory fact below, decide if it states such a canonical fact. ` +
    `MOST FACTS ARE NOT CANONICAL — events, one-off details, observations, and anything ` +
    `transient must be skipped. An empty array is the common correct answer.\n\n` +
    `key: lowercase dot-slug namespaced by category prefix ` +
    `(${CANONICAL_CATEGORIES.filter((c) => c !== "other").join(". | ")}.), e.g. "project.repo".\n` +
    `value: the exact atom copied verbatim from the fact — never paraphrase a URL, slug, version, or name.\n\n` +
    `Facts:\n${facts.join("\n")}\n\n` +
    `Reply ONLY with JSON of the form ` +
    `{"canonical":[{"i":<fact number>,"key":"..","value":".."}]}. ` +
    `Use an empty array if nothing qualifies.`
  );
}

/** Tolerant parse: pull the first JSON object and read its `canonical` array. */
function parsePromotions(raw: string): PromotedFact[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    return [];
  }
  try {
    const parsed = JSON.parse(m[0]) as { canonical?: unknown };
    if (!Array.isArray(parsed.canonical)) {
      return [];
    }
    return parsed.canonical as PromotedFact[];
  } catch {
    return [];
  }
}

/**
 * Drain a bounded batch of unprocessed factual crystals, promoting canonical
 * hits into the ledger. Returns counts; advances the cursor so the next cycle
 * continues the backlog.
 */
export async function runCanonicalPromotion(params: {
  db: DatabaseSync;
  store: CanonicalFactsStore;
  llmCall: ((prompt: string) => Promise<string>) | null;
  hormones: { cortisol: number } | null;
  maxChunks: number;
}): Promise<CanonicalPromotionResult> {
  const { db, store, llmCall, hormones, maxChunks } = params;

  if (hormones && hormones.cortisol > CORTISOL_SKIP_THRESHOLD) {
    log.debug("canonical promotion skipped — cortisol too high");
    return { ...EMPTY, skippedCortisol: true };
  }
  if (!llmCall || maxChunks <= 0) {
    return EMPTY;
  }

  const cursor = readCursor(db);
  let rows: FactRow[];
  try {
    rows = db
      .prepare(
        `SELECT rowid AS rowid, id, text FROM chunks
         WHERE rowid > ?
           AND COALESCE(epistemic_layer, '') IN ('world_fact', 'directive')
           AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated', 'frozen')
           AND text IS NOT NULL AND length(text) > 0
         ORDER BY rowid ASC
         LIMIT ?`,
      )
      .all(cursor, maxChunks) as FactRow[];
  } catch (err) {
    log.debug(`canonical promotion query failed: ${String(err)}`);
    return EMPTY;
  }

  if (rows.length === 0) {
    return EMPTY;
  }

  let factsPromoted = 0;
  let llmCalls = 0;
  let maxRowid = cursor;

  for (let off = 0; off < rows.length; off += BATCH_SIZE) {
    const batch = rows.slice(off, off + BATCH_SIZE);
    for (const r of batch) {
      maxRowid = Math.max(maxRowid, r.rowid);
    }
    let raw: string;
    try {
      raw = await llmCall(buildPrompt(batch));
      llmCalls += 1;
    } catch (err) {
      log.debug(`canonical promotion LLM call failed: ${String(err)}`);
      continue;
    }
    for (const p of parsePromotions(raw)) {
      const idx = typeof p.i === "number" ? p.i - 1 : -1;
      const chunk = idx >= 0 && idx < batch.length ? batch[idx] : undefined;
      const key = typeof p.key === "string" ? normalizeCanonicalKey(p.key) : null;
      const value = typeof p.value === "string" ? p.value.trim() : "";
      if (!chunk || !key || !value || value.length > 500) {
        continue;
      }
      const result = store.pin({
        key,
        value,
        statement: chunk.text.replace(/\s+/g, " ").slice(0, 300),
        category: key.split(".")[0],
        confidence: PROMOTION_CONFIDENCE,
        source: "promotion",
        evidenceChunkIds: [chunk.id],
      });
      if (result.op !== "rejected") {
        factsPromoted += 1;
      }
    }
  }

  // Advance the cursor past everything scanned this cycle, even batches that
  // yielded nothing — they are genuinely processed and shouldn't be re-scanned.
  writeCursor(db, maxRowid);

  if (factsPromoted > 0) {
    log.info(
      `canonical promotion: pinned/strengthened ${factsPromoted} fact(s) from ${rows.length} chunk(s)`,
    );
  }
  return { chunksProcessed: rows.length, factsPromoted, llmCalls, skippedCortisol: false };
}
