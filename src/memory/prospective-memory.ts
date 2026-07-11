/**
 * Prospective Memory: "Remember to do X when Y happens."
 * Event-triggered future memory that transforms the agent from reactive
 * ("I remember what happened") to proactive ("I was waiting for this moment").
 *
 * FIRST IMPLEMENTATION in any agent memory system.
 *
 * Scientific basis:
 * - McDaniel, M.A. & Einstein, G.O. (2007). Prospective memory. Sage.
 *
 * PLAN-9: GAP-9 (Prospective Memory)
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

const log = createSubsystemLogger("memory/prospective");

export interface ProspectiveMemory {
  id: string;
  triggerCondition: string;
  triggerEmbedding: number[] | null;
  action: string;
  createdAt: number;
  expiresAt: number | null;
  triggeredAt: number | null;
  sourceSession: string | null;
  priority: number;
}

export interface ProspectiveConfig {
  enabled: boolean;
  /** Cosine similarity threshold for trigger matching */
  triggerThreshold: number;
  /** Default TTL for prospective memories (30 days) */
  defaultTtlMs: number;
  /** Max active prospective memories */
  maxActive: number;
}

export const DEFAULT_PROSPECTIVE_CONFIG: ProspectiveConfig = {
  enabled: true,
  triggerThreshold: 0.75,
  defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxActive: 50,
};

/**
 * PLAN-34 Phase 4 (§6.3): dream-origin predictions live in the same table,
 * marked by this source_session prefix ("dream:<insightId>"). The prefix is
 * the discriminator the endocrine renderer keys on to voice a triggered row
 * as "[dream prediction]" instead of "[reminder]" — an agent-made hypothesis
 * must never masquerade as a user-set intention.
 */
export const DREAM_PREDICTION_SOURCE_PREFIX = "dream:";
/** Dream predictions expire after 7 days — tighter than the 30-day default. */
export const DREAM_PREDICTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on concurrently active dream-origin rows (global maxActive still applies). */
export const MAX_ACTIVE_DREAM_PREDICTIONS = 5;

export function isDreamPredictionSource(sourceSession: string | null | undefined): boolean {
  return (
    typeof sourceSession === "string" && sourceSession.startsWith(DREAM_PREDICTION_SOURCE_PREFIX)
  );
}

/**
 * Prospective actions render as single `- [reminder] …` / `- [dream
 * prediction] …` lines in the system prompt. Strip C0/DEL control
 * characters (codepoint scan, not a control-char regex literal — the
 * `no-control-regex` lint bans those) and collapse whitespace so embedded
 * newlines can never smuggle extra prompt lines (e.g. a forged
 * "- [reminder] …") through LLM-generated dream content.
 */
