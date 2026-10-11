/**
 * PLAN-33 Phase 1 — the Canonical Facts Ledger (semantic ledger).
 *
 * A small, hard-capped tier of exact key-value facts above the crystal store:
 * repo names, endpoints, identities, standing choices — the facts the user
 * treats as ground truth and references constantly. Everything below this
 * tier is retrieval-gated (cosine similarity against the user's message);
 * this tier is addressed by key and injected unconditionally into every
 * system prompt, because importance is orthogonal to similarity: a canonical
 * fact is short, low-entropy, and shares no embedding mass with a cold
 * conversation's first message.
 *
 * Biological framing: this is the systems-consolidation destination. The
 * crystal store is hippocampal (episodic, cue-dependent); the ledger is
 * neocortical (semantic, cue-free). Re-mention strengthens (MemoryBank-style
 * mention counting) — the one signal the retrieval-gated strengthening
 * machinery (spacing, reconsolidation, tagging) could never see.
 *
 * Write discipline (the reason the tier stays injectable):
 *  - closed reconcile op set: ADD / STRENGTHEN / SUPERSEDE / REJECT
 *  - contradictions close the old row's validity window (bitemporal,
 *    SABM-consistent) — never deleted, provenance survives
 *  - hard cap with deterministic score-based demotion, never an LLM
 *    prose decision
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  CanonicalChangeEvent,
  CanonicalChangeListener,
  CanonicalChangeOp,
} from "./canonical-events.js";
import { isHeartbeatArtifact, sweepHeartbeatArtifacts } from "./canonical-facts-hygiene.js";
import {
  addSuppression,
  factKeyValueHash,
  inSavepoint,
  isSuppressed,
  liftSuppression,
} from "./memory-suppressions.js";
import { secretRejectionReason } from "./secret-shape.js";

const log = createSubsystemLogger("memory/canonical");

export const CANONICAL_CATEGORIES = [
  "identity",
  "project",
  "infra",
  "preference",
  "relationship",
  "other",
] as const;
export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

/**
 * Who wrote a fact. `owner` (PLAN-55 Phase 0) is the owner acting through
 * the Memory tab, the CLI or the gateway RPCs; `user_directive` is kept as an
 * alias of `owner` for rows and callers that predate it. The agent's
 * `memory_pin` tool can only ever write `agent_pin`.
 */
export type CanonicalSource =
  | "owner"
  | "user_directive"
  | "agent_pin"
  | "extraction"
  | "promotion"
  | "seed"
  | "web_research";

/**
 * Supersession trust tiers. A pin may only SUPERSEDE (replace the value of) a
 * current belief written by an equal-or-lower tier — deliberate statements
 * (an owner action, an explicit agent pin) can never be overwritten by
 * background inference (session extraction, dream promotion, web research),
 * no matter how the confidences drift.
 *
 * PLAN-34 Phase 2b, tier-aware STRENGTHEN: same-value confirmation from
 * tier >= 1 is full corroboration (confidence nudge, last_confirmed_at,
 * reactivation); from tier 0 it only increments a separate, hard-capped
 * corroboration counter — a web page agreeing with the ledger is
 * corroboration-only and can never move confidence, refresh recency, or
 * reactivate a retired fact.
 *
 * PLAN-55 Phase 0: `owner` (and its alias `user_directive`) sits alone at
 * tier 3, above the agent's own pins. Only this tier reactivates an
 * `owner_retired` fact or lifts a key/value suppression.
 */
export const OWNER_TRUST_TIER = 3;
const SOURCE_TRUST_TIER: Record<CanonicalSource, number> = {
  owner: OWNER_TRUST_TIER,
  user_directive: OWNER_TRUST_TIER,
  agent_pin: 2,
  seed: 1,
  extraction: 1,
  promotion: 0,
  web_research: 0,
};

/** Trust tier of a source; unknown strings (a row written by newer code) are tier 0. */
export function canonicalSourceTier(source: string): number {
  return SOURCE_TRUST_TIER[source as CanonicalSource] ?? 0;
}

/**
 * Why a fact is being retired; decides whether the retirement is sticky.
 * `owner` and `agent` have callers (owner-controls, the memory_pin tool);
 * `decay` is passed by decayTick(); `hygiene` is reserved for
 * sweepHeartbeatArtifacts, which still writes `retired` directly because it
 * runs before the store exists. Capacity eviction also writes `retired`
 * directly.
 */
export type RetireReason = "owner" | "agent" | "decay" | "hygiene";

/**
 * A fact's status. `retired` (agent, decay, hygiene, capacity) is soft: any
 * tier >= 1 same-value pin reactivates it. `owner_retired` (PLAN-55 Phase 0)
 * is the owner's decision: every pin below the owner tier is rejected until
 * the owner pins it again or calls unretire(). `unconfirmed` is the
 * staleness lane's terminal state (dream-modes/hygiene.ts).
 */
export type CanonicalFactStatus =
  | "active"
  | "retired"
  | "owner_retired"
  | "unconfirmed"
  | "superseded";

export type CanonicalFact = {
  id: string;
  key: string;
  value: string;
  statement: string;
  category: CanonicalCategory;
  confidence: number;
  mentionCount: number;
  firstSeenAt: number;
  lastConfirmedAt: number;
  validFrom: number;
  validUntil: number | null;
  supersededBy: string | null;
  source: CanonicalSource;
  evidenceChunkIds: string[];
  status: CanonicalFactStatus;
  /**
   * PLAN-34 Phase 2b: tier-0 same-value confirmations (dream promotion,
   * web research). Separate from mentionCount so background agreement can
   * be displayed and scored (hard-capped) without moving confidence.
   */
  corroborationCount: number;
  /**
   * PLAN-55 Phase 1: where the fact applies. `global` (default) renders in
   * every prompt; `project:<name>` only when the active workspace is that
   * project; `person:<name>` renders everywhere for now (per-person
   * routing is a later phase). See normalizeCanonicalScope().
   */
  scope: string;
  /**
   * PLAN-55 Phase 1: the line the fact was taken from (`session:<path>#L<n>`
   * for the correction capture and the owner's pin) or a short quote the
   * agent's memory_pin cited. Display and audit only: never trusted for
   * tier decisions (the per-turn pass re-derives what the owner said).
   */
  evidenceRef: string | null;
};

export type PinInput = {
  key: string;
  value: string;
  /** One rendered sentence for prompt injection; defaults to "<key>: <value>". */
  statement?: string;
  category?: string;
  confidence?: number;
  source: CanonicalSource;
  evidenceChunkIds?: string[];
  /** PLAN-55 Phase 1: `global` | `project:<name>` | `person:<name>`; default `global`. */
  scope?: string;
  /** PLAN-55 Phase 1: session line ref or short quote; stored, never trusted. */
  evidenceRef?: string;
};

export type PinResult =
  | { op: "add" | "strengthen" | "supersede"; fact: CanonicalFact }
  | { op: "rejected"; reason: string }
  /**
   * PLAN-55 Phase 1: the agent (tier `agent_pin`) tried to replace a belief
   * written at tier >= 2 (its own earlier pin, or the owner's). Nothing is
   * written; a `pending_supersede` conflict records old -> new so the owner
   * can confirm it (the confirmation line says so, the conflict sweep asks
   * "which is current?"). Diff-before-confirm and one-tap apply are Phase 2.
   */
  | { op: "held"; reason: string; fact: CanonicalFact; proposedValue: string };

