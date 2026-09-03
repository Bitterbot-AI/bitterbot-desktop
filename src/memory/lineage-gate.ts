/**
 * PLAN-43 Phase 3 (§3.3): the lineage-laundering gate.
 *
 * The attack: scrape a high-performing free commons skill, reword it, strip
 * its provenance, and list it as "original" to capture 100% of a sale. The
 * defense at LISTING time: content-address the candidate and refuse the
 * commercial listing when it is a copy or near-duplicate of a known
 * commons skill (a peer-origin or free-shared crystal) that the candidate
 * does not cite as lineage.
 *
 * Order of evidence: exact / normalized content hash (catches copies
 * regardless of embedding state or chunking), then embedding similarity
 * restricted to rows embedded by the SAME model. Fails CLOSED when the
 * candidate has no comparable embedding yet (indexing pending): an
 * attacker must not be able to list during the embedding window.
 *
 * Lineage must be cited by the source's AUTHOR pubkey — never by a crystal
 * id, which the refusal itself discloses and which no payout can reach —
 * and the cited author is returned so the revenue split pays from
 * EVIDENCE, not from a seller-supplied chain.
 *
 * Honest scope (2026-09-03 adversarial pass): this runs on the seller's
 * own node against the seller's own DB. It is a good-faith check that
 * binds unmodified nodes. The 0.92 threshold catches verbatim and
 * near-verbatim copies; a full paraphrase lands lower and is only FLAGGED
 * (>= 0.80). Receiver-side attestation (attestation.ts) is the
 * enforcement that does not depend on the seller.
 */

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { cosineSimilarity } from "./internal.js";

/** Cosine similarity at or above which two skills are near-duplicates. */
export const LINEAGE_NEAR_DUPLICATE_COSINE = 0.92;
/** Cosine at or above which a listing is FLAGGED (recorded, allowed) as a possible derivative. */
export const LINEAGE_FLAG_COSINE = 0.8;

export interface LineageCheckResult {
  ok: boolean;
  contentSha256: string;
  reason?: string;
  nearest?: { crystalId: string; similarity: number; authorPubkey: string | null };
  /** Set when the nearest commons skill is a near-duplicate the candidate cites (lineage owed). */
  lineageAuthorPubkey?: string;
  /** Similarity in [LINEAGE_FLAG_COSINE, LINEAGE_NEAR_DUPLICATE_COSINE): possible derivative. */
  flagged?: boolean;
}

function parseEmbedding(raw: unknown): number[] | null {
  if (typeof raw !== "string" || !raw.startsWith("[")) {
    return null;
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) && arr.length > 0 && arr.every((n) => typeof n === "number")
      ? (arr as number[])
      : null;
  } catch {
    return null;
  }
}

function citedLineage(candidate: {
  provenance_chain: string | null;
  governance_json: string | null;
}): Set<string> {
  const cited = new Set<string>();
  const addAll = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" && x) {
          cited.add(x);
        }
      }
    }
  };
  try {
    addAll(JSON.parse(candidate.provenance_chain ?? "[]"));
  } catch {
    /* ignore */
  }
  try {
    const g = JSON.parse(candidate.governance_json ?? "{}") as Record<string, unknown>;
    addAll(g.provenanceChain);
    if (typeof g.peerOrigin === "string") {
      cited.add(g.peerOrigin);
    }
  } catch {
    /* ignore */
  }
  return cited;
}

export function contentSha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Hash of the text with frontmatter, HTML comments (provenance trailers), and whitespace runs stripped. */
export function normalizedContentSha256(text: string): string {
  let t = text.trimStart();
  if (t.startsWith("---")) {
    const end = t.indexOf("\n---", 3);
    if (end > 0) {
      t = t.slice(end + 4);
    }
  }
  t = t
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(t, "utf-8").digest("hex");
}

interface CommonsRow {
  id: string;
  text: string;
  embedding: string | null;
  governance_json: string | null;
  model: string | null;
  stable_skill_id: string | null;
}

type ParsedCommonsRow = CommonsRow & { vec: number[] | null; sha: string; normSha: string };

/** Parsed commons cache keyed on (row count, max updated_at): ~100ms of JSON parsing per call otherwise. */
let commonsCache: { key: string; rows: ParsedCommonsRow[] } | null = null;

const COMMONS_WHERE = `semantic_type IN ('skill', 'task_pattern')
          AND (governance_json LIKE '%"peerOrigin"%' OR publish_visibility = 'shared')`;

