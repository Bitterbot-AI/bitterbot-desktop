/**
 * PLAN-24 HORMA Phase 1: coverage discriminator — a deterministic (no LLM)
 * blame router that runs on a recall miss and decides WHY recall failed:
 *
 *   - exogenous: the answer is in the raw transcripts but never made it into the
 *     indexed chunk store → memory CONSTRUCTION lost it. Recorded as a
 *     `construction_feedback` event (the spine the Phase 2/3 architect loop
 *     consumes).
 *   - endogenous: the answer IS in the chunk store but retrieval did not surface
 *     it → RETRIEVAL failed. Recorded, and when it resolves to a single chunk,
 *     turned into a (query, ground_truth_chunk_id) training pair for the graph
 *     gate optimizer.
 *   - gap: the answer is nowhere → a genuine knowledge gap.
 *
 * HORMA's decoupling argument is that construction and retrieval learn on
 * different timescales, so their error signals must be separated. This is the
 * primitive that separates them, cheaply and online.
 */
import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { insertTrainingPair } from "./graph-optimizer.js";

const log = createSubsystemLogger("memory/coverage-diagnostics");

export type CoverageVerdict = "exogenous" | "endogenous" | "gap";

export type CoverageResult = {
  verdict: CoverageVerdict;
  terms: string[];
  /** The unique chunk that contains the answer, when the verdict is endogenous and unambiguous. */
  chunkId?: string;
};

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "this",
  "that",
  "as",
  "by",
  "from",
  "we",
  "you",
  "what",
  "when",
  "where",
  "who",
  "how",
  "why",
  "did",
  "do",
  "does",
  "my",
  "your",
  "me",
  "i",
]);

/** Salient content terms of a query (deduped, capped), used for presence checks. */
export function extractKeyTerms(query: string, cap = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 3 && !STOP_WORDS.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
      if (out.length >= cap) {
        break;
      }
    }
  }
  return out;
}

export type ChunkPresence = { present: boolean; unique: boolean; chunkId?: string };

/**
 * Is the answer present in the indexed chunk store? Deliberately NOT the ranked
 * search (that is what we are diagnosing) — a plain substring presence test over
 * chunks.text. A single chunk containing every term is treated as the unique
 * ground-truth answer; otherwise we fall back to a majority-of-terms presence
 * test (present but not a clean training pair).
 */
export function chunkPresence(db: DatabaseSync, terms: string[]): ChunkPresence {
  if (terms.length === 0) {
    return { present: false, unique: false };
  }
  try {
    const where = terms.map(() => "text LIKE ?").join(" AND ");
    const args = terms.map((t) => `%${t}%`);
    const rows = db.prepare(`SELECT id FROM chunks WHERE ${where} LIMIT 2`).all(...args) as Array<{
      id: string;
    }>;
    if (rows.length === 1) {
      return { present: true, unique: true, chunkId: rows[0]!.id };
    }
    if (rows.length > 1) {
      return { present: true, unique: false };
    }
    // Fallback: majority of terms appear somewhere in the store.
    let hits = 0;
    for (const t of terms) {
      const r = db.prepare(`SELECT 1 FROM chunks WHERE text LIKE ? LIMIT 1`).get(`%${t}%`);
      if (r) {
        hits++;
      }
    }
    return { present: hits >= Math.ceil(terms.length / 2), unique: false };
  } catch (err) {
    log.debug(`chunkPresence failed: ${String(err)}`);
    return { present: false, unique: false };
  }
}

export function classifyCoverage(p: {
  chunkPresent: boolean;
  presentInRaw: boolean;
}): CoverageVerdict {
  if (p.chunkPresent) {
    return "endogenous";
  }
  if (p.presentInRaw) {
    return "exogenous";
  }
  return "gap";
}

function audit(
  db: DatabaseSync,
  event: string,
  now: number,
  metadata: Record<string, unknown>,
  chunkId: string | null = null,
): void {
  try {
    db.prepare(
      `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
       VALUES (?, ?, ?, ?, 'coverage_diagnostics', ?)`,
    ).run(crypto.randomUUID(), chunkId, event, now, JSON.stringify(metadata));
  } catch (err) {
    log.debug(`coverage audit write failed: ${String(err)}`);
  }
}

/**
 * Run the discriminator for a recall miss and route the verdict. `scanRaw`
 * answers "do these terms appear in the raw transcripts?" (injected so the
 * caller owns transcript access and this stays unit-testable). Returns the
 * verdict, or null when the query is too thin to diagnose.
 */
export async function runCoverageDiagnostic(params: {
  db: DatabaseSync;
  query: string;
  scanRaw: (terms: string[]) => Promise<boolean>;
  now: number;
  minTerms?: number;
}): Promise<CoverageResult | null> {
  const terms = extractKeyTerms(params.query);
  if (terms.length < (params.minTerms ?? 2)) {
    return null;
  }
  const presence = chunkPresence(params.db, terms);
  const presentInRaw = presence.present ? false : await params.scanRaw(terms).catch(() => false);
  const verdict = classifyCoverage({ chunkPresent: presence.present, presentInRaw });

  if (verdict === "endogenous") {
    audit(
      params.db,
      "coverage_endogenous",
      params.now,
      { query: params.query, terms },
      presence.chunkId ?? null,
    );
    if (presence.unique && presence.chunkId) {
      // High-confidence unique match → a clean failure-derived training pair.
      try {
        insertTrainingPair(params.db, params.query, presence.chunkId, "coverage_miss");
      } catch (err) {
        log.debug(`coverage training-pair insert failed: ${String(err)}`);
      }
    }
  } else if (verdict === "exogenous") {
    audit(params.db, "construction_feedback", params.now, {
      comparison_type: "exogenous",
      query: params.query,
      terms,
      root_cause_summary:
        "Recall miss: terms present in raw transcripts but absent from the indexed chunk store (construction loss).",
    });
  } else {
    audit(params.db, "coverage_gap", params.now, { query: params.query, terms });
  }

  return { verdict, terms, chunkId: presence.chunkId };
}