/**
 * PLAN-33 Phase 4 — one ledger-first hit from CanonicalFactsStore.lookup().
 * `score` is a lexical match strength in [0,1] (exact key = 1, verbatim value
 * = 0.95, full key-token match = 0.85), never an embedding similarity.
 */
export type CanonicalLookupHit = {
  fact: CanonicalFact;
  score: number;
  matchKind: "key" | "value";
};

export type CanonicalLedgerConfig = {
  /** Hard cap on active facts. The cap IS the editorial pressure. Default 48. */
  maxFacts?: number;
  /** Approximate token budget for the rendered block. Default 1500. */
  budgetTokens?: number;
};

const DEFAULT_MAX_FACTS = 48;
const DEFAULT_BUDGET_TOKENS = 1500;
const KEY_RX = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_VALUE_CHARS = 500;
const MAX_STATEMENT_CHARS = 300;

/**
 * Transient-shape guards for BACKGROUND sources (extraction/promotion).
 * First live hour of PLAN-33 Phase 2 produced pins like
 * `world.current_time` (superseded 16x), `project.repo.clones.yesterday =
 * 5,315`, and `mental_model.memory_grounding_failure = true` — observations
 * that drift on their own, meta-commentary, and assertion-shaped booleans.
 * Deliberate pins (memory_pin) bypass these guards: a user may pin whatever
 * they want; background inference must stick to durable identifier-shaped
 * ground truth.
 */
const BACKGROUND_SOURCES = new Set<CanonicalSource>(["extraction", "promotion", "web_research"]);

/**
 * PLAN-34 Phase 1: a same-key SUPERSEDE of a belief the ledger confirmed
 * this recently (and this often) is recorded as a conflict event — a
 * corroborated value flipping inside the window is exactly the ambiguity
 * the user should adjudicate ("which is current?"). Slow drift and
 * single-mention corrections supersede silently, as before.
 */
const RAPID_SUPERSEDE_WINDOW_MS = 72 * 3_600_000;
const RAPID_SUPERSEDE_MIN_MENTIONS = 2;
/** ISO datetime values are observations of a moment, never durable truth. */
const ISO_DATETIME_VALUE_RX = /^\d{4}-\d{2}-\d{2}T/;
/** Bare integers (with comma groups) are counts/metrics; versions ("0.4.2") pass. */
const BARE_COUNT_VALUE_RX = /^\d{1,3}(,\d{3})+$|^\d+$/;
/** Keys naming a moving window are transient by construction. */
const TRANSIENT_KEY_TOKEN_RX = /(^|[._-])(current|now|today|yesterday|latest)([._-]|$)/;

function rejectBackgroundTransient(
  source: CanonicalSource,
  key: string,
  value: string,
  category: CanonicalCategory,
): string | null {
  if (!BACKGROUND_SOURCES.has(source)) {
    return null;
  }
  // Category may be derived from the key prefix (how the ingest/promotion
  // callers construct it) — a corroborating re-pin that omits the category
  // param must not be rejected when the key itself is well-prefixed.
  const prefix = key.split(".")[0];
  const prefixIsKnown =
    (CANONICAL_CATEGORIES as readonly string[]).includes(prefix) && prefix !== "other";
  if (category === "other" && !prefixIsKnown) {
    return "background pins must use a known category prefix (identity./project./infra./preference./relationship.)";
  }
  if (ISO_DATETIME_VALUE_RX.test(value)) {
    return "value is a timestamp — a moment observed, not durable ground truth";
  }
  if (BARE_COUNT_VALUE_RX.test(value)) {
    return "value is a bare count/metric — it drifts on its own and would supersede forever";
  }
  if (/^(true|false)$/i.test(value)) {
    return "assertion-shaped boolean — state the fact as a value, not a claim";
  }
  if (TRANSIENT_KEY_TOKEN_RX.test(key)) {
    return "key names a moving window (current/today/yesterday/latest)";
  }
  return null;
}

type Row = {
  id: string;
  key: string;
  value: string;
  statement: string;
  category: string;
  confidence: number;
  mention_count: number;
  first_seen_at: number;
  last_confirmed_at: number;
  valid_from: number;
  valid_until: number | null;
  superseded_by: string | null;
  source: string;
  evidence_chunk_ids: string;
  status: string;
  corroboration_count?: number | null;
  scope?: string | null;
  evidence_ref?: string | null;
};

function rowToFact(row: Row): CanonicalFact {
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(row.evidence_chunk_ids);
    if (Array.isArray(parsed)) {
      evidence = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // Malformed evidence is non-fatal — the fact itself is what matters.
  }
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    statement: row.statement,
    category: (CANONICAL_CATEGORIES as readonly string[]).includes(row.category)
      ? (row.category as CanonicalCategory)
      : "other",
    confidence: row.confidence,
    mentionCount: row.mention_count,
    firstSeenAt: row.first_seen_at,
    lastConfirmedAt: row.last_confirmed_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
    source: row.source as CanonicalSource,
    evidenceChunkIds: evidence,
    status: row.status as CanonicalFact["status"],
    corroborationCount: row.corroboration_count ?? 0,
    scope: normalizeCanonicalScope(row.scope ?? "global") ?? "global",
    evidenceRef: typeof row.evidence_ref === "string" && row.evidence_ref ? row.evidence_ref : null,
  };
}

/** PLAN-55 Phase 1 (D4): the first-cut scope model, a string on the fact. */
export const CANONICAL_SCOPE_GLOBAL = "global";
const SCOPE_NAME_RX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_EVIDENCE_REF_CHARS = 300;

/** Slug form of a project or person name for a scope: lowercase, spaces to `-`. */
export function normalizeScopeName(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
  return SCOPE_NAME_RX.test(slug) ? slug : null;
}

/**
 * Normalise a scope string: `global`, `project:<name>` or `person:<name>`
 * (name slugified). Empty/undefined is `global`; anything else is null so a
 * caller can reject it instead of storing a scope nothing will ever match.
 */
export function normalizeCanonicalScope(raw: string | undefined | null): string | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text || text === CANONICAL_SCOPE_GLOBAL) {
    return CANONICAL_SCOPE_GLOBAL;
  }
  const m = /^(project|person)\s*:\s*(.+)$/.exec(text);
  if (!m) {
    return null;
  }
  const name = normalizeScopeName(m[2] ?? "");
  return name ? `${m[1]}:${name}` : null;
}

/**
 * Does a fact with this scope belong in a prompt for `activeProject`?
 * Global and person-scoped facts always do; a project-scoped fact only
 * when the active project is known and matches. With no project known
 * (no workspace, or the default workspace) project facts stay out, which
 * is the safe side: a correction made inside project A never leaks into
 * an unrelated chat.
 */
