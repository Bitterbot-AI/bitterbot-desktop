/**
 * PLAN-64 Phase 1: standing practices.
 *
 * A practice is a standing instruction about how to do a kind of task ("For
 * repo stats, give the numbers first and include npm downloads"), as opposed
 * to a key/value fact. It is a sentence with a scope, a status, the source
 * tier that wrote it, the owner's evidence line(s) and counters.
 *
 * Scope: `global`, `project:<name>`, `person:<name>`, `task:<slug>` (a
 * recurring kind of request, see task-types.ts) or `job:<cronJobId>`,
 * validated by the same normaliser facts use (canonical-facts.normalizeScope).
 * A scope that does not validate is a rejected write.
 *
 * Status: only `active` practices are ever rendered into a prompt.
 * `candidate` is something a tier below the owner proposed; `retired` is the
 * owner's decision; `suppressed` is the owner's "no" to an offer (written by
 * a later phase, honoured here). Owner stickiness: a write below the owner
 * tier whose statement nearly matches a retired or suppressed practice, at
 * any scope, is rejected. The owner saying it again brings it back.
 *
 * Near-duplicates: two statements whose content words mostly coincide
 * (Jaccard >= NEAR_DUPLICATE_JACCARD) are the same practice. A write that
 * nearly matches a live practice at the same scope strengthens that row
 * (evidence appended, tier raised when the writer outranks it) instead of
 * inserting a second.
 *
 * `applied` means "included in the prompt of a run", nothing more: nobody
 * checks here whether the answer followed the practice.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CANONICAL_SCOPE_GLOBAL,
  type CanonicalSource,
  canonicalSourceTier,
  isScopeVisibleInContext,
  normalizeScope,
  OWNER_TRUST_TIER,
  type ScopeContext,
} from "./canonical-facts.js";
import { inSavepoint, normalizeLoose } from "./memory-suppressions.js";
import { looksLikeSecretValue, redactSecretShapes } from "./secret-shape.js";
import { contentWords } from "./task-types.js";

const log = createSubsystemLogger("memory/practices");

export const PRACTICE_STATUSES = ["candidate", "active", "retired", "suppressed"] as const;
export type PracticeStatus = (typeof PRACTICE_STATUSES)[number];

export const PRACTICE_ORIGINS = ["explicit", "follow_up", "backfill", "owner_ui"] as const;
export type PracticeOrigin = (typeof PRACTICE_ORIGINS)[number];

export const PRACTICE_EVENT_KINDS = [
  "stored",
  "applied",
  "repeat",
  "offered",
  "confirmed",
  "declined",
  "widened",
  "narrowed",
  "edited",
  "retired",
] as const;
export type PracticeEventKind = (typeof PRACTICE_EVENT_KINDS)[number];

export const MIN_STATEMENT_CHARS = 8;
export const MAX_STATEMENT_CHARS = 300;
export const NEAR_DUPLICATE_JACCARD = 0.8;
const MAX_EVIDENCE_REFS = 5;
const MAX_EVIDENCE_REF_CHARS = 300;
const MAX_TRACKED_APPLY_KEYS = 500;

export type Practice = {
  id: string;
  statement: string;
  scope: string;
  status: PracticeStatus;
  /** The canonical source vocabulary (`owner`, `extraction`, ...). */
  source: CanonicalSource;
  /** Session line refs (`session:<file>#L<n>`), oldest first. */
  evidenceRefs: string[];
  createdAt: number;
  updatedAt: number;
  /** Runs whose prompt included this practice. */
  appliedCount: number;
  lastAppliedAt: number | null;
  offerCount: number;
  origin: PracticeOrigin;
};

export type PracticeEvent = {
  id: string;
  practiceId: string;
  kind: PracticeEventKind;
  sessionRef: string | null;
  detail: Record<string, unknown> | null;
  ts: number;
};

type Row = {
  id: string;
  statement: string;
  statement_hash: string;
  scope: string;
  status: string;
  source: string;
  evidence_refs: string;
  created_at: number;
  updated_at: number;
  applied_count: number;
  last_applied_at: number | null;
  offer_count: number;
  origin: string;
};

