import { rrfFuse, type RankedEntry } from "./rrf.js";

export type HybridSource = string;

/**
 * PLAN-58: the retrieval channels a hybrid search fuses. Every merged
 * result says which of these found it and how well, so a consumer can see
 * WHY a memory matched instead of reasoning about one fused number.
 */
export type HybridChannel = "vector" | "keyword" | "graph";

/** A channel's 1-based rank and native score (cosine, BM25-derived, graph) for one result. */
export type HybridChannelHit = { rank: number; score: number };

export type HybridChannels = Partial<Record<HybridChannel, HybridChannelHit>>;

/** How the channels were combined into `score`. */
export type HybridFusion = "rrf" | "weighted" | "vector-only";

function rankChannel<T extends { id: string }>(
  sorted: readonly T[],
  score: (r: T) => number,
  into: Map<string, HybridChannels>,
  channel: HybridChannel,
): void {
  sorted.forEach((r, i) => {
    const hit: HybridChannelHit = { rank: i + 1, score: score(r) };
    const existing = into.get(r.id);
    if (existing) {
      existing[channel] = hit;
    } else {
      into.set(r.id, { [channel]: hit });
    }
  });
}

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
  importanceScore?: number;
  updatedAt?: number;
  lastAccessedAt?: number | null;
  emotionalValence?: number | null;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
  importanceScore?: number;
  updatedAt?: number;
  lastAccessedAt?: number | null;
  emotionalValence?: number | null;
};

/**
 * Minimal English stopword set shared by the keyword channel and the
 * proactive-recall fallback. It only needs to strip the glue words of a
 * conversational sentence; bm25's inverse document frequency handles the rest.
 */
export const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "did",
  "does",
  "has",
  "had",
  "have",
  "you",
  "your",
  "yours",
  "our",
  "ours",
  "his",
  "her",
  "hers",
  "its",
  "their",
  "theirs",
  "this",
  "that",
  "these",
  "those",
  "with",
  "from",
  "what",
  "which",
  "when",
  "where",
  "who",
  "whom",
  "why",
  "how",
  "can",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "about",
  "into",
  "onto",
  "over",
  "under",
  "again",
  "then",
  "than",
  "there",
  "here",
  "just",
  "very",
  "not",
  "but",
  "any",
  "all",
  "some",
  "one",
  "two",
  "get",
  "got",
  "let",
  "lets",
  "please",
  "tell",
  "know",
  "think",
  "want",
  "need",
  "yesterday",
  "today",
  "tomorrow",
  "now",
  "still",
  "yet",
  "also",
  "too",
  "a",
  "i",
  "to",
  "of",
  "in",
  "on",
  "at",
  "it",
  "is",
  "as",
  "be",
  "by",
  "or",
  "an",
  "if",
  "we",
  "my",
  "me",
  "do",
  "so",
  "up",
  "no",
  "us",
  "he",
  "she",
  "they",
  "them",
  "been",
  "being",
]);

/** Query terms kept after stopword removal; bm25 ranks by how many match. */
export const FTS_MAX_QUERY_TERMS = 16;

/**
 * Build the FTS5 MATCH expression for the keyword channel.
 *
 * Terms are OR-joined, not AND-joined. Under AND, a chunk had to contain
 * every token of the query, which held for terse two-word lookups and for
 * nothing conversational: the PLAN-58 per-channel diagnostics showed the
 * keyword channel contributing zero results to natural-language questions on
 * the live store and on the LongMemEval baseline, so "hybrid" search had been
 * vector-only in practice. With OR, bm25 ranks chunks by how many of the
 * query's terms they contain and how rare those terms are, so an all-terms
 * match still sorts first and the channel has something to say about the
 * rest. Stopwords are dropped only when the query has three or more tokens,
 * so a short lookup keeps every word it was given. Returns null when nothing
 * searchable remains.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const content =
    tokens.length >= 3 ? tokens.filter((t) => !FTS_STOPWORDS.has(t.toLowerCase())) : tokens;
  const kept = content.length > 0 ? content : tokens;
  const unique = [...new Set(kept.map((t) => t.replaceAll('"', "")))]
    .filter(Boolean)
    .slice(0, FTS_MAX_QUERY_TERMS);
  if (unique.length === 0) {
    return null;
  }
  return unique.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Bound a post-fusion multiplicative boost to the fused score's own scale.
 *
 * The recency, emotional, mood-congruent and temporal-intent boosts multiply
 * the search score and were designed for cosine-scale scores. Under RRF the
 * fused score is rank-only (1/(k+rank), adjacent ranks ~1-3% apart), so the
 * same multipliers (recency up to x1.5, the default temporal decay down to
 * x0.06 for a six-month-old memory) reorder the list wholesale: on the
 * 2026-10-27 live-memory held-out set, chunks ranked first by BOTH channels
 * landed at fused positions 13-23 and the fused list recalled less than either
 * channel alone. `scale` shrinks the boost toward 1: with 0.1 a x1.5 boost
 * becomes x1.05 and a x0.06 decay becomes x0.906, enough to break near-ties
 * and not enough to overrule the channels. 1 keeps the full boost (legacy),
 * 0 ignores the boosts and keeps pure fusion order.
 */