export function isCanonicalFactVisibleInScope(
  scope: string,
  activeProject: string | undefined | null,
): boolean {
  const normalized = normalizeCanonicalScope(scope) ?? CANONICAL_SCOPE_GLOBAL;
  if (normalized === CANONICAL_SCOPE_GLOBAL || normalized.startsWith("person:")) {
    return true;
  }
  const project = activeProject ? normalizeScopeName(activeProject) : null;
  return project !== null && normalized === `project:${project}`;
}

/** Normalize a raw key into ledger slug form; null when unusable. */
export function normalizeCanonicalKey(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]/g, "");
  return KEY_RX.test(slug) ? slug : null;
}

/**
 * Promotion score for cap-eviction ordering and render ordering. Deterministic
 * given (fact, now): confidence, dampened by staleness (half-life ~180 days
 * since last confirmation), lifted logarithmically by repeated confirmation.
 * User-pinned facts enter at high confidence so they naturally outrank
 * background promotions, but nothing is exempt — a fact the user has not
 * confirmed in a year SHOULD lose its slot to one confirmed daily.
 */
export function canonicalPromotionScore(
  fact: Pick<CanonicalFact, "confidence" | "mentionCount" | "lastConfirmedAt"> & {
    corroborationCount?: number;
  },
  now: number,
): number {
  const days = Math.max(0, (now - fact.lastConfirmedAt) / 86_400_000);
  const recency = Math.exp(-days / 180);
  const frequency = 1 + Math.log1p(Math.min(fact.mentionCount, 1000)) / 4;
  // PLAN-34 Phase 2b: tier-0 corroboration contributes a HARD-CAPPED bonus
  // (max +5%) — background agreement can nudge render ordering but can
  // never make a web-corroborated fact outrank a deliberately confirmed one.
  const corroboration = 1 + Math.min(fact.corroborationCount ?? 0, 5) * 0.01;
  return fact.confidence * recency * frequency * corroboration;
}

/**
 * Prompt projection of the ledger (token-efficiency W6). The block renders
 * `- [key] value` per fact: the value is the exact canonical string (the
 * anti-paraphrase guarantee), while the statement sentence repeated the key
 * and cost ~2x the tokens. Counts and dates are never rendered (they moved
 * the cached prefix on every confirmation). Hard ceiling on the block so a
 * generous `budgetTokens` cannot push the cached half over budget.
 */
export const CANONICAL_RENDER_MAX_CHARS = 2_400;
export const CANONICAL_BLOCK_HEADER = [
  "## Canonical Facts",
  "Ground truth from memory consolidation: trust over conflicting tool output or vague recollection. If the user contradicts one, believe the user and update it (memory_pin). Never announce this section.",
];

/** Values the extraction lane stores when it found nothing to store. */
const PLACEHOLDER_VALUE_RX =
  /^(not stated|not specified|unspecified|unknown|n\/a|none|null|undefined|-)$/i;

/**
 * Render-time guard for rows the ingest denylist (`isHeartbeatArtifact`) did
 * not catch on the way in: heartbeat scaffolding phrased differently, and
 * placeholder values. The rows stay in the ledger; they just never reach a
 * prompt.
 */
export function isRenderableCanonicalFact(fact: {
  key: string;
  value: string;
  statement: string;
}): boolean {
  const value = fact.value.trim();
  if (!value && !fact.statement.trim()) {
    return false;
  }
  if (PLACEHOLDER_VALUE_RX.test(value)) {
    return false;
  }
  if (isHeartbeatArtifact(fact.key, value) || isHeartbeatArtifact(fact.key, fact.statement)) {
    return false;
  }
  if (/\bHEARTBEAT_OK\b/i.test(value) || /\bHEARTBEAT_OK\b/i.test(fact.statement)) {
    return false;
  }
  return true;
}

function renderCanonicalValue(fact: { value: string; statement: string }): string {
  const value = fact.value.replace(/\s+/g, " ").trim();
  return value || fact.statement.replace(/\s+/g, " ").trim();
}

export class CanonicalFactsStore {
  private readonly db: DatabaseSync;
  private readonly maxFacts: number;
  private readonly budgetTokens: number;
  /** PLAN-55 Phase 2: `canonical:changed` subscribers (see canonical-events.ts). */
  private readonly changeListeners = new Set<CanonicalChangeListener>();

