/**
 * Request Frequency Analyzer
 *
 * PLAN-11 Gap 1: converts repeated user queries into actionable curiosity
 * signals. Without this, a user can ask about "Next.js routing" five times
 * across a week and that signal dies in the curiosity_queries table — no
 * exploration target gets created.
 *
 * Algorithm (deliberately simple; no embeddings for MVP):
 *   1. Read recent queries from curiosity_queries (last N days).
 *   2. Normalize (lowercase, strip stopwords, extract bigrams + trigrams).
 *   3. Count n-gram frequency across the window.
 *   4. For each n-gram with frequency ≥ threshold, check if a
 *      knowledge_gap curiosity_target with a similar description already
 *      exists (case-insensitive substring match). If yes, skip.
 *   5. Otherwise, inject a new knowledge_gap target with the n-gram as the
 *      description, which the dream engine will then process on its next
 *      exploration cycle.
 *
 * Runs on the 30-minute consolidation interval — low overhead, fires often
 * enough that new topics surface within one dream cycle.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/request-frequency-analyzer");

// English stopwords — not comprehensive, but enough to get signal through.
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "else",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "up",
  "down",
  "out",
  "over",
  "under",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "having",
  "can",
  "could",
  "would",
  "should",
  "will",
  "may",
  "might",
  "must",
  "shall",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "them",
  "us",
  "me",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
  "what",
  "who",
  "when",
  "where",
  "why",
  "how",
  "which",
  "whom",
  "whose",
  "so",
  "than",
  "such",
  "as",
  "too",
  "very",
  "just",
  "also",
  "only",
  "no",
  "not",
  "now",
  "then",
  "there",
  "here",
  "because",
  "about",
  "again",
  "any",
  "some",
  "more",
  "most",
  "other",
  "new",
  "old",
  "know",
  "knows",
  "knew",
  "like",
  "want",
  "need",
  "get",
  "got",
  "help",
  "please",
  "thanks",
  "thank",
  "okay",
  "ok",
  "yes",
  "sure",
  "tell",
  "show",
  "explain",
  "find",
  "let",
  "see",
  "look",
  "use",
  "using",
  "make",
  "made",
  "ing",
  "ed",
]);

const WORD_RE = /[a-z][a-z0-9+#.-]{1,}/g;
const MIN_TOKEN_LEN = 3;
const MAX_TOKEN_LEN = 40;

// ── Types ──

export type FrequencySignal = {
  phrase: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sampleQueries: string[];
};

export type AnalyzeOptions = {
  /** Window in days. Default 7. */
  lookbackDays?: number;
  /** Minimum phrase frequency to surface as a signal. Default 3. */
  minFrequency?: number;
  /** Only emit the top N signals (by frequency, tiebreak on recency). Default 5. */
  maxSignals?: number;
  /** Override "now" for deterministic tests. Default Date.now(). */
  now?: number;
};

export type InjectResult = {
  injected: number;
  skippedDueToDuplicate: number;
  signals: FrequencySignal[];
};

// ── Public API ──

export function analyzeRequestFrequency(
  db: DatabaseSync,
  opts: AnalyzeOptions = {},
): FrequencySignal[] {
  const lookbackDays = opts.lookbackDays ?? 7;
  const minFrequency = opts.minFrequency ?? 3;
  const maxSignals = opts.maxSignals ?? 5;
  const now = opts.now ?? Date.now();
  const since = now - lookbackDays * 86_400_000;

  let rows: Array<{ query: string; timestamp: number }> = [];
  try {
    rows = db
      .prepare(
        `SELECT query, timestamp FROM curiosity_queries
         WHERE timestamp >= ? AND timestamp < ?
         ORDER BY timestamp DESC`,
      )
      .all(since, now) as typeof rows;
  } catch {
    // Table absent (curiosity schema not initialized yet)
    return [];
  }

  if (rows.length === 0) {
    return [];
  }

  // Phrase → aggregate
  const phrases = new Map<
    string,
    { count: number; firstSeenAt: number; lastSeenAt: number; samples: string[] }
  >();

  for (const row of rows) {
    const queryTokens = tokenize(row.query);
    const ngrams = extractNgrams(queryTokens, [2, 3]);
    for (const phrase of ngrams) {
      const existing = phrases.get(phrase);
      if (existing) {
        existing.count += 1;
        existing.firstSeenAt = Math.min(existing.firstSeenAt, row.timestamp);
        existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestamp);
        if (existing.samples.length < 3 && !existing.samples.includes(row.query)) {
          existing.samples.push(row.query);
        }
      } else {
        phrases.set(phrase, {
          count: 1,
          firstSeenAt: row.timestamp,
          lastSeenAt: row.timestamp,
          samples: [row.query],
        });
      }
    }
  }

  // Rank and filter
  const signals: FrequencySignal[] = [];
  for (const [phrase, agg] of phrases) {
    if (agg.count >= minFrequency) {
      signals.push({
        phrase,
        count: agg.count,
        firstSeenAt: agg.firstSeenAt,
        lastSeenAt: agg.lastSeenAt,
        sampleQueries: agg.samples,
      });
    }
  }

  signals.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return b.lastSeenAt - a.lastSeenAt;
  });

  // Collapse overlapping phrases: if "react hooks tutorial" and "react hooks"
  // both pass the threshold, keep the longer one (more specific signal).
  const collapsed = collapseSubsumedPhrases(signals);
  return collapsed.slice(0, maxSignals);
}

