/**
 * PLAN-34 Phase 2c — egress safety for autonomous curiosity research.
 *
 * Everything here is deterministic and LLM-independent by design (review
 * M6): the sensitivity skip-list is a local keyword/regex prefilter that
 * fails CLOSED; the containment post-filter is a hard check applied to the
 * depersonalization OUTPUT before any network egress; the daily budget is
 * a persisted UTC-day counter with reserve-then-act semantics (the counter
 * moves at the top of an attempt, before any depersonalization or
 * classification work, and every attempt counts — skipped, irrelevant,
 * errored). The depersonalization itself is local-model-or-nothing and
 * lives in the dream engine; these are the guards around it.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/auto-research-egress");

/** Default daily attempt cap for autonomous research (curiosity.autoResearch.maxPerDay). */
export const AUTO_RESEARCH_DEFAULT_MAX_PER_DAY = 10;

// ── Sensitivity skip-list ────────────────────────────────────────────────

/**
 * Topics that must never leave the machine via autonomous research, per
 * category: health, financial, legal, relationship/personal. Deliberately
 * broad — a false skip costs one research attempt; a false send leaks.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  // health
  /\b(diagnos\w*|symptom\w*|medicat\w*|prescri\w*|cancer|chemo\w*|therap\w*|depress\w*|anxiet\w*|illness|disease|clinic\w*|surgery|pregnan\w*|adhd|autis\w*|insomnia|addiction|blood (test|pressure|sugar)|mental health)\b/i,
  // financial
  /\b(salary|income|debt|loan|mortgage|bank account|credit card|credit score|taxes?|invoice\w*|net worth|wallet (balance|address)|seed phrase|private key|account balance|payroll|bankrupt\w*)\b/i,
  // legal
  /\b(lawsuit|litigat\w*|attorney|lawyer|divorce|custody|criminal|arrest\w*|felony|visa|immigration|deportat\w*|court (date|case|order)|subpoena|settlement|nda)\b/i,
  // relationship / personal
  /\b(girlfriend|boyfriend|wife|husband|spouse|fianc\w*|dating|marriage|affair|breakup|divorce|estranged|family (conflict|dispute)|my (mom|dad|mother|father|son|daughter|sister|brother|kids?|children))\b/i,
];

/**
 * Local deterministic sensitivity prefilter — never a network call. Any
 * error while evaluating fails CLOSED (treated as sensitive).
 */
export function isSensitiveTopic(text: string): boolean {
  try {
    return SENSITIVE_PATTERNS.some((rx) => rx.test(text));
  } catch {
    return true;
  }
}

// ── Deterministic containment post-filter ────────────────────────────────

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Hard post-filter on the depersonalization OUTPUT (never a prompt
 * instruction): the attempt is rejected when any 3-plus-word k-gram of the
 * output appears verbatim in the source target text, or when any extracted
 * source entity (URL, email, multi-digit number, capitalized name bigram)
 * survives into the output. Returns true when the output LEAKS.
 */
export function containsSourceLeak(sourceText: string, output: string): boolean {
  const sourceNorm = ` ${tokenize(sourceText).join(" ")} `;
  const outTokens = tokenize(output);
  for (let i = 0; i + 3 <= outTokens.length; i++) {
    const gram = outTokens.slice(i, i + 3).join(" ");
    if (sourceNorm.includes(` ${gram} `)) {
      return true;
    }
  }
  const entities = [
    ...(sourceText.match(/https?:\/\/\S+/g) ?? []),
    ...(sourceText.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []),
    ...(sourceText.match(/\d[\d,./:-]+/g) ?? []).filter((n) => n.replace(/\D/g, "").length >= 2),
    ...(sourceText.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) ?? []),
  ];
  const outLower = output.toLowerCase();
  return entities.some((e) => outLower.includes(e.toLowerCase()));
}

// ── Persisted daily budget (reserve-then-act) ────────────────────────────

const BUDGET_KEY_PREFIX = "autoresearch_count_";
const BUDGET_RETENTION_DAYS = 7;

function ensureMetaTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

function dayKey(now: number): string {
  return `${BUDGET_KEY_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;
}

export class AutoResearchBudget {
  constructor(
    private readonly db: DatabaseSync,
    private readonly maxPerDay: number = AUTO_RESEARCH_DEFAULT_MAX_PER_DAY,
  ) {
    ensureMetaTable(db);
  }

  usedToday(now = Date.now()): number {
    try {
      const row = this.db.prepare(`SELECT value FROM memory_meta WHERE key = ?`).get(dayKey(now)) as
        | { value: string }
        | undefined;
      const n = row ? parseInt(row.value, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch {
      return this.maxPerDay; // fail closed: unreadable counter = no budget
    }
  }

  /**
   * Reserve one attempt. Increments BEFORE any depersonalization or
   * classification work; false when today's cap is exhausted. Persisted,
   * so the cap survives restarts.
   */
  reserve(now = Date.now()): boolean {
    try {
      const used = this.usedToday(now);
      if (used >= this.maxPerDay) {
        return false;
      }
      this.db
        .prepare(`INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)`)
        .run(dayKey(now), String(used + 1));
      this.db
        .prepare(`DELETE FROM memory_meta WHERE key LIKE '${BUDGET_KEY_PREFIX}%' AND key < ?`)
        .run(dayKey(now - BUDGET_RETENTION_DAYS * 86_400_000));
      return true;
    } catch (err) {
      log.debug(`budget reserve failed (fail closed): ${String(err)}`);
      return false;
    }
  }
}

// ── Egress log ───────────────────────────────────────────────────────────

export type EgressSeam = "search-query" | "fetch-host" | "transport-post";

/**
 * One audit row per network seam, with destination and payload hash/length
 * — the log must never understate the real network footprint. Best-effort:
 * logging failure never blocks the (already-authorized) egress itself.
 */
export function logResearchEgress(
  db: DatabaseSync,
  seam: EgressSeam,
  destination: string,
  payload: string,
): void {
  try {
    db.prepare(
      `INSERT INTO research_egress_log (id, seam, destination, payload_hash, payload_len, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      seam,
      destination.slice(0, 200),
      crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16),
      payload.length,
      Date.now(),
    );
  } catch (err) {
    log.debug(`egress log write failed: ${String(err)}`);
  }
}