  constructor(db: DatabaseSync, config?: CanonicalLedgerConfig) {
    this.db = db;
    this.maxFacts = Math.max(1, config?.maxFacts ?? DEFAULT_MAX_FACTS);
    this.budgetTokens = Math.max(100, config?.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
    // One-time-per-boot hygiene: retire heartbeat scaffolding the extraction
    // lane learned as "facts" (see canonical-facts-hygiene.ts). Idempotent.
    try {
      const retired = sweepHeartbeatArtifacts(this.db);
      if (retired > 0) {
        log.info(`canonical hygiene: retired ${retired} heartbeat-artifact fact(s)`);
      }
    } catch (err) {
      log.warn(`canonical hygiene sweep failed: ${String(err)}`);
    }
  }

  /**
   * PLAN-55 Phase 2: subscribe to `canonical:changed`. Fired after the
   * store's own statements ran, once per change of a key's current value
   * (add, supersede, retire, unretire, reactivation). Listeners must be
   * cheap and must not throw into the write path; a throwing listener is
   * logged and skipped. Returns the unsubscribe function.
   */
  onChanged(listener: CanonicalChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChanged(
    op: CanonicalChangeOp,
    fact: CanonicalFact,
    oldValue: string | null,
    extra?: {
      tier?: number;
      source?: string;
      retireReason?: string;
      /** The fact whose value stopped being current (supersede, retire). */
      previous?: CanonicalFact;
    },
  ): void {
    const event: CanonicalChangeEvent = {
      key: fact.key,
      oldValue,
      newValue: op === "retire" ? null : fact.value,
      op,
      tier: extra?.tier ?? canonicalSourceTier(fact.source),
      source: extra?.source ?? fact.source,
      ...(extra?.retireReason ? { retireReason: extra.retireReason } : {}),
      scope: fact.scope,
      evidence: { ref: fact.evidenceRef, chunkIds: [...fact.evidenceChunkIds] },
      ...(extra?.previous
        ? {
            oldEvidence: {
              ref: extra.previous.evidenceRef,
              chunkIds: [...extra.previous.evidenceChunkIds],
            },
          }
        : {}),
      factId: fact.id,
      at: Date.now(),
    };
    // PLAN-55 Phase 2: the outbox row lands in the caller's transaction, so
    // a change that commits is never lost even if the in-memory queue is
    // (shutdown, overflow); the reconcile pass replays unpropagated rows.
    try {
      const res = this.db
        .prepare(
          `INSERT INTO canonical_change_outbox (fact_id, key, event_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(event.factId, event.key, JSON.stringify(event), event.at);
      event.outboxId = Number(res.lastInsertRowid);
    } catch (err) {
      log.debug(`canonical outbox write skipped: ${String(err)}`);
    }
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(`canonical:changed listener failed: ${String(err)}`);
      }
    }
  }

  /** Current belief for a key (active or retired), or null. */
  get(key: string): CanonicalFact | null {
    const slug = normalizeCanonicalKey(key);
    if (!slug) {
      return null;
    }
    const row = this.db
      .prepare(`SELECT * FROM canonical_facts WHERE key = ? AND valid_until IS NULL`)
      .get(slug) as Row | undefined;
    return row ? rowToFact(row) : null;
  }

  /** Full belief history for a key, newest first (point-in-time audit). */
  history(key: string): CanonicalFact[] {
    const slug = normalizeCanonicalKey(key);
    if (!slug) {
      return [];
    }
    // Newest first; when an ADD and its SUPERSEDE land in the same
    // millisecond (fast machines, CI), the current row (open validity
    // window) still sorts ahead of the row it replaced.
    const rows = this.db
      .prepare(
        `SELECT * FROM canonical_facts WHERE key = ?
          ORDER BY valid_from DESC, (valid_until IS NULL) DESC, valid_until DESC`,
      )
      .all(slug) as unknown as Row[];
    return rows.map(rowToFact);
  }

  /**
   * PLAN-55 Phase 0: current rows (one per key) in the given statuses,
   * newest first. The owner's Retired list reads `retired`, `owner_retired`
   * and `unconfirmed` through this; superseded rows are history, not current.
   */
  listByStatus(statuses: CanonicalFactStatus[]): CanonicalFact[] {
    const wanted = statuses.filter((s) => s !== "superseded");
    if (wanted.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM canonical_facts
          WHERE valid_until IS NULL AND status IN (${wanted.map(() => "?").join(", ")})
          ORDER BY valid_from DESC`,
      )
      .all(...wanted) as unknown as Row[];
    return rows.map(rowToFact);
  }

  /** Active facts, highest promotion score first. */
  listActive(opts?: { categories?: string[]; now?: number }): CanonicalFact[] {
    const now = opts?.now ?? Date.now();
    const rows = this.db
      .prepare(`SELECT * FROM canonical_facts WHERE status = 'active' AND valid_until IS NULL`)
      .all() as unknown as Row[];
    let facts = rows.map(rowToFact);
    if (opts?.categories && opts.categories.length > 0) {
      const allowed = new Set(opts.categories);
      facts = facts.filter((f) => allowed.has(f.category));
    }
    return facts.toSorted(
      (a, b) => canonicalPromotionScore(b, now) - canonicalPromotionScore(a, now),
    );
  }

  /**
   * PLAN-33 Phase 4 — ledger-first exact-key lookup for memory_search. When
   * the agent explicitly searches (or the recall-before-claim backstop forces
   * a search), surface the authoritative ledger fact BEFORE the fuzzy semantic
   * hits so an exact key or value match grounds the claim instead of a
   * cosine-gated paraphrase.
   *
   * Deliberately precision-first and NON-fuzzy — the failure mode this ledger
   * exists to kill is fuzzy keyword-shape routing (see PLAN-33's rejected
   * regex auto-keys). It matches ONLY against the finite set of real active
   * facts (<= maxFacts), on two high-confidence signals:
   *   1. the query verbatim contains the fact's value, OR is/contains the
   *      fact's exact dotted key;
   *   2. every human token of the fact's key is present as a query token.
   * No token-overlap heuristics, no stemming — a miss falls back to the
   * always-injected canonical block plus normal semantic recall.
   */
  lookup(
    query: string,
    opts?: { limit?: number; minScore?: number; now?: number },
  ): CanonicalLookupHit[] {
    const raw = (query ?? "").trim();
    if (!raw) {
      return [];
    }
    const now = opts?.now ?? Date.now();
    const limit = Math.max(1, opts?.limit ?? 3);
    const minScore = opts?.minScore ?? 0.6;
    const q = raw.toLowerCase();
    const qTokens = new Set(q.split(/[^a-z0-9]+/).filter((t) => t.length >= 2));
    const wholeKey = normalizeCanonicalKey(raw);
    const hits: CanonicalLookupHit[] = [];
    for (const fact of this.listActive({ now })) {
      let score = 0;
      let matchKind: CanonicalLookupHit["matchKind"] = "key";
      // 1a. query IS (normalizes to) the exact canonical key.
      if (wholeKey && wholeKey === fact.key) {
        score = 1;
        matchKind = "key";
      }
      // 1b. the fact's value appears verbatim in the query.
      const valueLc = fact.value.toLowerCase();
      if (valueLc.length >= 3 && q.includes(valueLc) && score < 0.95) {
        score = 0.95;
        matchKind = "value";
      }
      // 2. every human token of the key is present as a query token (and the
      // key carries at least one non-trivial token, so a degenerate 2-char key
      // cannot match broadly).
      const keyTokens = fact.key
        .split(/[._\-/]+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 2);
      if (
        keyTokens.some((t) => t.length >= 3) &&
        keyTokens.every((t) => qTokens.has(t)) &&
        score < 0.85
      ) {
        score = 0.85;
        matchKind = "key";
      }
      if (score >= minScore) {
        hits.push({ fact, score, matchKind });
      }
    }
    return hits
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          canonicalPromotionScore(b.fact, now) - canonicalPromotionScore(a.fact, now),
      )
      .slice(0, limit);
  }

  /**
   * The single write path — closed reconcile op set:
   *  - no current row            -> ADD (evicting the lowest-scored active
   *                                 fact if the cap is hit)
   *  - same key, same value      -> STRENGTHEN (mention_count++, confidence
   *                                 nudge, reactivates a retired fact)
   *  - same key, new value       -> SUPERSEDE (close the old validity window,
   *                                 insert the new belief; nothing deleted)
   *  - invalid input             -> REJECTED (never a silent partial write)
   */
  pin(input: PinInput): PinResult {
    const slug = normalizeCanonicalKey(input.key);
    if (!slug) {
      return {
        op: "rejected",
        reason: `key must match ${KEY_RX} after normalization (got "${input.key}")`,
      };
    }
    const value = input.value?.trim();
    if (!value) {
      return { op: "rejected", reason: "value must be a non-empty string" };
    }
    if (value.length > MAX_VALUE_CHARS) {
      return {
        op: "rejected",
        reason: `value exceeds ${MAX_VALUE_CHARS} chars — canonical facts are atomic, store prose as a crystal instead`,
      };
    }
    if (isHeartbeatArtifact(slug, value)) {
      return {
        op: "rejected",
        reason: "heartbeat scaffolding is not a fact (prompt/ack text, HEARTBEAT.md, clock lines)",
      };
    }
    // PLAN-55 Phase 1 review (item 5): credentials never enter the ledger,
    // from any source. The reason never carries the value.
    const secret = secretRejectionReason(slug, value);
    if (secret) {
      return { op: "rejected", reason: secret };
    }
    const statement = (input.statement?.trim() || `${slug}: ${value}`).slice(
      0,
      MAX_STATEMENT_CHARS,
    );
    const category: CanonicalCategory = (CANONICAL_CATEGORIES as readonly string[]).includes(
      input.category ?? "",
    )
      ? (input.category as CanonicalCategory)
      : "other";
    const confidence = Math.max(0.05, Math.min(1, input.confidence ?? 0.7));
    const evidence = JSON.stringify(input.evidenceChunkIds ?? []);
    const now = Date.now();
    // PLAN-55 Phase 1: a scope nothing could ever match is a rejected write,
    // not a silently global fact.
    const scope = normalizeCanonicalScope(input.scope);
    if (!scope) {
      return {
        op: "rejected",
        reason: `scope must be "global", "project:<name>" or "person:<name>" (got "${String(input.scope)}")`,
      };
    }
    const evidenceRef = input.evidenceRef?.trim()
      ? input.evidenceRef.trim().replace(/\s+/g, " ").slice(0, MAX_EVIDENCE_REF_CHARS)
      : null;

    const transientReason = rejectBackgroundTransient(input.source, slug, value, category);
    if (transientReason) {
      return { op: "rejected", reason: transientReason };
    }

    // An unknown source has no tier; it must never be able to skip the
    // tier, suppression and owner_retired checks by reading as undefined.
    if (!Object.hasOwn(SOURCE_TRUST_TIER, input.source)) {
      return { op: "rejected", reason: `unknown source "${String(input.source)}"` };
    }
    const tier = canonicalSourceTier(input.source);
    const current = this.get(slug);

    // PLAN-55 Phase 0: the owner retired exactly this key/value. Nothing
    // below the owner tier may bring it back, whatever path it arrives by
    // (extraction, promotion, an agent pin, a directive answer) and
    // whatever the current row looks like (owner_retired, superseded by a
    // newer value, or missing). The check is on the normalised pair, so a
    // case or whitespace variant cannot SUPERSEDE its way around it.
    const suppression = isSuppressed(this.db, "fact_key_value", factKeyValueHash(slug, value));
    if (suppression && tier < OWNER_TRUST_TIER) {
      log.debug(
        `canonical REJECT (owner retired, suppression ${suppression.id}): [${slug}] ${input.source} ` +
          `proposed "${value.slice(0, 40)}"`,
      );
      if (current) {
        this.recordConflict("owner_retired", slug, current, value, input.source, now);
      }
      return {
        op: "rejected",
        reason: `the owner retired "${slug}" with this value; only the owner can bring it back`,
      };
    }
    // The owner pinning what they once retired is their newer decision; the
    // suppression is lifted once the write has actually landed (never on a
    // rejected pin).
    const liftOnSuccess = suppression && tier >= OWNER_TRUST_TIER ? suppression.hash : null;
    const lifted = (): void => {
      if (liftOnSuccess) {
        liftSuppression(this.db, "fact_key_value", liftOnSuccess);
        log.info(`canonical suppression lifted by owner pin: [${slug}]`);
      }
      // PLAN-55 Phase 1 review (item 2): an owner-tier write settles the
      // key: held agent attempts and "which is current?" questions about it
      // are closed, so a question the owner already answered by stating the
      // value never stays open.
      if (tier >= OWNER_TRUST_TIER) {
        this.settleKey(slug, now);
      }
    };

    if (!current) {
      // PLAN-34 Phase 2b: tier-first eviction. A lower-tier ADD may only
      // displace equal-or-lower-tier facts; when the ledger is full of
      // higher-trust facts the ADD is rejected — ATOMICALLY: the victim set
      // is computed first and only applied when the ADD can actually land,
      // so a rejected write never mutates the ledger (Phase 2 adv. fix).
      const incomingScore = canonicalPromotionScore(
        { confidence, mentionCount: 1, lastConfirmedAt: now, corroborationCount: 0 },
        now,
      );
      if (!this.evictForCapacity(now, tier, incomingScore)) {
        return {
          op: "rejected",
          reason:
            `ledger at capacity with only higher-trust facts — a ${input.source} ` +
            `pin cannot displace them`,
        };
      }
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO canonical_facts
             (id, key, value, statement, category, confidence, mention_count,
              first_seen_at, last_confirmed_at, valid_from, valid_until,
              superseded_by, source, evidence_chunk_ids, status, scope, evidence_ref)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          slug,
          value,
          statement,
          category,
          confidence,
          now,
          now,
          now,
          input.source,
          evidence,
          scope,
          evidenceRef,
        );
      const fact = this.get(slug);
      lifted();
      log.info(`canonical ADD: [${slug}] (${input.source}, scope ${scope})`);
      this.emitChanged("add", fact!, null);
      return { op: "add", fact: fact! };
    }

    if (current.value === value) {
      const mergedEvidence = JSON.stringify([
        ...new Set([...current.evidenceChunkIds, ...(input.evidenceChunkIds ?? [])]),
      ]);
      // PLAN-34 Phase 2b: tier-0 confirmation (promotion, web_research) is
      // corroboration-only — a separate counter, no confidence motion, no
      // recency refresh, and NEVER reactivation of a retired fact. Web
      // pages agreeing with the ledger must not keep facts artificially
      // fresh or resurrect what capacity pressure retired.
      if (tier === 0) {
        this.db
          .prepare(
            `UPDATE canonical_facts
                SET corroboration_count = COALESCE(corroboration_count, 0) + 1,
                    evidence_chunk_ids = ?
              WHERE id = ?`,
          )
          .run(mergedEvidence, current.id);
        return { op: "strengthen", fact: this.get(slug)! };
      }
      // PLAN-55 Phase 0: an owner_retired row without a suppression (a
      // pre-v76 database, or a lifted row) is still the owner's decision:
      // only the owner tier reactivates it.
      if (current.status === "owner_retired" && tier < OWNER_TRUST_TIER) {
        log.debug(`canonical REJECT (owner_retired): [${slug}] ${input.source} re-pin`);
        this.recordConflict("owner_retired", slug, current, value, input.source, now);
        return {
          op: "rejected",
          reason: `the owner retired "${slug}"; only the owner can bring it back`,
        };
      }
      // Re-confirmation from tier >= 1 — the signal the crystal store
      // structurally ignores.
      //
      // The staleness ask budget resets here (P1-F7, 2026-08-14). It was a
      // LIFETIME budget: `staleness_asked_count` only ever incremented, so
      // after three asks a fact flipped to 'unconfirmed' and every future
      // staleness episode flipped it again WITHOUT asking — this update set
      // status back to 'active' but left the spent counter, so the oldest,
      // most-often-confirmed facts (identity.user.name,
      // relationship.spouse.name — first in the staleness queue) would have
      // been silently dropped from the active ledger around 2026-10-14.
      // A confirmation ends the staleness episode; the next one gets a fresh
      // three asks.
      const newConfidence = Math.min(1, Math.max(current.confidence, confidence) + 0.05);
      // PLAN-55 Phase 0 review: a confirmation from a higher tier raises the
      // row to that tier. An owner pin of an extraction fact must leave a
      // fact the agent can no longer supersede, not a tier-1 row with an
      // extra mention.
      const source = tier > canonicalSourceTier(current.source) ? input.source : current.source;
      // PLAN-55 Phase 1: a restatement from an equal-or-higher tier may move
      // the scope (the owner saying "everywhere" re-pins the value as
      // global); a lower tier cannot narrow or widen what a higher tier set.
      // The newest evidence wins when one is given.
      const nextScope =
        input.scope !== undefined && tier >= canonicalSourceTier(current.source)
          ? scope
          : current.scope;
      this.db
        .prepare(
          `UPDATE canonical_facts
              SET mention_count = mention_count + 1,
                  confidence = ?,
                  last_confirmed_at = ?,
                  statement = ?,
                  evidence_chunk_ids = ?,
                  source = ?,
                  status = 'active',
                  staleness_asked_count = 0,
                  last_staleness_ask_at = NULL,
                  scope = ?,
                  evidence_ref = COALESCE(?, evidence_ref)
            WHERE id = ?`,
        )
        .run(
          newConfidence,
          now,
          input.statement?.trim() ? statement : current.statement,
          mergedEvidence,
          source,
          nextScope,
          evidenceRef,
          current.id,
        );
      lifted();
      const strengthened = this.get(slug)!;
      // PLAN-55 Phase 2: a restated retired value is current again.
      if (current.status !== "active") {
        this.emitChanged("reactivate", strengthened, null);
      }
      return { op: "strengthen", fact: strengthened };
    }

    // Contradiction: only an equal-or-higher trust tier may replace the
    // current belief. A dream-cycle promotion must never overwrite what the
    // user deliberately pinned; the conflict is surfaced instead of silently
    // resolved either way.
    //
    // PLAN-55 Phase 0 review: a retired row (owner_retired, retired,
    // unconfirmed) is not a current belief, so it guards nothing: its tier
    // reads as 0 here and no tier_rejection is recorded. Otherwise an owner
    // retire of an agent_pin row would lock the key, and the conflict sweep
    // would offer the retired value back to the owner as "which is
    // current?". Only the exact-value suppression above keeps the retired
    // value itself out. Note the SUPERSEDE below overwrites `owner_retired`
    // with `superseded` on the old row (history keeps it); unretire() then
    // has nothing to lift, by design.
    //
    // PLAN-55 Phase 1 review (item 1): a `retired`/`unconfirmed` row still
    // guards against the AGENT: `memory_pin retire` followed by a re-pin
    // would otherwise walk around the hold below. The owner's retire
    // (`owner_retired`) and `superseded` keep the Phase 0 reading.
    const currentTier =
      current.status === "active"
        ? canonicalSourceTier(current.source)
        : (current.status === "retired" || current.status === "unconfirmed") &&
            input.source === "agent_pin"
          ? canonicalSourceTier(current.source)
          : 0;
    // PLAN-55 Phase 1: the agent's own pin never silently replaces a
    // deliberate belief (its earlier pin, or the owner's). The write is held
    // and recorded as a pending_supersede conflict: the reply's confirmation
    // line names it and the conflict sweep asks the owner which is current.
    // Research input (PLAN-55 §3.2): Gemini's delayed-invocation exploit
    // worked because the user confirmed without seeing the diff.
    if (input.source === "agent_pin" && currentTier >= 2) {
      log.info(
        `canonical HELD (pending owner confirmation): [${slug}] agent_pin proposed ` +
          `"${value.slice(0, 40)}" against ${current.source} "${current.value.slice(0, 40)}"`,
      );
      this.recordConflict("pending_supersede", slug, current, value, input.source, now);
      return {
        op: "held",
        reason:
          `"${slug}" is currently "${current.value}" (set by ${current.source}); replacing it ` +
          `with "${value}" is held for the owner's confirmation`,
        fact: current,
        proposedValue: value,
      };
    }
    if (tier < currentTier) {
      log.info(
        `canonical CONFLICT (kept current): [${slug}] ${input.source} proposed ` +
          `"${value.slice(0, 40)}" against ${current.source} "${current.value.slice(0, 40)}"`,
      );
      // PLAN-34 Phase 1 fuel: recording here (inside pin itself, not at
      // call sites) automatically covers every store instance, including
      // the dream engine's private one. The extraction path sweeps these
      // into "which is current?" questions for the user.
      this.recordConflict("tier_rejection", slug, current, value, input.source, now);
      return {
        op: "rejected",
        reason:
          `conflict: current belief for "${slug}" was set by ${current.source} ` +
          `(higher trust than ${input.source}); use memory_pin to supersede deliberately`,
      };
    }
    if (
      now - current.lastConfirmedAt < RAPID_SUPERSEDE_WINDOW_MS &&
      current.mentionCount >= RAPID_SUPERSEDE_MIN_MENTIONS
    ) {
      this.recordConflict("rapid_supersede", slug, current, value, input.source, now);
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `UPDATE canonical_facts
            SET valid_until = ?, status = 'superseded', superseded_by = ?
          WHERE id = ?`,
      )
      .run(now, id, current.id);
    // A correction that names no scope keeps the scope of the belief it
    // replaces: "no, the endpoint is X" inside project A stays project A.
    const nextScope = input.scope !== undefined ? scope : current.scope;
    this.db
      .prepare(
        `INSERT INTO canonical_facts
           (id, key, value, statement, category, confidence, mention_count,
            first_seen_at, last_confirmed_at, valid_from, valid_until,
            superseded_by, source, evidence_chunk_ids, status, scope, evidence_ref)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        slug,
        value,
        statement,
        category,
        confidence,
        now,
        now,
        now,
        input.source,
        evidence,
        nextScope,
        evidenceRef,
      );
    lifted();
    log.info(
      `canonical SUPERSEDE: [${slug}] "${current.value.slice(0, 40)}" -> "${value.slice(0, 40)}"`,
    );
    const superseding = this.get(slug)!;
    this.emitChanged("supersede", superseding, current.value, { previous: current });
    return { op: "supersede", fact: superseding };
  }

  /**
   * PLAN-34 Phase 1: persist a conflict event for the extraction path to
   * sweep into a user-facing question. One UNCONSUMED row per key at a time
   * — a dream-cycle promotion retrying the same rejected pin every cycle
   * must not grow the table without bound. Best-effort — pin() must never
   * fail because conflict bookkeeping did (e.g. a pre-v34 DB without the
   * table).
   */
  private recordConflict(
    kind:
      | "tier_rejection"
      | "rapid_supersede"
      | "owner_retired"
      | "pending_supersede"
      | "pending_retire",
    key: string,
    current: CanonicalFact,
    proposedValue: string,
    proposedSource: CanonicalSource,
    now: number,
  ): void {
    try {
      const pending = this.db
        .prepare(
          `SELECT id, kind FROM canonical_conflicts WHERE key = ? AND consumed_at IS NULL LIMIT 1`,
        )
        .get(key) as { id: string; kind: string } | undefined;
      if (pending) {
        // PLAN-55 Phase 1: a held agent supersede is refreshed in place so the
        // confirmation line reports THIS turn's attempt (latest proposed value,
        // created_at = now) while the table still holds one row per key.
        if (kind.startsWith("pending_") && pending.kind.startsWith("pending_")) {
          this.db
            .prepare(
              `UPDATE canonical_conflicts
                  SET kind = ?, proposed_value = ?, proposed_source = ?, current_value = ?,
                      current_source = ?, created_at = ?
                WHERE id = ?`,
            )
            .run(
              kind,
              proposedValue,
              proposedSource,
              current.value,
              current.source,
              now,
              pending.id,
            );
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO canonical_conflicts
             (id, key, kind, current_value, proposed_value, current_source,
              proposed_source, created_at, consumed_at, directive_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          crypto.randomUUID(),
          key,
          kind,
          current.value,
          proposedValue,
          current.source,
          proposedSource,
          now,
        );
    } catch (err) {
      log.debug(`recordConflict skipped: ${String(err)}`);
    }
  }

  /**
   * Demote a fact out of injection (kept queryable; nothing deleted).
   *
   * PLAN-55 Phase 0: the reason decides how sticky the retirement is.
   * `agent`, `decay` and `hygiene` set `retired`, which any tier >= 1
   * same-value pin reactivates (the pre-Phase-0 behaviour, and still right
   * for a fact the agent or the clock demoted). `owner` sets
   * `owner_retired` and records a key/value suppression, so the fact comes
   * back only through an owner-tier pin or unretire(); it may also upgrade
   * an already `retired` or `unconfirmed` row. Without a reason the call is
   * treated as the agent's (the weakest actor), never the owner's.
   */
  retire(key: string, opts?: { reason?: RetireReason }): boolean {
    const reason = opts?.reason ?? "agent";
    const current = this.get(key);
    if (!current) {
      return false;
    }
    if (reason === "owner") {
      if (current.status === "superseded" || current.status === "owner_retired") {
        return false;
      }
      // Status flip and suppression land together or not at all: a flipped
      // row without its suppression would be a retire the agent can undo.
      const suppression = inSavepoint(this.db, "owner_retire", () => {
        this.db
          .prepare(`UPDATE canonical_facts SET status = 'owner_retired' WHERE id = ?`)
          .run(current.id);
        return addSuppression(this.db, {
          kind: "fact_key_value",
          hash: factKeyValueHash(current.key, current.value),
          reason: "owner_retire",
          actor: "owner",
        });
      });
      log.info(`canonical OWNER-RETIRE: [${current.key}] (suppression ${suppression.id})`);
      this.emitChanged("retire", current, current.value, {
        previous: current,
        tier: OWNER_TRUST_TIER,
        source: "owner",
        retireReason: "owner",
      });
      return true;
    }
    if (current.status !== "active") {
      return false;
    }
    // PLAN-55 Phase 1 review (item 1): the agent cannot retire a deliberate
    // belief (its own earlier pin or the owner's) any more than it can
    // replace one; the attempt is held for the owner. Use retireAgent() to
    // learn which happened.
    if (reason === "agent" && canonicalSourceTier(current.source) >= 2) {
      log.info(`canonical RETIRE HELD (pending owner confirmation): [${current.key}]`);
      this.recordConflict("pending_retire", current.key, current, "", "agent_pin", Date.now());
      return false;
    }
    this.db.prepare(`UPDATE canonical_facts SET status = 'retired' WHERE id = ?`).run(current.id);
    log.info(`canonical RETIRE (${reason}): [${current.key}]`);
    this.emitChanged("retire", current, current.value, {
      previous: current,
      tier: reason === "agent" ? canonicalSourceTier("agent_pin") : 0,
      source: reason === "agent" ? "agent_pin" : reason,
      retireReason: reason,
    });
    return true;
  }

  /**
   * PLAN-55 Phase 1 review (item 1): the agent's retire, with its outcome.
   * `held` means nothing changed and a `pending_retire` conflict was
   * recorded for the owner; `noop` means there was nothing active to retire.
   */
  retireAgent(key: string): {
    op: "retired" | "held" | "noop";
    reason?: string;
    fact?: CanonicalFact;
  } {
    const current = this.get(key);
    if (!current || current.status !== "active") {
      return { op: "noop" };
    }
    if (canonicalSourceTier(current.source) >= 2) {
      this.retire(key, { reason: "agent" });
      return {
        op: "held",
        reason: `"${current.key}" was set by ${current.source}; retiring it is held for the owner's confirmation`,
        fact: current,
      };
    }
    return this.retire(key, { reason: "agent" })
      ? { op: "retired", fact: current }
      : { op: "noop" };
  }

