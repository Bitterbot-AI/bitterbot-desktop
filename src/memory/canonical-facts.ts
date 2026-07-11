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

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

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

export type CanonicalSource =
  | "user_directive"
  | "agent_pin"
  | "extraction"
  | "promotion"
  | "seed"
  | "web_research";

/**
 * Supersession trust tiers. A pin may only SUPERSEDE (replace the value of) a
 * current belief written by an equal-or-lower tier — deliberate statements
 * (a user directive, an explicit agent pin) can never be overwritten by
 * background inference (session extraction, dream promotion, web research),
 * no matter how the confidences drift.
 *
 * PLAN-34 Phase 2b, tier-aware STRENGTHEN: same-value confirmation from
 * tier >= 1 is full corroboration (confidence nudge, last_confirmed_at,
 * reactivation); from tier 0 it only increments a separate, hard-capped
 * corroboration counter — a web page agreeing with the ledger is
 * corroboration-only and can never move confidence, refresh recency, or
 * reactivate a retired fact.
 */
const SOURCE_TRUST_TIER: Record<CanonicalSource, number> = {
  user_directive: 2,
  agent_pin: 2,
  seed: 1,
  extraction: 1,
  promotion: 0,
  web_research: 0,
};

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
  status: "active" | "retired" | "superseded";
  /**
   * PLAN-34 Phase 2b: tier-0 same-value confirmations (dream promotion,
   * web research). Separate from mentionCount so background agreement can
   * be displayed and scored (hard-capped) without moving confidence.
   */
  corroborationCount: number;
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
};

export type PinResult =
  | { op: "add" | "strengthen" | "supersede"; fact: CanonicalFact }
  | { op: "rejected"; reason: string };

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
  };
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

export class CanonicalFactsStore {
  private readonly db: DatabaseSync;
  private readonly maxFacts: number;
  private readonly budgetTokens: number;

