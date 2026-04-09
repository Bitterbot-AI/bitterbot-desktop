import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "../utils.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

/**
 * Extract the most query-relevant window from a chunk of text.
 *
 * Instead of always returning the first `maxChars` characters (which may
 * miss critical facts deeper in the text), this finds the region with the
 * highest density of query-term matches and centers the window there.
 *
 * Falls back to head-truncation when there are no query-term matches
 * (pure vector-similarity hit) or when the text fits within the limit.
 */
function extractQuerySnippet(text: string, maxChars: number, query?: string): string {
  if (!text || text.length <= maxChars) return text;
  if (!query || !query.trim()) return truncateUtf16Safe(text, maxChars);

  // Extract meaningful query terms (>2 chars, lowercased)
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);

  if (terms.length === 0) return truncateUtf16Safe(text, maxChars);

  const lower = text.toLowerCase();

  // Find all positions where query terms appear
  const hits: number[] = [];
  for (const term of terms) {
    let pos = 0;
    while (pos < lower.length) {
      const idx = lower.indexOf(term, pos);
      if (idx === -1) break;
      hits.push(idx);
      pos = idx + term.length;
    }
  }

  if (hits.length === 0) return truncateUtf16Safe(text, maxChars);

  // Find the window of `maxChars` width with the most hits
  hits.sort((a, b) => a - b);
  let bestStart = 0;
  let bestCount = 0;

  for (let i = 0; i < hits.length; i++) {
    const windowStart = Math.max(0, hits[i] - 50); // small left padding for context
    const windowEnd = windowStart + maxChars;
    let count = 0;
    for (let j = i; j < hits.length && hits[j] < windowEnd; j++) {
      count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestStart = windowStart;
    }
  }

  // Snap to sentence/line boundary if possible
  const searchStart = Math.max(0, bestStart - 30);
  const lineBreak = text.indexOf("\n", searchStart);
  if (lineBreak >= 0 && lineBreak <= bestStart + 50) {
    bestStart = lineBreak + 1;
  }

  const extracted = text.slice(bestStart, bestStart + maxChars);
  return extracted;
}

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
  importanceScore: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  emotionalValence: number | null;
};

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  queryText?: string;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source, c.importance_score, c.updated_at, c.last_accessed_at, c.emotional_valence,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      importance_score: number | null;
      updated_at: number | null;
      last_accessed_at: number | null;
      emotional_valence: number | null;
      dist: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: extractQuerySnippet(row.text, params.snippetMaxChars, params.queryText),
      source: row.source,
      importanceScore: row.importance_score ?? 1.0,
      updatedAt: row.updated_at ?? Date.now(),
      lastAccessedAt: row.last_accessed_at,
      emotionalValence: row.emotional_valence,
    }));
  }

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: extractQuerySnippet(entry.chunk.text, params.snippetMaxChars, params.queryText),
      source: entry.chunk.source,
      importanceScore: entry.chunk.importanceScore,
      updatedAt: entry.chunk.updatedAt,
      lastAccessedAt: entry.chunk.lastAccessedAt,
      emotionalValence: entry.chunk.emotionalValence,
    }));
}

export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
  importanceScore: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  emotionalValence: number | null;
}> {
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source, importance_score, updated_at, last_accessed_at, emotional_valence\n` +
        `  FROM chunks\n` +
        ` WHERE model = ?${params.sourceFilter.sql}`,
    )
    .all(params.providerModel, ...params.sourceFilter.params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
    importance_score: number | null;
    updated_at: number | null;
    last_accessed_at: number | null;
    emotional_valence: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
    importanceScore: row.importance_score ?? 1.0,
    updatedAt: row.updated_at ?? Date.now(),
    lastAccessedAt: row.last_accessed_at,
    emotionalValence: row.emotional_valence,
  }));
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string;
  query: string;
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) {
    return [];
  }

  const rows = params.db
    .prepare(
      `SELECT f.id, f.path, f.source, f.start_line, f.end_line, f.text,\n` +
        `       bm25(${params.ftsTable}) AS rank,\n` +
        `       c.importance_score, c.updated_at, c.last_accessed_at, c.emotional_valence\n` +
        `  FROM ${params.ftsTable} f\n` +
        `  JOIN chunks c ON c.id = f.id\n` +
        ` WHERE ${params.ftsTable} MATCH ? AND f.model = ?${params.sourceFilter.sql}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(ftsQuery, params.providerModel, ...params.sourceFilter.params, params.limit) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
    importance_score: number | null;
    updated_at: number | null;
    last_accessed_at: number | null;
    emotional_valence: number | null;
  }>;

  return rows.map((row) => {
    const textScore = params.bm25RankToScore(row.rank);
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet: extractQuerySnippet(row.text, params.snippetMaxChars, params.query),
      source: row.source,
      importanceScore: row.importance_score ?? 1.0,
      updatedAt: row.updated_at ?? Date.now(),
      lastAccessedAt: row.last_accessed_at,
      emotionalValence: row.emotional_valence,
    };
  });
}
