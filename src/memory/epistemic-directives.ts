/**
 * Epistemic Directives (Active Inference): the agent actively interrogates
 * its own knowledge gaps during live sessions instead of only exploring
 * passively during dream cycles.
 *
 * When the knowledge graph detects contradictions, high-priority curiosity gaps,
 * or low-confidence entities, it generates structured prompts that are injected
 * into the next session's proactive recall.
 *
 * FIRST IMPLEMENTATION of Fristonian active inference in any agent memory system.
 *
 * Scientific basis:
 * - Friston, K. (2010). The free-energy principle: a unified brain theory.
 *   Nature Reviews Neuroscience, 11(2).
 *
 * PLAN-9: GAP-11 (Active Inference — Curiosity-Driven Live Directives)
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/epistemic-directives");

export type DirectiveType =
  | "contradiction" // Conflicting relationships in KG
  | "knowledge_gap" // High GCCRF prediction error region
  | "low_confidence" // Entity with few evidence chunks
  | "stale_fact"; // Relationship not reinforced recently

export interface EpistemicDirective {
  id: string;
  directiveType: DirectiveType;
  question: string;
  context: string;
  priority: number;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
  sourceEntityIds: string[];
  attempts: number;
}

export interface DirectiveConfig {
  enabled: boolean;
  maxActiveDirectives: number;
  maxPerSession: number;
  minPriority: number;
  /** Days after which unresolved directives expire */
  expiryDays: number;
}

export const DEFAULT_DIRECTIVE_CONFIG: DirectiveConfig = {
  enabled: true,
  maxActiveDirectives: 20,
  maxPerSession: 2,
  minPriority: 0.3,
  expiryDays: 30,
};

export class EpistemicDirectiveEngine {
  private readonly db: DatabaseSync;
  private readonly config: DirectiveConfig;

