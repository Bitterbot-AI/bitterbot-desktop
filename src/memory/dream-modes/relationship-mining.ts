/**
 * PLAN-28 A2 — offline LLM relationship mining (the recall engine).
 *
 * The deterministic hot-path extractor (A1) is high-precision but low-recall: it
 * only fires on an explicit typed verb between two recognizable entities. This
 * dream mode closes the recall gap. During calm cycles it batches unprocessed
 * fact-like crystals through a cheap LLM (strict JSON, like the SAGE query
 * planner), extracts typed triples, and ingests them via
 * `KnowledgeGraphManager.ingestExtraction`. Every mined triple an agent later
 * cites becomes a SAGE training pair — this is what finally feeds the graph-gate
 * optimizer past its 50-pair floor.
 *
 * Design constraints (mirroring the rest of the memory system):
 *   - **No LLM on the hot path.** This work is offline, batched, and gated.
 *   - **Hormonally gated.** cortisol > 0.7 skips — don't restructure memory
 *     under stress (mirrors `graph-optimization-hook.ts`).
 *   - **Idempotent cursor.** A `meta` marker over chunk rowids drains the
 *     backlog incrementally; re-running never double-scans.
 *   - **Tolerant parsing.** Malformed LLM JSON is dropped, never thrown.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  EntityType,
  ExtractedRelationship,
  KnowledgeGraphManager,
  RelationType,
} from "../knowledge-graph.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory/relationship-mining");

const CURSOR_KEY = "relationship_mining_cursor";
const CORTISOL_SKIP_THRESHOLD = 0.7;
const BATCH_SIZE = 10;

// Validation sets kept narrow on purpose: the LLM is constrained to the typed
// relations the graph reader actually traverses, so junk like "is_a"/"related"
// is dropped rather than ingested.
const ALLOWED_ENTITY_TYPES = new Set<EntityType>([
  "person",
  "project",
  "tool",
  "organization",
  "service",
  "location",
  "concept",
  "file",
  "event",
]);
const ALLOWED_RELATIONS = new Set<RelationType>([
  "works_on",
  "manages",
  "uses",
  "depends_on",
  "knows",
  "prefers",
  "located_at",
  "part_of",
  "created_by",
  "belongs_to",
]);

type FactRow = { rowid: number; id: string; text: string };

type MinedTriple = {
  i?: number;
  source?: string;
  sourceType?: string;
  target?: string;
  targetType?: string;
  relation?: string;
};

export type RelationshipMiningResult = {
  chunksProcessed: number;
  triplesIngested: number;
  llmCalls: number;
  skippedCortisol: boolean;
};

const EMPTY: RelationshipMiningResult = {
  chunksProcessed: 0,
  triplesIngested: 0,
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
    log.debug(`relationship-mining cursor write failed: ${String(err)}`);
  }
}

/** Build the strict-JSON extraction prompt for a batch of numbered facts. */
function buildPrompt(batch: FactRow[]): string {
  const facts = batch.map((r, i) => `${i + 1}. ${r.text.replace(/\s+/g, " ").slice(0, 300)}`);
  return (
    `Extract explicit relationship triples from these memory facts. ` +
    `Only output a relation that the text states directly — never inferred or guessed.\n` +
    `Allowed entity types: ${[...ALLOWED_ENTITY_TYPES].join(", ")}.\n` +
    `Allowed relations: ${[...ALLOWED_RELATIONS].join(", ")}.\n\n` +
    `Facts:\n${facts.join("\n")}\n\n` +
    `Reply ONLY with JSON of the form ` +
    `{"triples":[{"i":<fact number>,"source":"..","sourceType":"..","target":"..","targetType":"..","relation":".."}]}. ` +
    `Use an empty array if nothing is explicit.`
  );
}

/** Tolerant parse: pull the first JSON object and read its `triples` array. */
function parseTriples(raw: string): MinedTriple[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    return [];
  }
  try {
    const parsed = JSON.parse(m[0]) as { triples?: unknown };
    if (!Array.isArray(parsed.triples)) {
      return [];
    }
    return parsed.triples as MinedTriple[];
  } catch {
    return [];
  }
}

/** Validate a mined triple into an ExtractedRelationship, or null. */
function toRelationship(t: MinedTriple): ExtractedRelationship | null {
  const source = typeof t.source === "string" ? t.source.trim() : "";
  const target = typeof t.target === "string" ? t.target.trim() : "";
  const sourceType = t.sourceType as EntityType;
  const targetType = t.targetType as EntityType;
  const relation = t.relation as RelationType;
  if (!source || !target || source.toLowerCase() === target.toLowerCase()) {
    return null;
  }
  if (!ALLOWED_ENTITY_TYPES.has(sourceType) || !ALLOWED_ENTITY_TYPES.has(targetType)) {
    return null;
  }
  if (!ALLOWED_RELATIONS.has(relation)) {
    return null;
  }
  return {
    sourceName: source,
    sourceType,
    targetName: target,
    targetType,
    relationType: relation,
    // Mined edges are LLM-derived: below deterministic typed edges (0.5) so the
    // SABM adjudication and graph gate down-weight them if they conflict.
    weight: 0.4,
  };
}

/**
 * Drain a bounded batch of unprocessed fact crystals into typed graph edges.
 * Returns counts; advances the cursor so the next cycle continues the backlog.
 */
export async function runRelationshipMining(params: {
  db: DatabaseSync;
  kg: KnowledgeGraphManager;
  llmCall: ((prompt: string) => Promise<string>) | null;
  hormones: { cortisol: number } | null;
  maxChunks: number;
}): Promise<RelationshipMiningResult> {
  const { db, kg, llmCall, hormones, maxChunks } = params;

  if (hormones && hormones.cortisol > CORTISOL_SKIP_THRESHOLD) {
    log.debug("relationship mining skipped — cortisol too high");
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
           AND (COALESCE(semantic_type, 'general') IN ('fact', 'insight', 'preference', 'relationship', 'task_pattern')
                OR COALESCE(epistemic_layer, '') IN ('world_fact', 'mental_model', 'directive'))
           AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated', 'frozen')
           AND text IS NOT NULL AND length(text) > 0
         ORDER BY rowid ASC
         LIMIT ?`,
      )
      .all(cursor, maxChunks) as FactRow[];
  } catch (err) {
    log.debug(`relationship mining query failed: ${String(err)}`);
    return EMPTY;
  }

  if (rows.length === 0) {
    return EMPTY;
  }

  let triplesIngested = 0;
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
      log.debug(`relationship mining LLM call failed: ${String(err)}`);
      continue;
    }
    for (const t of parseTriples(raw)) {
      const idx = typeof t.i === "number" ? t.i - 1 : -1;
      const chunk = idx >= 0 && idx < batch.length ? batch[idx] : undefined;
      const rel = toRelationship(t);
      if (!rel || !chunk) {
        continue;
      }
      const res = kg.ingestExtraction(
        [
          { name: rel.sourceName, type: rel.sourceType },
          { name: rel.targetName, type: rel.targetType },
        ],
        [rel],
        [chunk.id],
      );
      triplesIngested += res.relationshipsUpserted;
    }
  }

  // Advance the cursor past everything scanned this cycle, even batches that
  // yielded no triples — they are genuinely processed and shouldn't be re-mined.
  writeCursor(db, maxRowid);

  if (triplesIngested > 0) {
    log.info(
      `relationship mining: ingested ${triplesIngested} triple(s) from ${rows.length} chunk(s)`,
    );
  }
  return { chunksProcessed: rows.length, triplesIngested, llmCalls, skippedCortisol: false };
}