  /**
   * PLAN-55 Phase 1 review (item 2): close everything the owner's statement
   * answers. Unconsumed conflicts for the key are consumed, and open
   * "which is current?" directives tagged `canonical:<key>` are resolved.
   * Best-effort: the write itself has already landed.
   */
  private settleKey(key: string, now: number): void {
    try {
      this.db
        .prepare(
          `UPDATE canonical_conflicts SET consumed_at = ? WHERE key = ? AND consumed_at IS NULL`,
        )
        .run(now, key);
    } catch (err) {
      log.debug(`settleKey conflicts skipped: ${String(err)}`);
    }
    try {
      const tag = `canonical:${key}`.replace(/[\\%_]/g, (c) => `\\${c}`);
      this.db
        .prepare(
          `UPDATE epistemic_directives
              SET resolved_at = ?, status = 'answered',
                  resolution = COALESCE(resolution, 'settled by the owner')
            WHERE resolved_at IS NULL AND source_entity_ids LIKE ? ESCAPE '\\'`,
        )
        .run(now, `%"${tag}"%`);
    } catch (err) {
      log.debug(`settleKey directives skipped: ${String(err)}`);
    }
  }

  /**
   * PLAN-55 Phase 0: the owner lifts a retirement. Reactivates the current
   * row for the key (whatever retired it) and removes the key/value
   * suppression an owner retire wrote. Owner-only semantics: there is no
   * agent path to this.
   */
  unretire(key: string): boolean {
    const current = this.get(key);
    if (!current || current.status === "active" || current.status === "superseded") {
      return false;
    }
    // The owner says it is true again: that is a confirmation, so the
    // staleness episode that may have retired it ends here too.
    this.db
      .prepare(
        `UPDATE canonical_facts
            SET status = 'active',
                last_confirmed_at = ?,
                staleness_asked_count = 0,
                last_staleness_ask_at = NULL
          WHERE id = ?`,
      )
      .run(Date.now(), current.id);
    liftSuppression(this.db, "fact_key_value", factKeyValueHash(current.key, current.value));
    log.info(`canonical UNRETIRE: [${current.key}] (was ${current.status})`);
    this.emitChanged("unretire", current, null, { tier: OWNER_TRUST_TIER, source: "owner" });
    return true;
  }

