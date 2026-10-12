/**
 * PLAN-54: where curiosity targets come from, and the dedupe that keeps the
 * agent from asking the same question twice.
 *
 * Two sources carry real signal:
 *  - the `## Curiosity Gaps` section the dream rewrite writes into MEMORY.md
 *    (grounded questions about the owner's actual life and work), and
 *  - individual search queries that kept scoring poorly (the owner asked,
 *    the memory had nothing).
 *
 * Every candidate is embedded and compared with open targets and with
 * targets resolved in the last 30 days; a near-duplicate (cosine >= 0.88) is
 * dropped. Before this, the knowledge-gap generator re-created the same
 * lumped target every day and counted each expiry as "resolved".
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const CURIOSITY_DEDUPE_THRESHOLD = 0.88;
const RESOLVED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QUESTION_CHARS = 300;

/** Pull the bullet questions out of the `## Curiosity Gaps` section of MEMORY.md. */
export function parseCuriosityGaps(memoryMd: string): string[] {
  const lines = memoryMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Curiosity Gaps\b/i.test(l.trim()));
  if (start < 0) {
    return [];
  }
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line)) {
      break;
    }
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!m) {
      continue;
    }
    const text = m[1]!.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    // Template residue and empties from the heuristic fallback.
    if (!text || /^[({[]/.test(text) || /^\(none\)$/i.test(text) || text.length < 12) {
      continue;
    }
    out.push(text.slice(0, MAX_QUESTION_CHARS));
  }
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

type TargetEmbeddingRow = { id: string; embedding_json: string | null };

function knownEmbeddings(db: DatabaseSync, now: number): number[][] {
  const rows = db
    .prepare(
      `SELECT id, embedding_json FROM curiosity_targets
        WHERE embedding_json IS NOT NULL
          AND (resolved_at IS NULL OR resolved_at >= ?)`,
    )
    .all(now - RESOLVED_LOOKBACK_MS) as unknown as TargetEmbeddingRow[];
  const out: number[][] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.embedding_json ?? "[]") as unknown;
      if (Array.isArray(v) && v.length > 0) {
        out.push(v as number[]);
      }
    } catch {
      // ignore a corrupt row
    }
  }
  return out;
}

export type NovelTargetInput = {
  type: "question" | "knowledge_gap";
  description: string;
  priority: number;
  regionId?: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Insert the targets that are not near-duplicates of anything open or recently
 * resolved. Returns the ids inserted. `embed` may return null (provider down):
 * the target is then inserted without an embedding and dedupes by exact text.
 */
export async function insertNovelTargets(
  db: DatabaseSync,
  params: {
    targets: NovelTargetInput[];
    embed: (text: string) => Promise<number[] | null>;
    now?: number;
    ttlHours?: number;
    maxOpen?: number;
  },
): Promise<string[]> {
  const now = params.now ?? Date.now();
  const ttlMs = (params.ttlHours ?? 14 * 24) * 60 * 60 * 1000;
  const maxOpen = params.maxOpen ?? 12;
  const inserted: string[] = [];
  const known = knownEmbeddings(db, now);
  const openCount = () =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM curiosity_targets
            WHERE resolved_at IS NULL AND expires_at > ?
              AND (type = 'question' OR json_extract(metadata, '$.researchable') = 1)`,
        )
        .get(now) as { c: number }
    ).c;
  const exactExists = db.prepare(
    `SELECT 1 FROM curiosity_targets
      WHERE description = ? AND (resolved_at IS NULL OR resolved_at >= ?) LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO curiosity_targets
       (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at,
        attempts, embedding_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
  );
  for (const t of params.targets) {
    if (openCount() >= maxOpen) {
      break;
    }
    const description = t.description.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
    if (!description || exactExists.get(description, now - RESOLVED_LOOKBACK_MS)) {
      continue;
    }
    let embedding: number[] | null = null;
    try {
      embedding = await params.embed(description);
    } catch {
      embedding = null;
    }
    if (
      embedding &&
      known.some((k) => cosineSimilarity(k, embedding!) >= CURIOSITY_DEDUPE_THRESHOLD)
    ) {
      continue;
    }
    const id = crypto.randomUUID();
    insert.run(
      id,
      t.type,
      description,
      Math.max(0, Math.min(1, t.priority)),
      t.regionId ?? null,
      JSON.stringify({ ...t.metadata, researchable: 1 }),
      now,
      now + ttlMs,
      embedding ? JSON.stringify(embedding) : null,
    );
    if (embedding) {
      known.push(embedding);
    }
    inserted.push(id);
  }
  return inserted;
}

export type ResearchableTarget = {
  id: string;
  type: string;
  description: string;
  priority: number;
  regionId: string | null;
  attempts: number;
  metadata: Record<string, unknown>;
};

/**
 * Open targets a web search can answer, best first. Priority is lifted by
 * the region's curiosity ROI (share of earlier self-learned facts that a
 * conversation went on to use): learning-progress gating over GCCRF regions.
 */
export function researchableTargets(
  db: DatabaseSync,
  params: { now?: number; limit: number; maxAttempts?: number; regionRoi?: Map<string, number> },
): ResearchableTarget[] {
  const now = params.now ?? Date.now();
  const maxAttempts = params.maxAttempts ?? 2;
  const rows = db
    .prepare(
      `SELECT id, type, description, priority, region_id, attempts, metadata
         FROM curiosity_targets
        WHERE resolved_at IS NULL AND expires_at > ? AND attempts < ?
          AND (type = 'question' OR json_extract(metadata, '$.researchable') = 1)
        ORDER BY priority DESC, created_at ASC
        LIMIT ?`,
    )
    .all(now, maxAttempts, params.limit * 4) as unknown as Array<{
    id: string;
    type: string;
    description: string;
    priority: number;
    region_id: string | null;
    attempts: number;
    metadata: string | null;
  }>;
  const scored = rows.map((r) => {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(r.metadata ?? "{}") as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    const roi = r.region_id ? (params.regionRoi?.get(r.region_id) ?? 0) : 0;
    return {
      target: {
        id: r.id,
        type: r.type,
        description: r.description,
        priority: r.priority,
        regionId: r.region_id,
        attempts: r.attempts,
        metadata,
      },
      score: r.priority + 0.25 * roi - 0.1 * r.attempts,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, params.limit).map((s) => s.target);
}

/**
 * PLAN-54: a weak search query is a curiosity target only when a person could
 * have asked it: a question word or a trailing "?", at least four words, and
 * none of the internal probe shapes (code fragments, bare keyword lists).
 */
export function looksLikeOwnerQuestion(query: string): boolean {
  const q = query.trim();
  if (q.length < 12 || q.length > 300 || /[{}()[\]<>=;`]/.test(q)) {
    return false;
  }
  const words = q.split(/\s+/);
  if (words.length < 4) {
    return false;
  }
  const first = words[0]!.toLowerCase().replace(/[^a-z']/g, "");
  const QUESTION_WORDS = new Set([
    "who",
    "what",
    "when",
    "where",
    "why",
    "how",
    "which",
    "whose",
    "should",
    "could",
    "would",
    "will",
    "can",
    "does",
    "do",
    "did",
    "is",
    "are",
    "was",
    "were",
    "has",
    "have",
    "any",
  ]);
  return q.endsWith("?") || QUESTION_WORDS.has(first);
}