export function sanitizePromptLine(value: string): string {
  let out = "";
  for (const ch of value) {
    const cc = ch.codePointAt(0) ?? 0;
    out += cc < 0x20 || cc === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export class ProspectiveMemoryEngine {
  private readonly db: DatabaseSync;
  private readonly config: ProspectiveConfig;

  constructor(db: DatabaseSync, config?: Partial<ProspectiveConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_PROSPECTIVE_CONFIG, ...config };
  }

  /**
   * Create a new prospective memory: "when trigger_condition matches, surface action."
   */
  create(params: {
    triggerCondition: string;
    triggerEmbedding?: number[];
    action: string;
    expiresAt?: number;
    sourceSession?: string;
    priority?: number;
  }): ProspectiveMemory | null {
    if (!this.config.enabled) {
      return null;
    }

    const activeCount = this.getActiveCount();
    if (activeCount >= this.config.maxActive) {
      log.debug("max active prospective memories reached");
      return null;
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const expiresAt = params.expiresAt ?? now + this.config.defaultTtlMs;

    try {
      this.db
        .prepare(
          `INSERT INTO prospective_memories
           (id, trigger_condition, trigger_embedding, action, created_at, expires_at, source_session, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.triggerCondition,
          params.triggerEmbedding ? JSON.stringify(params.triggerEmbedding) : null,
          params.action,
          now,
          expiresAt,
          params.sourceSession ?? null,
          params.priority ?? 0.5,
        );

      log.debug("prospective memory created", {
        trigger: params.triggerCondition.slice(0, 60),
        action: params.action.slice(0, 60),
      });

      return {
        id,
        triggerCondition: params.triggerCondition,
        triggerEmbedding: params.triggerEmbedding ?? null,
        action: params.action,
        createdAt: now,
        expiresAt,
        triggeredAt: null,
        sourceSession: params.sourceSession ?? null,
        priority: params.priority ?? 0.5,
      };
    } catch (err) {
      log.debug(`create prospective memory failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * PLAN-34 Phase 4 (§6.3): route a promoted extrapolation prediction into
   * prospective memory. Same table as reminders, tighter rules: dream-origin
   * rows cap at MAX_ACTIVE_DREAM_PREDICTIONS (on top of the global
   * maxActive), expire after 7 days instead of 30, carry the
   * "dream:<insightId>" source marker the renderer discriminates on, and
   * match ONLY via the semantic strategy (see checkTriggers). At cap, a
   * strictly-lower-confidence active row is evicted so a stale hunch cannot
   * block a stronger one for a week; otherwise the new prediction is
   * refused and reported as "capped" (surfaced via promotion telemetry).
   */
  createDreamPrediction(params: {
    triggerCondition: string;
    triggerEmbedding?: number[];
    action: string;
    insightId: string;
    confidence?: number;
  }): { status: "created"; row: ProspectiveMemory } | { status: "capped" } | { status: "refused" } {
    if (!this.config.enabled) {
      return { status: "refused" };
    }
    const confidence = Math.min(1, Math.max(0, params.confidence ?? 0.5));
    try {
      const now = Date.now();
      const active = this.db
        .prepare(
          `SELECT id, priority FROM prospective_memories
           WHERE triggered_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
             AND source_session LIKE ?
           ORDER BY priority ASC, created_at ASC`,
        )
        .all(now, `${DREAM_PREDICTION_SOURCE_PREFIX}%`) as Array<{
        id: string;
        priority: number;
      }>;
      if (active.length >= MAX_ACTIVE_DREAM_PREDICTIONS) {
        const weakest = active[0]!;
        if (weakest.priority >= confidence) {
          log.debug("max active dream predictions reached; new prediction refused");
          return { status: "capped" };
        }
        this.db.prepare(`DELETE FROM prospective_memories WHERE id = ?`).run(weakest.id);
        log.debug("evicted weakest dream prediction to admit a stronger one", {
          evicted: weakest.id,
        });
      }
    } catch {
      return { status: "refused" };
    }
    const row = this.create({
      triggerCondition: sanitizePromptLine(params.triggerCondition),
      triggerEmbedding: params.triggerEmbedding,
      action: sanitizePromptLine(params.action),
      expiresAt: Date.now() + DREAM_PREDICTION_TTL_MS,
      sourceSession: DREAM_PREDICTION_SOURCE_PREFIX + params.insightId,
      priority: confidence,
    });
    return row ? { status: "created", row } : { status: "refused" };
  }

  /**
   * Check user message against active prospective memories.
   * Returns triggered memories whose conditions match the message.
   *
   * Two matching strategies:
   * 1. Semantic: cosine similarity of message embedding vs trigger embedding
   * 2. Keyword: substring match of trigger_condition in message text
   */
  checkTriggers(params: { messageText: string; messageEmbedding?: number[] }): ProspectiveMemory[] {
    if (!this.config.enabled) {
      return [];
    }

    const now = Date.now();
    const triggered: ProspectiveMemory[] = [];

    try {
      const active = this.db
        .prepare(
          `SELECT * FROM prospective_memories
           WHERE triggered_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY priority DESC`,
        )
        .all(now) as ProspectiveRow[];

      for (const row of active) {
        let matched = false;

        // Strategy 1: Semantic matching
        if (params.messageEmbedding && row.trigger_embedding) {
          const triggerEmb = parseEmbedding(row.trigger_embedding);
          if (triggerEmb.length > 0) {
            const similarity = cosineSimilarity(params.messageEmbedding, triggerEmb);
            if (similarity >= this.config.triggerThreshold) {
              matched = true;
            }
          }
        }

        // Strategy 2: Keyword matching (case-insensitive substring).
        // PLAN-34 Phase 4 (§6.3): dream-origin predictions match ONLY via
        // the semantic strategy — substring keyword matching on a distilled
        // word-bag trigger is a standing false-fire hazard (e.g. "info"
        // matching "information" on any unrelated turn), and false-firing a
        // dream hypothesis is worse than missing it. User reminders keep
        // the keyword fallback unchanged.
        if (!matched && !isDreamPredictionSource(row.source_session)) {
          const triggerLower = row.trigger_condition.toLowerCase();
          const messageLower = params.messageText.toLowerCase();
          // Check if key phrases from trigger appear in message
          const triggerWords = triggerLower.split(/\s+/).filter((w) => w.length > 3);
          const matchedWords = triggerWords.filter((w) => messageLower.includes(w));
          if (triggerWords.length > 0 && matchedWords.length / triggerWords.length >= 0.6) {
            matched = true;
          }
        }

        if (matched) {
          // Mark as triggered
          this.db
            .prepare(`UPDATE prospective_memories SET triggered_at = ? WHERE id = ?`)
            .run(now, row.id);

          triggered.push(rowToProspective(row));
          log.debug("prospective memory triggered", {
            trigger: row.trigger_condition.slice(0, 60),
          });
        }
      }
    } catch (err) {
      log.debug(`checkTriggers failed: ${String(err)}`);
    }

    return triggered;
  }

  /**
   * Clean up expired prospective memories.
   */
  cleanExpired(): number {
    try {
      const result = this.db
        .prepare(`DELETE FROM prospective_memories WHERE expires_at IS NOT NULL AND expires_at < ?`)
        .run(Date.now());
      return (result as { changes: number }).changes;
    } catch {
      return 0;
    }
  }

  private getActiveCount(): number {
    try {
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) as c FROM prospective_memories
             WHERE triggered_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .get(Date.now()) as { c: number }
      ).c;
    } catch {
      return 0;
    }
  }
}

// ── Internal types ──

type ProspectiveRow = {
  id: string;
  trigger_condition: string;
  trigger_embedding: string | null;
  action: string;
  created_at: number;
  expires_at: number | null;
  triggered_at: number | null;
  source_session: string | null;
  priority: number;
};

function rowToProspective(row: ProspectiveRow): ProspectiveMemory {
  return {
    id: row.id,
    triggerCondition: row.trigger_condition,
    triggerEmbedding: row.trigger_embedding ? parseEmbedding(row.trigger_embedding) : null,
    action: row.action,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    triggeredAt: row.triggered_at,
    sourceSession: row.source_session,
    priority: row.priority,
  };
}