function loadCommons(db: DatabaseSync): ParsedCommonsRow[] {
  const stat = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM chunks WHERE ${COMMONS_WHERE}`,
    )
    .get() as { c: number; m: number };
  const key = `${stat.c}:${stat.m}`;
  if (!commonsCache || commonsCache.key !== key) {
    // Every commons row regardless of lifecycle: an expired free skill still
    // deserves attribution (consolidation marks the commons 'forgotten').
    const rows = db
      .prepare(
        `SELECT id, text, embedding, governance_json, model, stable_skill_id FROM chunks WHERE ${COMMONS_WHERE}`,
      )
      .all() as unknown as CommonsRow[];
    commonsCache = {
      key,
      rows: rows.map((r) => ({
        ...r,
        vec: parseEmbedding(r.embedding),
        sha: contentSha256(r.text),
        normSha: normalizedContentSha256(r.text),
      })),
    };
  }
  return commonsCache.rows;
}

/** Test/maintenance hook. */
export function resetLineageCache(): void {
  commonsCache = null;
}

function authorOf(governanceJson: string | null): string | null {
  try {
    const g = JSON.parse(governanceJson ?? "{}") as { peerOrigin?: unknown };
    return typeof g.peerOrigin === "string" ? g.peerOrigin : null;
  } catch {
    return null;
  }
}

export function checkListingLineage(db: DatabaseSync, crystalId: string): LineageCheckResult {
  const candidate = db
    .prepare(
      `SELECT id, text, embedding, provenance_chain, governance_json, model, stable_skill_id
         FROM chunks WHERE id = ?`,
    )
    .get(crystalId) as
    | {
        id: string;
        text: string;
        embedding: string | null;
        provenance_chain: string | null;
        governance_json: string | null;
        model: string | null;
        stable_skill_id: string | null;
      }
    | undefined;
  if (!candidate) {
    return { ok: false, contentSha256: "", reason: "crystal not found" };
  }
  const sha = contentSha256(candidate.text);
  const normSha = normalizedContentSha256(candidate.text);
  const cited = citedLineage(candidate);
  // Other versions of the same local skill are self, not the commons.
  const commons = loadCommons(db).filter(
    (r) =>
      r.id !== crystalId &&
      !(candidate.stable_skill_id && r.stable_skill_id === candidate.stable_skill_id),
  );

  if (commons.length === 0) {
    // Nothing to launder from: an empty commons needs no comparison (and
    // must not block a fresh node's first listing on embedding latency).
    return { ok: true, contentSha256: sha };
  }

  const decide = (nearest: NonNullable<LineageCheckResult["nearest"]>): LineageCheckResult => {
    if (!nearest.authorPubkey) {
      // A commons row with no peer author is this node's own free-shared
      // work: selling one's own skill owes nobody lineage.
      return { ok: true, contentSha256: sha, nearest };
    }
    const citesAuthor = cited.has(nearest.authorPubkey);
    if (!citesAuthor) {
      return {
        ok: false,
        contentSha256: sha,
        reason: `near-duplicate of commons skill ${nearest.crystalId.slice(0, 8)} (cosine ${nearest.similarity.toFixed(3)}) without cited lineage (cite the source author)`,
        nearest,
      };
    }
    return { ok: true, contentSha256: sha, nearest, lineageAuthorPubkey: nearest.authorPubkey };
  };

  // 1. Content-hash evidence (exact or normalized) beats embeddings.
  const copy = commons.find((r) => r.sha === sha || r.normSha === normSha);
  if (copy) {
    return decide({
      crystalId: copy.id,
      similarity: 1,
      authorPubkey: authorOf(copy.governance_json),
    });
  }

  // 2. Embedding similarity, same model only.
  if (!commons.some((r) => r.vec)) {
    // The commons itself carries no embeddings: similarity is impossible
    // for anyone, and hash evidence (above) already ran. Allow, and say so.
    return {
      ok: true,
      contentSha256: sha,
      reason: "commons has no embeddings; only content-hash evidence applied",
    };
  }
  const vec = parseEmbedding(candidate.embedding);
  if (!vec) {
    // Fail CLOSED: the embedding window must not be a listing window.
    return {
      ok: false,
      contentSha256: sha,
      reason: "embedding not indexed yet; retry after the memory index embeds this crystal",
    };
  }
  let nearest: LineageCheckResult["nearest"];
  let comparable = 0;
  for (const row of commons) {
    if (
      !row.vec ||
      row.vec.length !== vec.length ||
      (row.model && candidate.model && row.model !== candidate.model)
    ) {
      continue;
    }
    comparable += 1;
    const sim = cosineSimilarity(vec, row.vec);
    if (!nearest || sim > nearest.similarity) {
      nearest = { crystalId: row.id, similarity: sim, authorPubkey: authorOf(row.governance_json) };
    }
  }
  if (nearest && nearest.similarity >= LINEAGE_NEAR_DUPLICATE_COSINE) {
    return decide(nearest);
  }
  const flagged = Boolean(nearest && nearest.similarity >= LINEAGE_FLAG_COSINE);
  return {
    ok: true,
    contentSha256: sha,
    ...(nearest ? { nearest } : {}),
    ...(flagged ? { flagged: true } : {}),
    ...(commons.length > 0 && comparable === 0
      ? { reason: "no commons rows embedded by the same model; similarity not comparable" }
      : {}),
  };
}