  /**
   * PLAN-33 Phase 3 — the Ebbinghaus side of the ledger. Retires active facts
   * whose promotion score has decayed below the floor after 90+ days without
   * confirmation. Purely derived from (confidence, mentionCount,
   * lastConfirmedAt), so it is idempotent and independent of how often the
   * maintenance loop runs; every STRENGTHEN resets the staleness clock. An
   * unconfirmed dream promotion (0.6) retires after ~6 months; a deliberate
   * pin (0.95) holds ~9 months; anything confirmed even a few times holds far
   * longer. Retired facts stay queryable — nothing is deleted.
   */
  decayTick(now: number = Date.now()): number {
    const STALE_DAYS = 90;
    const SCORE_FLOOR = 0.25;
    let retired = 0;
    for (const fact of this.listActive({ now })) {
      const staleDays = (now - fact.lastConfirmedAt) / 86_400_000;
      if (staleDays < STALE_DAYS) {
        continue;
      }
      if (canonicalPromotionScore(fact, now) >= SCORE_FLOOR) {
        continue;
      }
      if (!this.retire(fact.key, { reason: "decay" })) {
        continue;
      }
      retired += 1;
      log.info(
        `canonical DECAY-RETIRE: [${fact.key}] unconfirmed ${Math.round(staleDays)}d ` +
          `(${fact.mentionCount} mention(s), confidence ${fact.confidence.toFixed(2)})`,
      );
    }
    return retired;
  }