export function boundPostFusionBoost(base: number, boosted: number, scale: number): number {
  if (!(base > 0) || !Number.isFinite(boosted) || scale >= 1) {
    return boosted;
  }
  const s = Math.max(0, scale);
  return base * (1 + s * (boosted / base - 1));
}

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
}): Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
  importanceScore?: number;
  channels: HybridChannels;
  fusion: HybridFusion;
}> {
  const channels = new Map<string, HybridChannels>();
  rankChannel(
    [...params.vector].toSorted((a, b) => b.vectorScore - a.vectorScore),
    (r) => r.vectorScore,
    channels,
    "vector",
  );
  rankChannel(
    [...params.keyword].toSorted((a, b) => b.textScore - a.textScore),
    (r) => r.textScore,
    channels,
    "keyword",
  );
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
      importanceScore?: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
      importanceScore: r.importanceScore,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
      // Keep the higher importance score if both sources provide one
      if (r.importanceScore != null) {
        existing.importanceScore =
          existing.importanceScore != null
            ? Math.max(existing.importanceScore, r.importanceScore)
            : r.importanceScore;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
        importanceScore: r.importanceScore,
      });
    }
  }

  const merged = Array.from(byId.values()).map((entry) => {
    const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score,
      snippet: entry.snippet,
      source: entry.source,
      importanceScore: entry.importanceScore,
      channels: channels.get(entry.id) ?? {},
      fusion: "weighted" as const,
    };
  });

  return merged.toSorted((a, b) => b.score - a.score);
}

export type HybridMergedResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
  importanceScore?: number;
  updatedAt?: number;
  lastAccessedAt?: number | null;
  emotionalValence?: number | null;
  /** PLAN-58: per-channel rank and native score for every channel that returned this id. */
  channels?: HybridChannels;
  fusion?: HybridFusion;
};

/**
 * Merge vector and keyword results using Reciprocal Rank Fusion (RRF).
 *
 * Unlike the weighted-average merge, RRF discards raw scores and fuses
 * based on rank position only — making vector (cosine) and keyword (BM25)
 * scores directly comparable without normalization.
 *
 * Documents appearing in the top ranks of both modalities are heavily
 * rewarded ("consensus" documents), resolving the semantic-mismatch
 * failure mode where exact technical terms score poorly in vector search.
 */
export type HybridGraphResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  graphScore: number;
  importanceScore?: number;
  updatedAt?: number;
  lastAccessedAt?: number | null;
  emotionalValence?: number | null;
};

