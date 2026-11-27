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
 *
 * PLAN-64 Phase 1b adds what follow-up learning needs: sightings (each time
 * a gap was seen is a `stored` event whose detail carries the session, the
 * day and whether the owner's words were an explicit instruction), offers
 * (`offered` events, `offer_count`), the owner's no (`suppress`, a `declined`
 * event), `repeat` events (the owner had to say an active practice again)
 * and the counters over those events.
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
  /** Extra fields for the `stored` event's detail (a follow-up sighting). */
  eventDetail?: Record<string, unknown> | null;
  now?: number;
};

/** One time a follow-up gap was seen for a practice (from its `stored` events). */
export type PracticeSighting = {
  sessionId: string;
  /** The owner's calendar day of the follow-up (`YYYY-M-D`). */
  day: string;
  /** The owner's words were an explicit instruction ("give me X too"). */
  explicit: boolean;
  ts: number;
};

export type PracticeCounts = {
  applied: number;
  repeats: number;
  offers: number;
  confirmed: number;
  declined: number;
};

const ZERO_COUNTS: PracticeCounts = {
  applied: 0,
  repeats: 0,
  offers: 0,
  confirmed: 0,
  declined: 0,
};
const COUNTED_KINDS: Record<string, keyof PracticeCounts> = {
  applied: "applied",
  repeat: "repeats",
  offered: "offers",
  confirmed: "confirmed",
  declined: "declined",
};