/**
 * Inject signal phrases as knowledge_gap curiosity targets, skipping ones
 * that already have a matching unresolved target.
 */
export function injectFrequencyTargets(
  db: DatabaseSync,
  signals: FrequencySignal[],
  opts: { ttlDays?: number; now?: number } = {},
): InjectResult {
  const ttlDays = opts.ttlDays ?? 14;
  const now = opts.now ?? Date.now();
  const ttlMs = ttlDays * 86_400_000;

  let injected = 0;
  let skipped = 0;

  // Read existing unresolved knowledge_gap descriptions once.
  let existingDescriptions: string[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT description FROM curiosity_targets
         WHERE type = 'knowledge_gap' AND resolved_at IS NULL AND expires_at > ?`,
      )
      .all(now) as Array<{ description: string }>;
    existingDescriptions = rows.map((r) => r.description.toLowerCase());
  } catch {
    // curiosity_targets table absent
    return { injected, skippedDueToDuplicate: 0, signals: [] };
  }

  for (const signal of signals) {
    const description = `User-requested topic: ${signal.phrase}`;
    const descLower = description.toLowerCase();
    const isDuplicate = existingDescriptions.some(
      (d) => d.includes(signal.phrase.toLowerCase()) || descLower.includes(d.slice(0, 40)),
    );
    if (isDuplicate) {
      skipped += 1;
      continue;
    }
    try {
      db.prepare(
        `INSERT INTO curiosity_targets
         (id, type, description, priority, region_id, metadata, created_at, resolved_at, expires_at)
         VALUES (?, 'knowledge_gap', ?, ?, NULL, ?, ?, NULL, ?)`,
      ).run(
        crypto.randomUUID(),
        description,
        // Priority: 0.3 base + 0.05 per additional query over threshold, capped.
        Math.min(0.9, 0.3 + Math.max(0, signal.count - 3) * 0.05),
        JSON.stringify({
          source: "request_frequency",
          phrase: signal.phrase,
          count: signal.count,
          sampleQueries: signal.sampleQueries,
        }),
        now,
        now + ttlMs,
      );
      injected += 1;
      existingDescriptions.push(descLower);
    } catch (err) {
      log.warn(`inject curiosity_target failed: ${String(err)}`);
    }
  }

  if (injected > 0) {
    log.info(
      `request-frequency analyzer injected ${injected} target(s), skipped ${skipped} duplicate(s)`,
    );
  }

  return { injected, skippedDueToDuplicate: skipped, signals };
}

// ── Helpers (exported for tests) ──

export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const matches = lowered.match(WORD_RE) ?? [];
  return matches.filter(
    (t) => t.length >= MIN_TOKEN_LEN && t.length <= MAX_TOKEN_LEN && !STOPWORDS.has(t),
  );
}

/**
 * Extract n-grams of the specified orders from a token list. Order matters:
 * phrases preserve the original word order.
 */
export function extractNgrams(tokens: string[], orders: number[]): string[] {
  const ngrams: string[] = [];
  for (const n of orders) {
    if (n <= 0 || n > tokens.length) {
      continue;
    }
    for (let i = 0; i <= tokens.length - n; i++) {
      ngrams.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return ngrams;
}

/**
 * Collapse phrases where a shorter phrase is fully contained in a
 * higher-ranked longer phrase. Keeps only the most specific form — avoids
 * injecting both "react hooks" and "react hooks tutorial" when they both
 * pass the threshold.
 */
export function collapseSubsumedPhrases(signals: FrequencySignal[]): FrequencySignal[] {
  const kept: FrequencySignal[] = [];
  for (const signal of signals) {
    const isSubsumed = kept.some((k) => k.phrase.includes(signal.phrase));
    if (!isSubsumed) {
      kept.push(signal);
    }
  }
  return kept;
}