  /**
   * PLAN-55 Phase 1: agent supersedes held for the owner (unconsumed
   * `pending_supersede` conflicts), newest first, optionally only those
   * recorded since `since`. The reply's confirmation line reads this.
   */
  listPendingSupersedes(opts?: { since?: number; limit?: number }): Array<{
    id: string;
    key: string;
    /** `pending_supersede` (replace) or `pending_retire` (stop injecting). */
    kind: "pending_supersede" | "pending_retire";
    currentValue: string;
    /** Empty for a held retire. */
    proposedValue: string;
    createdAt: number;
  }> {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, key, kind, current_value, proposed_value, created_at FROM canonical_conflicts
            WHERE kind IN ('pending_supersede', 'pending_retire') AND consumed_at IS NULL
              AND created_at >= ?
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(opts?.since ?? 0, Math.max(1, opts?.limit ?? 20)) as unknown as Array<{
        id: string;
        key: string;
        kind: "pending_supersede" | "pending_retire";
        current_value: string;
        proposed_value: string;
        created_at: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        kind: r.kind,
        currentValue: r.current_value,
        proposedValue: r.proposed_value,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  /** Count of active (injectable) facts. */
  activeCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM canonical_facts WHERE status = 'active' AND valid_until IS NULL`,
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Deterministic cap enforcement: while at/over capacity, demote the
   * lowest-promotion-score active fact to `retired`. Score-based, never an
   * LLM decision — the failure mode this ledger exists to kill is exact facts
   * being editorially "compressed" out of the always-present tier.
   */
  /**
   * Make room for one incoming fact. PLAN-34 Phase 2b + Phase 2 adv. fix:
   * ATOMIC and tier-first. Chooses victims lowest-tier-then-lowest-score
   * among facts at a trust tier <= the incoming pin's tier, and — for a
   * SAME-tier victim — only if the incoming fact is at least as high-scored
   * (a fresh background ADD never displaces a STRICTLY better-corroborated
   * same-tier fact; an equal-scored one is displaceable, so two facts
   * pinned in the same millisecond do not deadlock). Computes the full
   * victim set BEFORE mutating: if it cannot free enough slots, it retires
   * NOTHING and returns false (the caller rejects the ADD), so a rejected
   * write can never leave partial evictions applied.
   */
  private evictForCapacity(now: number, incomingTier: number, incomingScore: number): boolean {
    const overBy = this.activeCount() - this.maxFacts + 1;
    if (overBy <= 0) {
      return true;
    }
    const active = this.listActive({ now });
    const evictable = active
      .filter((f) => {
        const tier = canonicalSourceTier(f.source);
        if (tier > incomingTier) {
          return false;
        }
        // Same tier: displace unless the existing fact is STRICTLY better
        // (equal scores are evictable — no tie deadlock across timestamps).
        return tier < incomingTier || canonicalPromotionScore(f, now) <= incomingScore;
      })
      // Lowest tier first, then lowest score (worst victims first).
      .toSorted(
        (a, b) =>
          canonicalSourceTier(a.source) - canonicalSourceTier(b.source) ||
          canonicalPromotionScore(a, now) - canonicalPromotionScore(b, now),
      );
    if (evictable.length < overBy) {
      return false; // cannot make room — retire nothing, reject the ADD
    }
    const victims = evictable.slice(0, overBy);
    const stmt = this.db.prepare(`UPDATE canonical_facts SET status = 'retired' WHERE id = ?`);
    for (const victim of victims) {
      stmt.run(victim.id);
      log.warn(
        `canonical ledger at capacity (${this.maxFacts}): demoted lowest-scored ` +
          `tier-${canonicalSourceTier(victim.source)} fact [${victim.key}]`,
      );
    }
    return true;
  }

  /**
   * Render the deterministic injection block. No LLM touches this — the table
   * is the source of truth and the block is a pure projection of it, ordered
   * by promotion score and truncated only by the whole-fact token budget
   * (a fact is included fully or not at all; never mid-sentence).
   */
  renderBlock(opts?: {
    categories?: string[];
    now?: number;
    /**
     * PLAN-55 Phase 1: the active project (workspace basename). Project-scoped
     * facts render only when it matches; undefined means none of them do.
     */
    activeProject?: string | null;
  }): string | undefined {
    const now = opts?.now ?? Date.now();
    // Promotion order decides which facts survive the budget; the surviving
    // lines are then sorted by key so the block only moves when a fact is
    // added, retired or reworded (cache-prefix stability).
    const facts = this.listActive({ categories: opts?.categories, now })
      .filter(isRenderableCanonicalFact)
      .filter((fact) => isCanonicalFactVisibleInScope(fact.scope, opts?.activeProject));
    if (facts.length === 0) {
      return undefined;
    }
    const budgetChars = Math.min(this.budgetTokens * 4, CANONICAL_RENDER_MAX_CHARS);
    const header = CANONICAL_BLOCK_HEADER.join("\n");
    const selected: Array<{ key: string; line: string }> = [];
    let used = header.length;
    for (const fact of facts) {
      const line = `- [${fact.key}] ${renderCanonicalValue(fact)}`;
      if (used + line.length + 1 > budgetChars) {
        break;
      }
      selected.push({ key: fact.key, line });
      used += line.length + 1;
    }
    if (selected.length === 0) {
      return undefined;
    }
    selected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return `${header}\n${selected.map((entry) => entry.line).join("\n")}`;
  }

  /**
   * One-time seed from the user model's identity preferences so the ledger is
   * not born empty on existing installs. Guarded by a meta-table flag;
   * deliberately contains NO hardcoded facts — canonical content is the
   * user's data, never the product's.
   */
  seedFromIdentityPreferences(
    prefs: Array<{ category: string; key: string; value: string; confidence: number }>,
  ): number {
    const SEED_FLAG = "canonical_seed_v1";
    try {
      const done = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SEED_FLAG) as
        | { value: string }
        | undefined;
      if (done?.value === "1") {
        return 0;
      }
    } catch {
      return 0; // meta table missing — schema not ready, try again next boot
    }
    let seeded = 0;
    for (const pref of prefs) {
      if (pref.category !== "identity" || pref.confidence < 0.6) {
        continue;
      }
      const slug = normalizeCanonicalKey(`identity.${pref.key}`);
      if (!slug) {
        continue;
      }
      const result = this.pin({
        key: slug,
        value: pref.value,
        statement: `The user's ${pref.key.replace(/^user_/, "").replaceAll("_", " ")} is ${pref.value}.`,
        category: "identity",
        confidence: pref.confidence,
        source: "seed",
      });
      if (result.op === "add") {
        seeded += 1;
      }
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`,
      )
      .run(SEED_FLAG);
    if (seeded > 0) {
      log.info(`canonical ledger seeded ${seeded} identity fact(s) from the user model`);
    }
    return seeded;
  }
}