export function mergeHybridResultsRRF(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  /** Optional PLAN-18 graph-reader channel. */
  graph?: HybridGraphResult[];
}): HybridMergedResult[] {
  // Build payload lookup by id — store metadata from whichever source provides it
  const payloads = new Map<
    string,
    {
      path: string;
      startLine: number;
      endLine: number;
      snippet: string;
      source: HybridSource;
      importanceScore?: number;
      updatedAt?: number;
      lastAccessedAt?: number | null;
      emotionalValence?: number | null;
    }
  >();

  for (const r of params.vector) {
    payloads.set(r.id, {
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      snippet: r.snippet,
      source: r.source,
      importanceScore: r.importanceScore,
      updatedAt: r.updatedAt,
      lastAccessedAt: r.lastAccessedAt,
      emotionalValence: r.emotionalValence,
    });
  }
  for (const r of params.keyword) {
    const existing = payloads.get(r.id);
    if (existing) {
      // Prefer keyword snippet if available (often more relevant)
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
      if (r.importanceScore != null) {
        existing.importanceScore =
          existing.importanceScore != null
            ? Math.max(existing.importanceScore, r.importanceScore)
            : r.importanceScore;
      }
      if (r.updatedAt != null) {
        existing.updatedAt = r.updatedAt;
      }
      if (r.lastAccessedAt != null) {
        existing.lastAccessedAt = r.lastAccessedAt;
      }
      if (r.emotionalValence != null) {
        existing.emotionalValence = r.emotionalValence;
      }
    } else {
      payloads.set(r.id, {
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        snippet: r.snippet,
        source: r.source,
        importanceScore: r.importanceScore,
        updatedAt: r.updatedAt,
        lastAccessedAt: r.lastAccessedAt,
        emotionalValence: r.emotionalValence,
      });
    }
  }

  if (params.graph) {
    for (const r of params.graph) {
      const existing = payloads.get(r.id);
      if (existing) {
        if (
          r.snippet &&
          r.snippet.length > 0 &&
          (!existing.snippet || existing.snippet.length === 0)
        ) {
          existing.snippet = r.snippet;
        }
      } else {
        payloads.set(r.id, {
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          snippet: r.snippet,
          source: r.source,
          importanceScore: r.importanceScore,
          updatedAt: r.updatedAt,
          lastAccessedAt: r.lastAccessedAt,
          emotionalValence: r.emotionalValence,
        });
      }
    }
  }

  // Sort each modality by its native score, assign 1-based ranks
  const vectorSorted = [...params.vector].toSorted((a, b) => b.vectorScore - a.vectorScore);
  const keywordSorted = [...params.keyword].toSorted((a, b) => b.textScore - a.textScore);
  const graphSorted = params.graph
    ? [...params.graph].toSorted((a, b) => b.graphScore - a.graphScore)
    : [];

  const channels = new Map<string, HybridChannels>();
  rankChannel(vectorSorted, (r) => r.vectorScore, channels, "vector");
  rankChannel(keywordSorted, (r) => r.textScore, channels, "keyword");
  rankChannel(graphSorted, (r) => r.graphScore, channels, "graph");

  type PayloadType = { id: string };
  const vectorRanked: Array<RankedEntry<PayloadType>> = vectorSorted.map((r, i) => ({
    id: r.id,
    rank: i + 1,
    payload: { id: r.id },
  }));
  const keywordRanked: Array<RankedEntry<PayloadType>> = keywordSorted.map((r, i) => ({
    id: r.id,
    rank: i + 1,
    payload: { id: r.id },
  }));
  const graphRanked: Array<RankedEntry<PayloadType>> = graphSorted.map((r, i) => ({
    id: r.id,
    rank: i + 1,
    payload: { id: r.id },
  }));

  const lists: Array<{ name: string; entries: Array<RankedEntry<PayloadType>> }> = [];
  if (vectorRanked.length > 0) {
    lists.push({ name: "vector", entries: vectorRanked });
  }
  if (keywordRanked.length > 0) {
    lists.push({ name: "keyword", entries: keywordRanked });
  }
  if (graphRanked.length > 0) {
    lists.push({ name: "graph", entries: graphRanked });
  }

  const fused = rrfFuse(lists);

  return fused.map((entry) => {
    const meta = payloads.get(entry.id)!;
    // `rrfFuse` reports the rank it used per list; the channel map carries
    // the same ranks plus the native scores. They are built from the same
    // sorted lists, so they agree by construction (asserted in tests).
    const hits = channels.get(entry.id) ?? {};
    return {
      id: entry.id,
      path: meta.path,
      startLine: meta.startLine,
      endLine: meta.endLine,
      score: entry.score,
      snippet: meta.snippet,
      source: meta.source,
      importanceScore: meta.importanceScore,
      updatedAt: meta.updatedAt,
      lastAccessedAt: meta.lastAccessedAt,
      emotionalValence: meta.emotionalValence,
      channels: hits,
      fusion: "rrf" as const,
    };
  });
}
