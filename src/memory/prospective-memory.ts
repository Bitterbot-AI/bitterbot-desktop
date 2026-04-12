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

        // Strategy 2: Keyword matching (case-insensitive substring)
        if (!matched) {
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