const COLUMNS =
  "id, statement, statement_hash, scope, status, source, evidence_refs, created_at, updated_at, " +
  "applied_count, last_applied_at, offer_count, origin";

function parseRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

const rowToPractice = (row: Row): Practice => ({
  id: row.id,
  statement: row.statement,
  scope: normalizeScope(row.scope) ?? CANONICAL_SCOPE_GLOBAL,
  status: (PRACTICE_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as PracticeStatus)
    : "candidate",
  source: row.source as CanonicalSource,
  evidenceRefs: parseRefs(row.evidence_refs),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  appliedCount: row.applied_count,
  lastAppliedAt: row.last_applied_at ?? null,
  offerCount: row.offer_count,
  origin: (PRACTICE_ORIGINS as readonly string[]).includes(row.origin)
    ? (row.origin as PracticeOrigin)
    : "explicit",
});

/** Hash of a statement after loose normalisation (case, punctuation and spacing ignored). */
export function practiceStatementHash(statement: string): string {
  return crypto.createHash("sha256").update(normalizeLoose(statement)).digest("hex");
}

/** One line, whitespace collapsed, trimmed. */
export function cleanPracticeStatement(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Why a statement cannot be stored, or null. Never includes the statement. */
export function practiceStatementRejection(statement: string): string | null {
  if (statement.length < MIN_STATEMENT_CHARS) {
    return "the practice is too short to be an instruction";
  }
  if (statement.length > MAX_STATEMENT_CHARS) {
    return `a practice is one short instruction (at most ${MAX_STATEMENT_CHARS} characters)`;
  }
  if (contentWords(statement).length < 2) {
    return "the practice does not say what to do";
  }
  // Credentials never land, whoever wrote them: the whole statement, each
  // token of it, and anything the export's redactor would mask.
  if (
    looksLikeSecretValue(statement) ||
    statement.split(/\s+/).some((token) => looksLikeSecretValue(token)) ||
    redactSecretShapes(statement).redactions > 0
  ) {
    return "the practice contains credential-shaped text; secrets are never stored";
  }
  return null;
}

/** Are these two statements the same instruction, near enough? */
export function arePracticesNearDuplicate(a: string, b: string): boolean {
  if (normalizeLoose(a) === normalizeLoose(b)) {
    return true;
  }
  const wa = new Set(contentWords(a));
  const wb = new Set(contentWords(b));
  if (wa.size === 0 || wb.size === 0) {
    return false;
  }
  let shared = 0;
  for (const word of wa) {
    if (wb.has(word)) {
      shared += 1;
    }
  }
  return shared / (wa.size + wb.size - shared) >= NEAR_DUPLICATE_JACCARD;
}

const SCOPE_RANK: Record<string, number> = { job: 0, task: 1, project: 2, person: 3, global: 4 };

/** 0 (most specific: job) to 4 (global). Unknown scopes sort last. */
export function practiceScopeRank(scope: string): number {
  const kind = scope === CANONICAL_SCOPE_GLOBAL ? "global" : scope.slice(0, scope.indexOf(":"));
  return SCOPE_RANK[kind] ?? 5;
}

export type PracticeUpsertInput = {
  statement: string;
  /** Default `global`. Must validate (normalizeScope) or the write is rejected. */
  scope?: string;
  source: CanonicalSource;
  origin?: PracticeOrigin;
  evidenceRef?: string | null;
  now?: number;
};

export type PracticeUpsertResult =
  | {
      ok: true;
      /**
       * `add`: a new row. `strengthen`: an existing row at this scope gained
       * evidence. `promote`: an existing row was raised to the writer's tier
       * (a candidate the owner then stated, or a retired practice the owner
       * stated again).
       */
      op: "add" | "strengthen" | "promote";
      practice: Practice;
    }
  | { ok: false; reason: string };

export type PracticeListOptions = {
  /** Default: every status. */
  statuses?: PracticeStatus[];
  scope?: string;
};

export class PracticesStore {
  /** Turn keys whose rendering was already counted (a retried attempt counts once). */
  private readonly appliedTurnKeys = new Set<string>();

  constructor(private readonly db: DatabaseSync) {}

  get(id: string): Practice | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM practices WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? rowToPractice(row) : null;
  }

  /** Practices, most specific scope first, then most recently updated. */
  list(opts: PracticeListOptions = {}): Practice[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM practices ORDER BY updated_at DESC, id ASC`)
      .all() as unknown as Row[];
    const statuses = opts.statuses ? new Set<string>(opts.statuses) : null;
    const scope = opts.scope ? normalizeScope(opts.scope) : null;
    return rows
      .map(rowToPractice)
      .filter((p) => (!statuses || statuses.has(p.status)) && (!scope || p.scope === scope))
      .toSorted((a, b) => practiceScopeRank(a.scope) - practiceScopeRank(b.scope));
  }

  /**
   * The active practices that apply to a turn, most specific scope first
   * (job, task, project, person, global), newest first within a scope.
   * `kinds` narrows the scopes considered (a cron job's own session renders
   * its `job:` practices only).
   */
  listVisible(ctx: ScopeContext, opts: { kinds?: ReadonlySet<string> } = {}): Practice[] {
    return this.list({ statuses: ["active"] }).filter((p) => {
      if (opts.kinds) {
        const kind =
          p.scope === CANONICAL_SCOPE_GLOBAL ? "global" : p.scope.slice(0, p.scope.indexOf(":"));
        if (!opts.kinds.has(kind)) {
          return false;
        }
      }
      return isScopeVisibleInContext(p.scope, ctx);
    });
  }

  events(practiceId: string, limit = 100): PracticeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, practice_id, kind, session_ref, detail, ts FROM practice_events
          WHERE practice_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`,
      )
      .all(practiceId, Math.min(Math.max(limit, 1), 1000)) as unknown as Array<{
      id: string;
      practice_id: string;
      kind: string;
      session_ref: string | null;
      detail: string | null;
      ts: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      practiceId: r.practice_id,
      kind: r.kind as PracticeEventKind,
      sessionRef: r.session_ref,
      detail: (() => {
        try {
          return r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      })(),
      ts: r.ts,
    }));
  }

  private writeEvent(
    practiceId: string,
    kind: PracticeEventKind,
    opts: { sessionRef?: string | null; detail?: Record<string, unknown> | null; ts?: number } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO practice_events (id, practice_id, kind, session_ref, detail, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        practiceId,
        kind,
        opts.sessionRef ?? null,
        opts.detail ? JSON.stringify(opts.detail) : null,
        opts.ts ?? Date.now(),
      );
  }

  private allRows(): Practice[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM practices`).all() as unknown as Row[]).map(
      rowToPractice,
    );
  }

  /**
   * Store a practice. Owner tier writes `active`; every tier below writes
   * `candidate` (never rendered). See the module header for stickiness and
   * near-duplicate handling. Row and event commit together.
   */
  upsert(input: PracticeUpsertInput): PracticeUpsertResult {
    const statement = cleanPracticeStatement(input.statement ?? "");
    const rejection = practiceStatementRejection(statement);
    if (rejection) {
      return { ok: false, reason: rejection };
    }
    const scope = normalizeScope(input.scope);
    if (!scope) {
      return {
        ok: false,
        reason:
          "scope must be global, project:<name>, person:<name>, task:<slug> or job:<cronJobId>",
      };
    }
    const tier = canonicalSourceTier(input.source);
    const isOwner = tier >= OWNER_TRUST_TIER;
    const now = input.now ?? Date.now();
    const evidenceRef = input.evidenceRef?.trim().slice(0, MAX_EVIDENCE_REF_CHARS) || null;
    const origin = input.origin ?? "explicit";

    return inSavepoint(this.db, "practice_upsert", (): PracticeUpsertResult => {
      const similar = this.allRows().filter((p) =>
        arePracticesNearDuplicate(p.statement, statement),
      );
      // The owner's standing "no" holds at every scope for the tiers below.
      const refused = similar.find((p) => p.status === "retired" || p.status === "suppressed");
      if (refused && !isOwner) {
        log.info(`practice REJECT (owner ${refused.status}): ${input.source} write, ${refused.id}`);
        return {
          ok: false,
          reason:
            refused.status === "retired"
              ? "the owner retired this practice; only the owner can bring it back"
              : "the owner declined this practice; only the owner can bring it back",
        };
      }
      const sameScope = similar.filter((p) => p.scope === scope);
      const existing =
        sameScope.find((p) => p.status === "active") ??
        sameScope.find((p) => p.status === "candidate") ??
        sameScope[0];
      if (!existing) {
        const practice: Practice = {
          id: crypto.randomUUID(),
          statement,
          scope,
          status: isOwner ? "active" : "candidate",
          source: input.source,
          evidenceRefs: evidenceRef ? [evidenceRef] : [],
          createdAt: now,
          updatedAt: now,
          appliedCount: 0,
          lastAppliedAt: null,
          offerCount: 0,
          origin,
        };
        this.db
          .prepare(
            `INSERT INTO practices (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?)`,
          )
          .run(
            practice.id,
            statement,
            practiceStatementHash(statement),
            scope,
            practice.status,
            practice.source,
            JSON.stringify(practice.evidenceRefs),
            now,
            now,
            origin,
          );
        this.writeEvent(practice.id, "stored", {
          sessionRef: evidenceRef,
          detail: { op: "add", scope, source: input.source, status: practice.status, origin },
          ts: now,
        });
        return { ok: true, op: "add", practice };
      }

      const refs = [...existing.evidenceRefs];
      if (evidenceRef && !refs.includes(evidenceRef)) {
        refs.push(evidenceRef);
      }
      const evidenceRefs = refs.slice(-MAX_EVIDENCE_REFS);
      // The owner raises a candidate (or their own retired/declined practice)
      // to active in their words. A lower tier never rewrites or revives.
      const raise =
        isOwner && (existing.status !== "active" || canonicalSourceTier(existing.source) < tier);
      const next: Practice = raise
        ? { ...existing, statement, status: "active", source: input.source, evidenceRefs }
        : { ...existing, evidenceRefs };
      next.updatedAt = now;
      this.db
        .prepare(
          `UPDATE practices SET statement = ?, statement_hash = ?, status = ?, source = ?,
             evidence_refs = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.statement,
          practiceStatementHash(next.statement),
          next.status,
          next.source,
          JSON.stringify(evidenceRefs),
          now,
          existing.id,
        );
      const op = raise ? "promote" : "strengthen";
      this.writeEvent(existing.id, "stored", {
        sessionRef: evidenceRef,
        detail: { op, scope, source: input.source, status: next.status },
        ts: now,
      });
      return { ok: true, op, practice: next };
    });
  }

  /**
   * Prompt inclusion: bump `applied_count` and write an `applied` event for
   * each practice a run's prompt carried. `turnKey` (the run id) makes a
   * retried attempt of the same run count once. Never throws.
   */
  recordApplied(
    ids: string[],
    opts: { turnKey?: string; sessionRef?: string | null; now?: number } = {},
  ): number {
    if (ids.length === 0) {
      return 0;
    }
    if (opts.turnKey) {
      if (this.appliedTurnKeys.has(opts.turnKey)) {
        return 0;
      }
      this.appliedTurnKeys.add(opts.turnKey);
      if (this.appliedTurnKeys.size > MAX_TRACKED_APPLY_KEYS) {
        const first = this.appliedTurnKeys.values().next().value;
        if (first !== undefined) {
          this.appliedTurnKeys.delete(first);
        }
      }
    }
    const now = opts.now ?? Date.now();
    try {
      return inSavepoint(this.db, "practice_applied", () => {
        let n = 0;
        for (const id of ids) {
          const res = this.db
            .prepare(
              `UPDATE practices SET applied_count = applied_count + 1, last_applied_at = ?
                WHERE id = ? AND status = 'active'`,
            )
            .run(now, id);
          if (Number(res.changes) > 0) {
            this.writeEvent(id, "applied", {
              sessionRef: opts.sessionRef ?? null,
              detail: { via: "prompt" },
              ts: now,
            });
            n += 1;
          }
        }
        return n;
      });
    } catch (err) {
      log.debug(`practice applied-count write failed: ${String(err)}`);
      return 0;
    }
  }

  // ── Owner actions (owner-controls.ts wraps these with the audit log) ──────

  /** Replace a practice's wording. The owner's words: the row becomes owner tier. */
  editStatement(id: string, raw: string, now: number = Date.now()): PracticeUpsertResult {
    const statement = cleanPracticeStatement(raw ?? "");
    const rejection = practiceStatementRejection(statement);
    if (rejection) {
      return { ok: false, reason: rejection };
    }
    return inSavepoint(this.db, "practice_edit", (): PracticeUpsertResult => {
      const current = this.get(id);
      if (!current) {
        return { ok: false, reason: "no practice with that id" };
      }
      const clash = this.allRows().find(
        (p) =>
          p.id !== id &&
          p.scope === current.scope &&
          (p.status === "active" || p.status === "candidate") &&
          arePracticesNearDuplicate(p.statement, statement),
      );
      if (clash) {
        return { ok: false, reason: "another practice at this scope already says that" };
      }
      this.db
        .prepare(
          `UPDATE practices SET statement = ?, statement_hash = ?, source = 'owner', updated_at = ?
            WHERE id = ?`,
        )
        .run(statement, practiceStatementHash(statement), now, id);
      this.writeEvent(id, "edited", { detail: { from: current.statement }, ts: now });
      return {
        ok: true,
        op: "strengthen",
        practice: { ...current, statement, source: "owner", updatedAt: now },
      };
    });
  }

  /**
   * Change where a practice applies. Logged as `widened` (towards global) or
   * `narrowed` (towards a job). An owner action: a candidate stays a
   * candidate until the owner activates it.
   */
  setScope(id: string, rawScope: string, now: number = Date.now()): PracticeUpsertResult {
    const scope = normalizeScope(rawScope);
    if (!scope || !rawScope?.trim()) {
      return {
        ok: false,
        reason:
          "scope must be global, project:<name>, person:<name>, task:<slug> or job:<cronJobId>",
      };
    }
    return inSavepoint(this.db, "practice_scope", (): PracticeUpsertResult => {
      const current = this.get(id);
      if (!current) {
        return { ok: false, reason: "no practice with that id" };
      }
      if (current.scope === scope) {
        return { ok: true, op: "strengthen", practice: current };
      }
      const clash = this.allRows().find(
        (p) =>
          p.id !== id &&
          p.scope === scope &&
          (p.status === "active" || p.status === "candidate") &&
          arePracticesNearDuplicate(p.statement, current.statement),
      );
      if (clash) {
        return { ok: false, reason: "a practice with that scope already says this" };
      }
      this.db
        .prepare(`UPDATE practices SET scope = ?, updated_at = ? WHERE id = ?`)
        .run(scope, now, id);
      const widened = practiceScopeRank(scope) >= practiceScopeRank(current.scope);
      this.writeEvent(id, widened ? "widened" : "narrowed", {
        detail: { from: current.scope, to: scope },
        ts: now,
      });
      return { ok: true, op: "strengthen", practice: { ...current, scope, updatedAt: now } };
    });
  }

  /** The owner retires a practice: sticky against every tier below (see upsert). */
  retire(id: string, now: number = Date.now()): boolean {
    return inSavepoint(this.db, "practice_retire", () => {
      const current = this.get(id);
      if (!current || current.status === "retired") {
        return false;
      }
      this.db
        .prepare(`UPDATE practices SET status = 'retired', updated_at = ? WHERE id = ?`)
        .run(now, id);
      this.writeEvent(id, "retired", { detail: { from: current.status }, ts: now });
      return true;
    });
  }

  /**
   * The owner brings a practice back (from `retired` or `suppressed`), or
   * activates a candidate. The result is `active` at the owner tier.
   */
  activate(id: string, now: number = Date.now()): boolean {
    return inSavepoint(this.db, "practice_activate", () => {
      const current = this.get(id);
      if (!current || current.status === "active") {
        return false;
      }
      this.db
        .prepare(
          `UPDATE practices SET status = 'active', source = 'owner', updated_at = ? WHERE id = ?`,
        )
        .run(now, id);
      this.writeEvent(id, "confirmed", { detail: { from: current.status }, ts: now });
      return true;
    });
  }
}
