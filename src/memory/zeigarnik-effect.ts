/**
 * Zeigarnik Effect — Open Loop Detection: unfinished tasks are remembered
 * better than finished ones. Detects open loops (started but unresolved tasks,
 * unanswered questions, unfixed errors) and gives them decay resistance.
 *
 * FIRST IMPLEMENTATION of the Zeigarnik effect in any agent memory system.
 *
 * Scientific basis:
 * - Zeigarnik, B. (1927). Das Behalten erledigter und unerledigter Handlungen.
 * - Masicampo, E.J. & Baumeister, R.F. (2011). Plan making eliminates
 *   cognitive effects of unfulfilled goals.
 *
 * PLAN-9: GAP-8 (Zeigarnik Effect — Open Loop Detection)
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/zeigarnik");

/** Patterns that indicate an open loop (unfinished business). */
const OPEN_LOOP_PATTERNS = [
  /\b(?:todo|to-do|need to|have to|should|must)\b.*(?:later|tomorrow|next|soon|eventually)/i,
  /\b(?:working on|started|in progress|wip)\b/i,
  /\b(?:not sure|don't know|unclear|confused about|need to figure out)\b/i,
  /\b(?:bug|error|issue|broken|failing|crashed)\b.*(?:still|remains|unresolved|unfixed)/i,
  /\b(?:will do|gonna|going to|plan to)\b/i,
  /\b(?:remind me|don't forget|remember to)\b/i,
  /\?\s*$/m, // Ends with a question mark (unanswered question)
];

/** Patterns that indicate resolution (loop closed). */
const RESOLUTION_PATTERNS = [
  /\b(?:done|completed|finished|resolved|fixed|solved|shipped)\b/i,
  /\b(?:no longer|not anymore|already|taken care of)\b/i,
  /\b(?:works now|passes now|all good|all set)\b/i,
];

export interface ZeigarnikConfig {
  enabled: boolean;
  /** Decay resistance multiplier for open loops (e.g., 1.5 = 50% slower decay) */
  decayResistance: number;
  /** Minimum text length to scan for patterns */
  minTextLength: number;
}

export const DEFAULT_ZEIGARNIK_CONFIG: ZeigarnikConfig = {
  enabled: true,
  decayResistance: 1.5,
  minTextLength: 20,
};

/**
 * Detect if a chunk of text contains an open loop pattern.
 * Returns the matched context string if detected, null otherwise.
 */
export function detectOpenLoop(text: string, config?: Partial<ZeigarnikConfig>): string | null {
  const cfg = { ...DEFAULT_ZEIGARNIK_CONFIG, ...config };
  if (!cfg.enabled || text.length < cfg.minTextLength) return null;

  for (const pattern of OPEN_LOOP_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      // Extract surrounding context (up to 100 chars around match)
      const start = Math.max(0, match.index - 30);
      const end = Math.min(text.length, match.index + match[0].length + 70);
      return text.slice(start, end).trim();
    }
  }
  return null;
}

/**
 * Detect if text indicates resolution of an open loop.
 */
export function detectResolution(text: string): boolean {
  return RESOLUTION_PATTERNS.some((p) => p.test(text));
}

/**
 * Mark a chunk as an open loop.
 */
export function markOpenLoop(db: DatabaseSync, chunkId: string, context: string): boolean {
  try {
    db.prepare(`UPDATE chunks SET open_loop = 1, open_loop_context = ? WHERE id = ?`).run(
      context.slice(0, 500),
      chunkId,
    );
    log.debug("chunk marked as open loop", { chunkId: chunkId.slice(0, 8) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the open loop flag when resolution is detected.
 */
export function closeOpenLoop(db: DatabaseSync, chunkId: string): boolean {
  try {
    db.prepare(`UPDATE chunks SET open_loop = 0, open_loop_context = NULL WHERE id = ?`).run(
      chunkId,
    );
    log.debug("open loop closed", { chunkId: chunkId.slice(0, 8) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all active open loops for proactive surfacing.
 * Returns chunks tagged as open loops, ordered by importance.
 */
export function getActiveOpenLoops(
  db: DatabaseSync,
  limit = 5,
): Array<{ id: string; text: string; context: string; importance: number; ageDays: number }> {
  try {
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT id, text, open_loop_context, importance_score, created_at
         FROM chunks
         WHERE open_loop = 1
           AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated')
         ORDER BY importance_score DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      text: string;
      open_loop_context: string;
      importance_score: number;
      created_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      text: r.text.slice(0, 200),
      context: r.open_loop_context ?? "",
      importance: r.importance_score,
      ageDays: (now - r.created_at) / (24 * 60 * 60 * 1000),
    }));
  } catch {
    return [];
  }
}

/**
 * Scan chunks for open loop patterns during session extraction.
 * Marks detected open loops and returns count.
 */
export function scanForOpenLoops(
  db: DatabaseSync,
  chunkIds: string[],
  config?: Partial<ZeigarnikConfig>,
): number {
  let marked = 0;
  try {
    for (const id of chunkIds) {
      const row = db.prepare(`SELECT text, open_loop FROM chunks WHERE id = ?`).get(id) as
        | { text: string; open_loop: number }
        | undefined;

      if (!row || row.open_loop === 1) continue;

      const context = detectOpenLoop(row.text, config);
      if (context) {
        markOpenLoop(db, id, context);
        marked++;
      }
    }
  } catch (err) {
    log.debug(`scanForOpenLoops failed: ${String(err)}`);
  }
  return marked;
}
