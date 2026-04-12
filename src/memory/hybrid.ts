import { rrfFuse, type RankedEntry } from "./rrf.js";

export type HybridSource = string;

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

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
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
}> {
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
export function mergeHybridResultsRRF(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
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

  // Sort each modality by its native score, assign 1-based ranks
  const vectorSorted = [...params.vector].toSorted((a, b) => b.vectorScore - a.vectorScore);
  const keywordSorted = [...params.keyword].toSorted((a, b) => b.textScore - a.textScore);

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

  const lists: Array<{ name: string; entries: Array<RankedEntry<PayloadType>> }> = [];
  if (vectorRanked.length > 0) {
    lists.push({ name: "vector", entries: vectorRanked });
  }
  if (keywordRanked.length > 0) {
    lists.push({ name: "keyword", entries: keywordRanked });
  }

  const fused = rrfFuse(lists);

  return fused.map((entry) => {
    const meta = payloads.get(entry.id)!;
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
    };
  });
}
