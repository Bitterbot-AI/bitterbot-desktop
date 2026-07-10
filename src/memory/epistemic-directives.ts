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
  | "stale_fact" // Relationship not reinforced recently
  | "graph_bridge"; // PLAN-18: SAGE reader missed a chunk vector/FTS found

/**
 * PLAN-34 Phase 1: types whose questions a USER can answer in conversation.
 * Only these appear in the extractor's Open Questions block and only these
 * are subject to the maxAsks ceiling. graph_bridge nudges are exempt —
 * PLAN-18's persistent-injection mechanism is preserved (its historical
 * attempts=491 was the per-read counter bug, not a design verdict).
 */
export const USER_ANSWERABLE_TYPES: ReadonlySet<DirectiveType> = new Set([
  "contradiction",
  "knowledge_gap",
  "low_confidence",
  "stale_fact",
]);

/** A user-answerable question stops injecting after this many sessions. */
export const MAX_ASKS = 3;

/** Consumed conflict rows older than this are pruned at sweep time. */
const CONFLICT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Canonical values render into prompt-injected question lines. */
function sanitizeValueForPrompt(value: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping control chars is the point
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type DirectiveStatus = "open" | "answered" | "expired";

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
  status: DirectiveStatus;
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
  /**
   * Per session key: the directive ids whose injection has been counted
   * this process. Attempts increment at most once per (session key,
   * directive) — per-turn re-renders of the same conversation never
   * re-count, while a question that first appears mid-conversation still
   * gets its one count. In-memory on purpose: a restart (or the 1000-key
   * FIFO eviction) can at worst cost one extra count per conversation,
   * which the maxAsks ceiling tolerates.
   */
  private readonly injectionCountedKeys = new Map<string, Set<string>>();

  constructor(db: DatabaseSync, config?: Partial<DirectiveConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_DIRECTIVE_CONFIG, ...config };
  }

  /**
   * Best-effort funnel audit row (PLAN-34 Phase 6 derives the directive
   * funnel — created/injected/answered/resolved — from these).
   */
  private auditLog(directiveId: string, event: string, metadata?: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
           VALUES (?, ?, ?, ?, 'epistemic_directives', ?)`,
        )
        .run(crypto.randomUUID(), directiveId, event, Date.now(), JSON.stringify(metadata ?? {}));
    } catch {
      // Audit logging is non-critical.
    }
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
      this.auditLog(id, "directive_created", { type: params.type });

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
        status: "open",
      };
    } catch (err) {
      log.debug(`createDirective failed: ${String(err)}`);
      return null;
    }
  }

  /** Fetch a directive by id. */
  getDirective(id: string): EpistemicDirective | null {
    try {
      const row = this.db.prepare(`SELECT * FROM epistemic_directives WHERE id = ?`).get(id) as
        | DirectiveRow
        | undefined;
      return row ? rowToDirective(row) : null;
    } catch {
      return null;
    }
  }

  /**
   * PLAN-34 Phase 1: side-effect-free read for the session extractor's
   * Open Questions block. Returns only OPEN, unresolved, USER-ANSWERABLE
   * questions (graph_bridge nudges never appear here) and never mutates
   * attempts or harvests targets.
   */
  listOpenDirectives(limit = 5): EpistemicDirective[] {
    if (!this.config.enabled) {
      return [];
    }
    try {
      const types = [...USER_ANSWERABLE_TYPES];
      const placeholders = types.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT * FROM epistemic_directives
           WHERE resolved_at IS NULL AND status = 'open'
             AND directive_type IN (${placeholders})
           ORDER BY priority DESC, created_at ASC
           LIMIT ?`,
        )
        .all(...types, limit) as DirectiveRow[];
      return rows.map(rowToDirective);
    } catch {
      return [];
    }
  }

  /**
   * Get directives to inject into the current session's proactive recall.
   * Returns top-priority unresolved directives, limited by maxPerSession.
   *
   * PLAN-34 Phase 1: the read no longer mutates attempts. Attempts count
   * actual prompt injection, at most once per session key — pass the
   * session key ONLY from live-turn callers (never compaction/status
   * probes). User-answerable questions demote after MAX_ASKS injections
   * via the query predicate; graph_bridge nudges are exempt.
   */
  getDirectivesForSession(opts?: { sessionKey?: string }): EpistemicDirective[] {
    if (!this.config.enabled) {
      return [];
    }

    // PLAN-18 Phase 4 — pull any pending graph_bridge curiosity targets
    // into the directive stream so the next session's extractor prompt
    // sees them. Just-in-time harvest avoids needing a separate cron.
    this.harvestGraphBridgeTargets();

    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM epistemic_directives
           WHERE resolved_at IS NULL AND status = 'open' AND priority >= ?
             AND (directive_type = 'graph_bridge' OR attempts < ?)
           ORDER BY priority DESC, created_at ASC
           LIMIT ?`,
        )
        .all(this.config.minPriority, MAX_ASKS, this.config.maxPerSession) as DirectiveRow[];

      if (opts?.sessionKey && rows.length > 0) {
        this.markInjected(
          rows.map((r) => r.id),
          opts.sessionKey,
        );
      }

      return rows.map(rowToDirective);
    } catch {
      return [];
    }
  }

  /**
   * Count an actual prompt injection: attempts + 1 per directive, at most
   * once per (session key, directive). Tracked per directive id (not just
   * per key) so a question that first becomes eligible mid-conversation is
   * still counted for that conversation. Public so the injection call site
   * stays honest about when a question was really voiced.
   */
  markInjected(directiveIds: string[], sessionKey: string): void {
    let counted = this.injectionCountedKeys.get(sessionKey);
    if (!counted) {
      counted = new Set<string>();
      this.injectionCountedKeys.set(sessionKey, counted);
      if (this.injectionCountedKeys.size > 1000) {
        const oldest = this.injectionCountedKeys.keys().next().value;
        if (oldest !== undefined) {
          this.injectionCountedKeys.delete(oldest);
        }
      }
    }
    try {
      const stmt = this.db.prepare(
        `UPDATE epistemic_directives SET attempts = attempts + 1 WHERE id = ?`,
      );
      for (const id of directiveIds) {
        if (counted.has(id)) {
          continue;
        }
        counted.add(id);
        stmt.run(id);
        this.auditLog(id, "directive_injected", { sessionKey });
      }
    } catch (err) {
      log.debug(`markInjected failed: ${String(err)}`);
    }
  }

  /**
   * PLAN-34 Phase 1 two-tier resolution, tier 1: a qualifying extraction
   * found the user's answer. The question stops injecting immediately;
   * resolved_at is set only by finalizeAnswered once the answer survives
   * the next extraction cycle uncontradicted. Late answers to demoted
   * (still open) and expired questions still land here; an already-answered
   * question is never re-answered (a second session in the same run must
   * not overwrite the first resolution or duplicate its crystal/pin).
   */
  markAnswered(directiveId: string, answer: string): boolean {
    try {
      const result = this.db
        .prepare(
          `UPDATE epistemic_directives SET status = 'answered', resolution = ?
           WHERE id = ? AND resolved_at IS NULL AND status != 'answered'`,
        )
        .run(answer, directiveId);
      const changed = Number((result as { changes: number | bigint }).changes) > 0;
      if (changed) {
        this.auditLog(directiveId, "directive_answered", { answer: answer.slice(0, 200) });
        log.debug("directive answered", { directiveId: directiveId.slice(0, 8) });
      }
      return changed;
    } catch {
      return false;
    }
  }

  /**
   * PLAN-34 Phase 1 two-tier resolution, tier 2: set resolved_at on
   * directives answered BEFORE cutoffTs (i.e. in an earlier extraction
   * cycle) whose answer survived uncontradicted. `isContradicted` is the
   * caller's domain check (e.g. the canonical ledger moved away from the
   * stored answer); contradicted answers never set resolved_at — the
   * contradiction machinery re-asks via a NEW directive instead.
   */
  finalizeAnswered(cutoffTs: number, isContradicted?: (d: EpistemicDirective) => boolean): number {
    let resolvedCount = 0;
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM epistemic_directives WHERE status = 'answered' AND resolved_at IS NULL`,
        )
        .all() as DirectiveRow[];
      if (rows.length === 0) {
        return 0;
      }
      const answeredAtStmt = this.db.prepare(
        `SELECT MAX(timestamp) AS t FROM memory_audit_log
         WHERE chunk_id = ? AND event = 'directive_answered'`,
      );
      const resolveStmt = this.db.prepare(
        `UPDATE epistemic_directives SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`,
      );
      const now = Date.now();
      for (const row of rows) {
        const answeredAt = (answeredAtStmt.get(row.id) as { t: number | null } | undefined)?.t;
        if (answeredAt == null) {
          // The answered audit row was lost (best-effort insert). Backfill
          // it now so the survival clock starts — without this the row
          // would sit in 'answered' limbo forever.
          this.auditLog(row.id, "directive_answered", { backfilled: true });
          continue;
        }
        if (answeredAt >= cutoffTs) {
          continue; // answered in THIS cycle — survival window not yet passed
        }
        const directive = rowToDirective(row);
        if (isContradicted?.(directive)) {
          // Terminal, never resolved — and never left in 'answered' limbo:
          // flipping to 'expired' frees the active-directive cap and lets
          // the conflict machinery re-ask via a NEW directive for the key
          // (the sweep dedupe only matches open/answered rows).
          this.db
            .prepare(`UPDATE epistemic_directives SET status = 'expired' WHERE id = ?`)
            .run(row.id);
          this.auditLog(row.id, "directive_answer_contradicted");
          continue;
        }
        resolveStmt.run(now, row.id);
        this.auditLog(row.id, "directive_resolved");
        resolvedCount++;
      }
    } catch (err) {
      log.debug(`finalizeAnswered failed: ${String(err)}`);
    }
    return resolvedCount;
  }

  /**
   * Resolve a directive directly (deliberate API — skips the two-tier
   * survival window).
   */
  resolveDirective(directiveId: string, resolution: string): boolean {
    try {
      this.db
        .prepare(
          `UPDATE epistemic_directives
           SET resolved_at = ?, resolution = ?, status = 'answered' WHERE id = ?`,
        )
        .run(Date.now(), resolution, directiveId);
      this.auditLog(directiveId, "directive_resolved");
      log.debug("directive resolved", { directiveId: directiveId.slice(0, 8) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Expire old unresolved directives. PLAN-34 Phase 1: asked-but-unresolved
   * questions get a status flip (not DELETE) so a late answer arriving
   * within the retention window can still resolve them; never-asked ones
   * are deleted as before (no answer can ever arrive for a question that
   * was never voiced). Expired rows are terminal — they no longer count
   * against the active cap, block dedupe, or appear in the extractor's
   * open-questions list — and are purged for good after a second expiry
   * window so the table cannot grow without bound.
   */
  expireOld(): number {
    const now = Date.now();
    const expiryMs = this.config.expiryDays * 24 * 60 * 60 * 1000;
    const cutoff = now - expiryMs;
    try {
      const deleted = this.db
        .prepare(
          `DELETE FROM epistemic_directives
           WHERE resolved_at IS NULL AND status = 'open' AND attempts = 0 AND created_at < ?`,
        )
        .run(cutoff);
      const expired = this.db
        .prepare(
          `UPDATE epistemic_directives SET status = 'expired'
           WHERE resolved_at IS NULL AND status = 'open' AND attempts > 0 AND created_at < ?`,
        )
        .run(cutoff);
      const purged = this.db
        .prepare(
          `DELETE FROM epistemic_directives
           WHERE resolved_at IS NULL AND status = 'expired' AND created_at < ?`,
        )
        .run(now - 2 * expiryMs);
      return (
        Number((deleted as { changes: number | bigint }).changes) +
        Number((expired as { changes: number | bigint }).changes) +
        Number((purged as { changes: number | bigint }).changes)
      );
    } catch {
      return 0;
    }
  }

  /**
   * PLAN-34 Phase 1 fuel: sweep unconsumed canonical-ledger conflict events
   * (recorded by CanonicalFactsStore.pin — tier rejections and rapid
   * same-key supersedes) into contradiction directives the USER is uniquely
   * able to answer: "Which is current for <key>?". One open directive per
   * key at a time; every swept conflict row is marked consumed with the
   * directive that covers it. The directive carries the two candidate
   * values (`candidate:` entries in sourceEntityIds) so the resolution
   * layer can constrain any canonical pin to one of the values actually in
   * dispute — never an arbitrary quoted string. Consumed rows older than
   * the retention window are pruned so the table cannot grow forever.
   */
  sweepCanonicalConflicts(limit = 10): number {
    let created = 0;
    try {
      this.db
        .prepare(`DELETE FROM canonical_conflicts WHERE consumed_at IS NOT NULL AND created_at < ?`)
        .run(Date.now() - CONFLICT_RETENTION_MS);
      const rows = this.db
        .prepare(
          `SELECT * FROM canonical_conflicts WHERE consumed_at IS NULL
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(limit) as ConflictRow[];
      if (rows.length === 0) {
        return 0;
      }
      const consumeStmt = this.db.prepare(
        `UPDATE canonical_conflicts SET consumed_at = ?, directive_id = ? WHERE id = ?`,
      );
      // Contradicted-answer and expired directives leave the dedupe set, so
      // a fresh conflict for the key re-asks via a NEW directive. '_' and
      // '%' in keys are escaped — LIKE must match literally, never wildcard
      // across similar keys.
      const existingStmt = this.db.prepare(
        `SELECT id FROM epistemic_directives
         WHERE resolved_at IS NULL AND status IN ('open', 'answered')
           AND source_entity_ids LIKE ? ESCAPE '\\' LIMIT 1`,
      );
      const now = Date.now();
      for (const row of rows) {
        const tag = `canonical:${row.key}`;
        const escapedTag = tag.replace(/[\\%_]/g, (c) => `\\${c}`);
        const existing = existingStmt.get(`%"${escapedTag}"%`) as { id: string } | undefined;
        if (existing) {
          consumeStmt.run(now, existing.id, row.id);
          continue;
        }
        // Values render into a prompt-injected question line — neutralize
        // control characters and newlines before embedding them.
        const a = sanitizeValueForPrompt(row.current_value);
        const b = sanitizeValueForPrompt(row.proposed_value);
        const directive = this.createDirective({
          type: "contradiction",
          question: `Which is current for ${row.key}: "${a.slice(0, 120)}" or "${b.slice(0, 120)}"?`,
          context:
            `Canonical ledger conflict (${row.kind}): ${row.proposed_source} proposed ` +
            `"${b.slice(0, 80)}" against ${row.current_source} "${a.slice(0, 80)}"`,
          priority: 0.7,
          sourceEntityIds: [
            tag,
            `candidate:${row.current_value}`,
            `candidate:${row.proposed_value}`,
          ],
        });
        if (directive) {
          consumeStmt.run(now, directive.id, row.id);
          created++;
        }
        // If the active-directive cap blocked creation, leave the conflict
        // unconsumed — a later sweep retries once capacity frees up.
      }
    } catch (err) {
      log.debug(`sweepCanonicalConflicts failed: ${String(err)}`);
    }
    return created;
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

  /**
   * PLAN-18 Phase 4 — convert active `graph_bridge` curiosity targets
   * into epistemic directives. Each conversion marks the source target
   * resolved so we don't re-harvest the same signal on every session.
   *
   * The directive `question` is the natural-language nudge built by
   * `graph-bridge-target.ts` at signal-emit time. By the time the
   * session extractor reads `getDirectivesForSession()`, the nudge is
   * already shaped for prompt injection.
   */
  private harvestGraphBridgeTargets(): void {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, metadata, priority FROM curiosity_targets
           WHERE type = 'graph_bridge' AND resolved_at IS NULL
           ORDER BY priority DESC, created_at DESC LIMIT 5`,
        )
        .all() as Array<{ id: string; metadata: string; priority: number }>;
      if (rows.length === 0) {
        return;
      }
      const now = Date.now();
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.metadata) as {
            nudge?: string;
            query?: string;
            truthEntityIds?: string[];
          };
          const nudge = meta.nudge ?? "Capture richer triples around recently-mentioned entities.";
          const context = meta.query ? `Triggered by query: "${meta.query.slice(0, 120)}"` : "";
          const directive = this.createDirective({
            type: "graph_bridge",
            question: nudge,
            context,
            priority: row.priority,
            sourceEntityIds: meta.truthEntityIds ?? [],
          });
          // Mark the curiosity target resolved only when the signal really
          // was consumed (a directive exists — fresh or dedup-matched).
          // When the active cap blocked creation, keep the target so a
          // later harvest retries instead of silently destroying it.
          if (directive) {
            this.db
              .prepare(`UPDATE curiosity_targets SET resolved_at = ? WHERE id = ?`)
              .run(now, row.id);
            log.debug("graph_bridge → directive", {
              targetId: row.id.slice(0, 8),
              directiveId: directive.id.slice(0, 8),
            });
          }
        } catch (err) {
          log.debug(`graph_bridge harvest skipped: ${String(err)}`);
        }
      }
    } catch (err) {
      log.debug(`harvestGraphBridgeTargets failed: ${String(err)}`);
    }
  }

  private getActiveCount(): number {
    try {
      // Only OPEN questions occupy capacity. Answered rows are transient
      // (they resolve or expire on the next extraction cycle) and expired
      // rows are terminal — counting either would let dead rows saturate
      // maxActiveDirectives and permanently brick directive creation.
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) as c FROM epistemic_directives
             WHERE resolved_at IS NULL AND status = 'open'`,
          )
          .get() as { c: number }
      ).c;
    } catch {
      return 0;
    }
  }

  private findSimilarDirective(question: string): EpistemicDirective | null {
    try {
      // Simple substring match — a semantic comparison could be added later.
      // Scoped to OPEN rows: an expired or answered twin must not starve
      // re-creation of a recurring question.
      const row = this.db
        .prepare(
          `SELECT * FROM epistemic_directives
           WHERE resolved_at IS NULL AND status = 'open' AND question = ?
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
  status: string;
};

type ConflictRow = {
  id: string;
  key: string;
  kind: string;
  current_value: string;
  proposed_value: string;
  current_source: string;
  proposed_source: string;
  created_at: number;
  consumed_at: number | null;
  directive_id: string | null;
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
    status: (row.status as DirectiveStatus) || "open",
  };
}