/** The calendar day of a timestamp on this machine. */
export function practiceDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

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
          detail: {
            ...input.eventDetail,
            op: "add",
            scope,
            source: input.source,
            status: practice.status,
            origin,
          },
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
        detail: { ...input.eventDetail, op, scope, source: input.source, status: next.status },
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

  // ── PLAN-64 Phase 1b: follow-up learning ────────────────────────────────

  /**
   * A follow-up gap was seen again for an existing candidate: append the
   * evidence and write a `stored` event carrying the sighting. The row's
   * wording, status and tier do not change.
   */
  addSighting(
    id: string,
    opts: { evidenceRef?: string | null; detail?: Record<string, unknown>; now?: number } = {},
  ): Practice | null {
    return inSavepoint(this.db, "practice_sighting", () => {
      const current = this.get(id);
      if (!current) {
        return null;
      }
      const now = opts.now ?? Date.now();
      const evidenceRef = opts.evidenceRef?.trim().slice(0, MAX_EVIDENCE_REF_CHARS) || null;
      const refs = [...current.evidenceRefs];
      if (evidenceRef && !refs.includes(evidenceRef)) {
        refs.push(evidenceRef);
      }
      const evidenceRefs = refs.slice(-MAX_EVIDENCE_REFS);
      this.db
        .prepare(`UPDATE practices SET evidence_refs = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(evidenceRefs), now, id);
      this.writeEvent(id, "stored", {
        sessionRef: evidenceRef,
        detail: { ...opts.detail, op: "strengthen", scope: current.scope, status: current.status },
        ts: now,
      });
      return { ...current, evidenceRefs, updatedAt: now };
    });
  }

  /** The follow-up sightings of a practice, oldest first. */
  sightings(id: string): PracticeSighting[] {
    const out: PracticeSighting[] = [];
    for (const event of this.events(id, 200).toReversed()) {
      const sighting = event.kind === "stored" ? event.detail?.sighting : null;
      if (!sighting || typeof sighting !== "object") {
        continue;
      }
      const s = sighting as { sessionId?: unknown; day?: unknown; explicit?: unknown };
      if (typeof s.sessionId === "string" && typeof s.day === "string") {
        out.push({
          sessionId: s.sessionId,
          day: s.day,
          explicit: s.explicit === true,
          ts: event.ts,
        });
      }
    }
    return out;
  }

  /** The reply carried the offer for this candidate: one `offered` event, `offer_count` + 1. */
  recordOffer(id: string, opts: { sessionId: string; now?: number }): boolean {
    return inSavepoint(this.db, "practice_offer", () => {
      const now = opts.now ?? Date.now();
      const res = this.db
        .prepare(
          `UPDATE practices SET offer_count = offer_count + 1, updated_at = ?
            WHERE id = ? AND status = 'candidate'`,
        )
        .run(now, id);
      if (Number(res.changes) === 0) {
        return false;
      }
      this.writeEvent(id, "offered", { detail: { sessionId: opts.sessionId }, ts: now });
      return true;
    });
  }

  /** Was this practice already offered in this session? */
  offeredInSession(id: string, sessionId: string): boolean {
    return this.events(id, 200).some(
      (e) => e.kind === "offered" && e.detail?.sessionId === sessionId,
    );
  }

  /**
   * The owner said no to the offer: `suppressed`, for good (sticky against
   * every tier below the owner, see upsert), with a `declined` event.
   */
  suppress(id: string, now: number = Date.now()): boolean {
    return inSavepoint(this.db, "practice_suppress", () => {
      const current = this.get(id);
      if (!current || current.status !== "candidate") {
        return false;
      }
      this.db
        .prepare(`UPDATE practices SET status = 'suppressed', updated_at = ? WHERE id = ?`)
        .run(now, id);
      this.writeEvent(id, "declined", { detail: { from: current.status }, ts: now });
      return true;
    });
  }

  /**
   * The owner had to say an active practice again (an explicit correction or
   * a follow-up gap that nearly matches it). A counter, nothing more: no
   * diagnosis and no repair. Never throws.
   */
  recordRepeat(
    id: string,
    opts: { sessionRef?: string | null; via: "correction" | "follow_up"; now?: number },
  ): boolean {
    try {
      const current = this.get(id);
      if (!current || current.status !== "active") {
        return false;
      }
      this.writeEvent(id, "repeat", {
        sessionRef: opts.sessionRef ?? null,
        detail: { via: opts.via },
        ts: opts.now ?? Date.now(),
      });
      return true;
    } catch (err) {
      log.debug(`practice repeat event failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * A task type was merged or renamed: move what was scoped to the old slug.
   * A practice that nearly matches a live one already at the new scope is
   * folded into it (evidence and events move, the duplicate row goes), so
   * the merged type never holds the same instruction twice.
   */
  repointTaskScope(fromSlug: string, intoSlug: string): number {
    const from = normalizeScope(`task:${fromSlug}`);
    const into = normalizeScope(`task:${intoSlug}`);
    if (!from || !into || from === into) {
      return 0;
    }
    return inSavepoint(this.db, "practice_repoint", () => {
      let moved = 0;
      const all = this.allRows();
      const target = all.filter((p) => p.scope === into);
      for (const practice of all.filter((p) => p.scope === from)) {
        const twin = target.find(
          (p) =>
            (p.status === "active" || p.status === "candidate") &&
            arePracticesNearDuplicate(p.statement, practice.statement),
        );
        if (!twin) {
          this.db.prepare(`UPDATE practices SET scope = ? WHERE id = ?`).run(into, practice.id);
          target.push({ ...practice, scope: into });
          moved += 1;
          continue;
        }
        const refs = [...new Set([...twin.evidenceRefs, ...practice.evidenceRefs])].slice(
          -MAX_EVIDENCE_REFS,
        );
        // The live twin keeps its wording; an active duplicate makes it active.
        const promote = practice.status === "active" && twin.status !== "active";
        this.db
          .prepare(
            `UPDATE practices SET evidence_refs = ?, applied_count = applied_count + ?,
               offer_count = MAX(offer_count, ?), status = ?, source = ? WHERE id = ?`,
          )
          .run(
            JSON.stringify(refs),
            practice.appliedCount,
            practice.offerCount,
            promote ? "active" : twin.status,
            promote ? practice.source : twin.source,
            twin.id,
          );
        this.db
          .prepare(`UPDATE practice_events SET practice_id = ? WHERE practice_id = ?`)
          .run(twin.id, practice.id);
        this.db.prepare(`DELETE FROM practices WHERE id = ?`).run(practice.id);
        twin.evidenceRefs = refs;
        if (promote) {
          twin.status = "active";
        }
        moved += 1;
      }
      return moved;
    });
  }

  /**
   * Event counts per practice and overall: prompt inclusions, repeats, offers
   * and the owner's answers to them (`confirmed` counts a yes to an offer,
   * not an un-retire). Counted from `practice_events`, so a
   * practice that was merged away still counts under the one that kept it.
   */
  counters(): { overall: PracticeCounts; byPractice: Map<string, PracticeCounts> } {
    const overall: PracticeCounts = { ...ZERO_COUNTS };
    const byPractice = new Map<string, PracticeCounts>();
    try {
      const rows = this.db
        .prepare(
          `SELECT practice_id, kind, COUNT(*) AS n FROM practice_events
            WHERE kind IN ('applied', 'repeat', 'offered', 'declined')
               OR (kind = 'confirmed' AND detail LIKE '%"via":"offer"%')
            GROUP BY practice_id, kind`,
        )
        .all() as unknown as Array<{ practice_id: string; kind: string; n: number }>;
      for (const row of rows) {
        const field = COUNTED_KINDS[row.kind];
        if (!field) {
          continue;
        }
        const counts = byPractice.get(row.practice_id) ?? { ...ZERO_COUNTS };
        counts[field] += Number(row.n);
        overall[field] += Number(row.n);
        byPractice.set(row.practice_id, counts);
      }
    } catch (err) {
      log.debug(`practice counters unavailable: ${String(err)}`);
    }
    return { overall, byPractice };
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
   * activates a candidate. The result is `active` at the owner tier. `via:
   * "offer"` marks a yes to an offer, which is what the counters count as
   * `confirmed`.
   */
  activate(id: string, now: number = Date.now(), via?: "offer"): boolean {
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
      this.writeEvent(id, "confirmed", {
        detail: { from: current.status, ...(via ? { via } : {}) },
        ts: now,
      });
      return true;
    });
  }
}