  constructor(db: DatabaseSync, config?: CanonicalLedgerConfig) {
    this.db = db;
    this.maxFacts = Math.max(1, config?.maxFacts ?? DEFAULT_MAX_FACTS);
    this.budgetTokens = Math.max(100, config?.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
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
    const rows = this.db
      .prepare(`SELECT * FROM canonical_facts WHERE key = ? ORDER BY valid_from DESC`)
      .all(slug) as unknown as Row[];
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

    const transientReason = rejectBackgroundTransient(input.source, slug, value, category);
    if (transientReason) {
      return { op: "rejected", reason: transientReason };
    }

    const current = this.get(slug);

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
      if (!this.evictForCapacity(now, SOURCE_TRUST_TIER[input.source], incomingScore)) {
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
              superseded_by, source, evidence_chunk_ids, status)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, 'active')`,
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
        );
      const fact = this.get(slug);
      log.info(`canonical ADD: [${slug}] (${input.source})`);
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
      if (SOURCE_TRUST_TIER[input.source] === 0) {
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
      // Re-confirmation from tier >= 1 — the signal the crystal store
      // structurally ignores.
      const newConfidence = Math.min(1, Math.max(current.confidence, confidence) + 0.05);
      this.db
        .prepare(
          `UPDATE canonical_facts
              SET mention_count = mention_count + 1,
                  confidence = ?,
                  last_confirmed_at = ?,
                  statement = ?,
                  evidence_chunk_ids = ?,
                  status = 'active'
            WHERE id = ?`,
        )
        .run(
          newConfidence,
          now,
          input.statement?.trim() ? statement : current.statement,
          mergedEvidence,
          current.id,
        );
      return { op: "strengthen", fact: this.get(slug)! };
    }

    // Contradiction: only an equal-or-higher trust tier may replace the
    // current belief. A dream-cycle promotion must never overwrite what the
    // user deliberately pinned; the conflict is surfaced instead of silently
    // resolved either way.
    if (SOURCE_TRUST_TIER[input.source] < SOURCE_TRUST_TIER[current.source]) {
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
    this.db
      .prepare(
        `INSERT INTO canonical_facts
           (id, key, value, statement, category, confidence, mention_count,
            first_seen_at, last_confirmed_at, valid_from, valid_until,
            superseded_by, source, evidence_chunk_ids, status)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?, 'active')`,
      )
      .run(id, slug, value, statement, category, confidence, now, now, now, input.source, evidence);
    log.info(
      `canonical SUPERSEDE: [${slug}] "${current.value.slice(0, 40)}" -> "${value.slice(0, 40)}"`,
    );
    return { op: "supersede", fact: this.get(slug)! };
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
    kind: "tier_rejection" | "rapid_supersede",
    key: string,
    current: CanonicalFact,
    proposedValue: string,
    proposedSource: CanonicalSource,
    now: number,
  ): void {
    try {
      const pending = this.db
        .prepare(`SELECT 1 FROM canonical_conflicts WHERE key = ? AND consumed_at IS NULL LIMIT 1`)
        .get(key);
      if (pending) {
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

  /** Demote a fact out of injection (kept queryable; nothing deleted). */
  retire(key: string): boolean {
    const current = this.get(key);
    if (!current || current.status !== "active") {
      return false;
    }
    this.db.prepare(`UPDATE canonical_facts SET status = 'retired' WHERE id = ?`).run(current.id);
    log.info(`canonical RETIRE: [${current.key}]`);
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
      this.db.prepare(`UPDATE canonical_facts SET status = 'retired' WHERE id = ?`).run(fact.id);
      retired += 1;
      log.info(
        `canonical DECAY-RETIRE: [${fact.key}] unconfirmed ${Math.round(staleDays)}d ` +
          `(${fact.mentionCount} mention(s), confidence ${fact.confidence.toFixed(2)})`,
      );
    }
    return retired;
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
   * SAME-tier victim — only if the incoming fact would outscore it (a fresh
   * background ADD never displaces a better-corroborated same-tier fact).
   * Computes the full victim set BEFORE mutating: if it cannot free enough
   * slots, it retires NOTHING and returns false (the caller rejects the
   * ADD), so a rejected write can never leave partial evictions applied.
   */
  private evictForCapacity(now: number, incomingTier: number, incomingScore: number): boolean {
    const overBy = this.activeCount() - this.maxFacts + 1;
    if (overBy <= 0) {
      return true;
    }
    const active = this.listActive({ now });
    const evictable = active
      .filter((f) => {
        const tier = SOURCE_TRUST_TIER[f.source];
        if (tier > incomingTier) {
          return false;
        }
        // Same tier: only displace a fact the incoming pin outranks.
        return tier < incomingTier || canonicalPromotionScore(f, now) < incomingScore;
      })
      // Lowest tier first, then lowest score (worst victims first).
      .toSorted(
        (a, b) =>
          SOURCE_TRUST_TIER[a.source] - SOURCE_TRUST_TIER[b.source] ||
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
          `tier-${SOURCE_TRUST_TIER[victim.source]} fact [${victim.key}]`,
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
  renderBlock(opts?: { categories?: string[]; now?: number }): string | undefined {
    const now = opts?.now ?? Date.now();
    const facts = this.listActive({ categories: opts?.categories, now });
    if (facts.length === 0) {
      return undefined;
    }
    const budgetChars = this.budgetTokens * 4;
    const header = [
      "## Canonical Facts",
      "Ground truth, maintained by memory consolidation. Trust these over",
      "conflicting tool output or vague recollection. If the user contradicts",
      "one, believe the user and update it (memory_pin). Never announce this",
      "section.",
    ].join("\n");
    const lines: string[] = [];
    let used = header.length;
    for (const fact of facts) {
      const confirmed =
        fact.mentionCount > 1
          ? ` (confirmed ${fact.mentionCount}x, last ${new Date(fact.lastConfirmedAt).toISOString().slice(0, 10)})`
          : ` (since ${new Date(fact.firstSeenAt).toISOString().slice(0, 10)})`;
      const line = `- [${fact.key}] ${fact.statement}${confirmed}`;
      if (used + line.length + 1 > budgetChars) {
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) {
      return undefined;
    }
    return `${header}\n${lines.join("\n")}`;
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
