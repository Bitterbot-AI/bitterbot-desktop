/**
 * PLAN-34 Phase 4 — the dream-insight promotion gate.
 *
 * Dreams become rememberable: qualifying insights are promoted into
 * searchable `chunks` (origin='dream', semantic_type='insight') instead of
 * rotting in the write-only dream_insights table. The gate leads with legs
 * no model can game (the v3 re-pass showed self-reported citation subsets
 * are arithmetically toothless), then a claim-decomposition verifier:
 *
 *   1. Mode eligible — extrapolation and simulation only (LLM-backed,
 *      citation-capable). Compression is heuristic template synthesis with
 *      no LLM to attest anything; exploration outputs questions.
 *   2. Mechanical grounding (ungameable): each accepted source chunk must
 *      clear an embedding-similarity floor to the insight AND rank among
 *      the most-similar of the offered inputs; >= 2 distinct such sources,
 *      >= 2 of them NON-dream ancestors, >= 1 first-party (persisted
 *      chunks.session_trust). Per-leg rejection counters feed Phase 6.
 *   3. Claim-decomposition verification (a distinct verifier seam, never
 *      the generating call): promote only when no sentence is unsupported
 *      and nothing is misattributed.
 *   4. Relevance gate is subsumed by leg 2 (fail-closed on missing
 *      embeddings — no embedding, no grounding, no promotion).
 *   5. Hard cap of 3 promotions per cycle; candidates relevance-ranked so
 *      only the most-grounded are verified within the LLM budget.
 *
 * This module is pure gate logic over injected data + seams; the dream
 * engine performs the actual searchable-chunk write for qualifiers.
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

/** Embedding-similarity floor a source must clear to count as grounding. */
export const GROUNDING_SIMILARITY_FLOOR = 0.4;
/** Distinct grounded sources required. */
export const MIN_GROUNDED_SOURCES = 2;
/** Of the grounded sources, this many must be NON-dream ancestors. */
export const MIN_NON_DREAM_ANCESTORS = 2;
/** Hard promotion cap per dream cycle. */
export const MAX_PROMOTIONS_PER_CYCLE = 3;

/** Only these modes are promotion-eligible. */
export const PROMOTABLE_MODES = new Set(["extrapolation", "simulation"]);

export type PromotionCandidateInsight = {
  id: string;
  content: string;
  confidence: number;
  mode: string;
  embedding: number[];
  sourceChunkIds: string[];
};

/** A source chunk row as seen by the gate. */
export type SourceChunkRow = {
  id: string;
  embedding: number[];
  origin: string;
  semanticType: string;
  sessionTrust: string | null;
};

/**
 * The verifier seam. Labels each insight sentence against its cited
 * sources; promotion requires unsupported === 0 AND no misattribution.
 * Injected (never the generating call) so it can carry its own model.
 */
export type VerifyInsightFn = (
  insight: { content: string },
  sources: { text: string }[],
) => Promise<{ unsupported: number; misattribution: boolean; labels?: string[] }>;

export type PerLegRejections = {
  ineligibleMode: number;
  noEmbedding: number;
  insufficientGrounding: number;
  insufficientNonDreamAncestors: number;
  noFirstPartySource: number;
  verifierRejected: number;
  capReached: number;
};

export function emptyRejections(): PerLegRejections {
  return {
    ineligibleMode: 0,
    noEmbedding: 0,
    insufficientGrounding: 0,
    insufficientNonDreamAncestors: 0,
    noFirstPartySource: 0,
    verifierRejected: 0,
    capReached: 0,
  };
}

export type GroundedInsight = {
  insight: PromotionCandidateInsight;
  /** The source chunks that passed the mechanical grounding leg. */
  groundedSources: SourceChunkRow[];
  /** Max similarity to any grounded source — the relevance rank key. */
  topSimilarity: number;
};

/**
 * Load the source chunks an insight cites, with the fields the gate needs.
 * A chunk that is itself a promoted dream insight (origin='dream' AND
 * semantic_type='insight') is dropped here so dream-on-dream compounding
 * can never satisfy grounding.
 */
export function loadSourceChunks(db: DatabaseSync, chunkIds: string[]): SourceChunkRow[] {
  if (chunkIds.length === 0) {
    return [];
  }
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, embedding,
              COALESCE(origin, 'indexed') AS origin,
              COALESCE(semantic_type, 'general') AS semantic_type,
              session_trust
       FROM chunks WHERE id IN (${placeholders})`,
    )
    .all(...chunkIds) as Array<{
    id: string;
    embedding: string;
    origin: string;
    semantic_type: string;
    session_trust: string | null;
  }>;
  return rows
    .filter((r) => !(r.origin === "dream" && r.semantic_type === "insight"))
    .map((r) => ({
      id: r.id,
      embedding: parseEmbedding(r.embedding),
      origin: r.origin,
      semanticType: r.semantic_type,
      sessionTrust: r.session_trust,
    }));
}

/**
 * Mechanical grounding leg (legs 1, 2, 4). Returns the grounded-source set
 * when the insight qualifies, or null with the failing leg tallied. Pure:
 * no LLM, no writes.
 */
export function assessGrounding(
  insight: PromotionCandidateInsight,
  sources: SourceChunkRow[],
  rej: PerLegRejections,
): GroundedInsight | null {
  if (!PROMOTABLE_MODES.has(insight.mode)) {
    rej.ineligibleMode++;
    return null;
  }
  if (insight.embedding.length === 0) {
    rej.noEmbedding++; // fail closed — no embedding, no grounding
    return null;
  }
  // Similarity of the insight to each offered source with an embedding.
  const scored = sources
    .filter((s) => s.embedding.length > 0)
    .map((s) => ({ source: s, sim: cosineSimilarity(insight.embedding, s.embedding) }))
    .toSorted((a, b) => b.sim - a.sim);
  // A source grounds the insight only if it clears the floor AND ranks
  // among the most-similar of the offered inputs. The rank cap bites only
  // for LARGE stamped sets (where "cite everything" would otherwise clear
  // the floor on noise); a legitimate 2-3 source citation is never capped
  // below the required minimum.
  const rankCutoff = Math.max(MIN_GROUNDED_SOURCES, Math.ceil(scored.length / 2));
  const grounded = scored
    .slice(0, rankCutoff)
    .filter((s) => s.sim >= GROUNDING_SIMILARITY_FLOOR)
    .map((s) => s.source);
  const distinct = [...new Map(grounded.map((s) => [s.id, s])).values()];
  if (distinct.length < MIN_GROUNDED_SOURCES) {
    rej.insufficientGrounding++;
    return null;
  }
  const nonDreamAncestors = distinct.filter((s) => s.origin !== "dream");
  if (nonDreamAncestors.length < MIN_NON_DREAM_ANCESTORS) {
    rej.insufficientNonDreamAncestors++;
    return null;
  }
  if (!distinct.some((s) => s.sessionTrust === "first_party")) {
    rej.noFirstPartySource++;
    return null;
  }
  return {
    insight,
    groundedSources: distinct,
    topSimilarity: scored[0]?.sim ?? 0,
  };
}