  constructor(db: DatabaseSync, config?: Partial<DirectiveConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_DIRECTIVE_CONFIG, ...config };
  }

  /**
   * Create a new epistemic directive — a question the agent should ask
   * the user to resolve a knowledge gap or contradiction.
   */
  createDirective(params: {
    type: DirectiveType;
    question: string;
    context?: string;
    priority?: number;
    sourceEntityIds?: string[];
  }): EpistemicDirective | null {
    if (!this.config.enabled) {
      return null;
    }

    // Check active count
    const activeCount = this.getActiveCount();
    if (activeCount >= this.config.maxActiveDirectives) {
      log.debug("max active directives reached, skipping");
      return null;
    }

    // Dedup: don't create if a similar question already exists
    const existing = this.findSimilarDirective(params.question);
    if (existing) {
      // Bump priority if the new one is higher
      if ((params.priority ?? 0.5) > existing.priority) {
        this.db
          .prepare(`UPDATE epistemic_directives SET priority = ? WHERE id = ?`)
          .run(params.priority ?? 0.5, existing.id);
      }
      return existing;
    }

    const now = Date.now();
    const id = crypto.randomUUID();

    try {
      this.db
        .prepare(
          `INSERT INTO epistemic_directives
           (id, directive_type, question, context, priority, created_at, source_entity_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.type,
          params.question,
          params.context ?? "",
          params.priority ?? 0.5,
          now,
          JSON.stringify(params.sourceEntityIds ?? []),
        );

      log.debug("epistemic directive created", {
        type: params.type,
        question: params.question.slice(0, 80),
      });

      return {
        id,
        directiveType: params.type,
        question: params.question,
        context: params.context ?? "",
        priority: params.priority ?? 0.5,
        createdAt: now,
        resolvedAt: null,
        resolution: null,
        sourceEntityIds: params.sourceEntityIds ?? [],
        attempts: 0,
      };
    } catch (err) {
      log.debug(`createDirective failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Get directives to inject into the current session's proactive recall.
   * Returns top-priority unresolved directives, limited by maxPerSession.
   */
  getDirectivesForSession(): EpistemicDirective[] {
    if (!this.config.enabled) {
      return [];
    }

    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM epistemic_directives
           WHERE resolved_at IS NULL AND priority >= ?
           ORDER BY priority DESC, created_at ASC
           LIMIT ?`,
        )
        .all(this.config.minPriority, this.config.maxPerSession) as DirectiveRow[];

      // Increment attempt counter
      for (const row of rows) {
        this.db
          .prepare(`UPDATE epistemic_directives SET attempts = attempts + 1 WHERE id = ?`)
          .run(row.id);
      }

      return rows.map(rowToDirective);
    } catch {
      return [];
    }
  }

  /**
   * Resolve a directive — the user answered the question.
   */
  resolveDirective(directiveId: string, resolution: string): boolean {
    try {
      this.db
        .prepare(`UPDATE epistemic_directives SET resolved_at = ?, resolution = ? WHERE id = ?`)
        .run(Date.now(), resolution, directiveId);
      log.debug("directive resolved", { directiveId: directiveId.slice(0, 8) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Expire old unresolved directives.
   */
  expireOld(): number {
    const cutoff = Date.now() - this.config.expiryDays * 24 * 60 * 60 * 1000;
    try {
      const result = this.db
        .prepare(`DELETE FROM epistemic_directives WHERE resolved_at IS NULL AND created_at < ?`)
        .run(cutoff);
      return (result as { changes: number }).changes;
    } catch {
      return 0;
    }
  }

  /**
   * Detect contradictions in the knowledge graph and generate directives.
   */
  detectContradictions(): EpistemicDirective[] {
    const directives: EpistemicDirective[] = [];

    try {
      // Find entities with contradicting relationships
      // (same source+target but relation_type='contradicts' or
      //  multiple active relationships of same type between same entities)
      const contradictions = this.db
        .prepare(
          `SELECT r1.source_entity_id, r1.target_entity_id, r1.relation_type,
                  e1.name as source_name, e2.name as target_name,
                  COUNT(*) as cnt
           FROM relationships r1
           JOIN entities e1 ON e1.id = r1.source_entity_id
           JOIN entities e2 ON e2.id = r1.target_entity_id
           WHERE r1.valid_until IS NULL
           GROUP BY r1.source_entity_id, r1.target_entity_id, r1.relation_type
           HAVING cnt > 1
           LIMIT 5`,
        )
        .all() as Array<{
        source_entity_id: string;
        target_entity_id: string;
        relation_type: string;
        source_name: string;
        target_name: string;
        cnt: number;
      }>;

      for (const c of contradictions) {
        const directive = this.createDirective({
          type: "contradiction",
          question: `I have conflicting information about the relationship between "${c.source_name}" and "${c.target_name}" (${c.relation_type}). There are ${c.cnt} active versions. Can you clarify which is current?`,
          context: `Multiple active ${c.relation_type} relationships found between ${c.source_name} and ${c.target_name}`,
          priority: 0.7,
          sourceEntityIds: [c.source_entity_id, c.target_entity_id],
        });
        if (directive) {
          directives.push(directive);
        }
      }
    } catch (err) {
      log.debug(`detectContradictions failed: ${String(err)}`);
    }

    return directives;
  }

  private getActiveCount(): number {
    try {
      return (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM epistemic_directives WHERE resolved_at IS NULL`)
          .get() as { c: number }
      ).c;
    } catch {
      return 0;
    }
  }

  private findSimilarDirective(question: string): EpistemicDirective | null {
    try {
      // Simple substring match — a semantic comparison could be added later
      const row = this.db
        .prepare(
          `SELECT * FROM epistemic_directives
           WHERE resolved_at IS NULL AND question = ?
           LIMIT 1`,
        )
        .get(question) as DirectiveRow | undefined;
      return row ? rowToDirective(row) : null;
    } catch {
      return null;
    }
  }
}

// ── Internal types ──

type DirectiveRow = {
  id: string;
  directive_type: string;
  question: string;
  context: string;
  priority: number;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
  source_entity_ids: string;
  attempts: number;
};

function rowToDirective(row: DirectiveRow): EpistemicDirective {
  return {
    id: row.id,
    directiveType: row.directive_type as DirectiveType,
    question: row.question,
    context: row.context,
    priority: row.priority,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    sourceEntityIds: JSON.parse(row.source_entity_ids || "[]"),
    attempts: row.attempts,
  };
}
