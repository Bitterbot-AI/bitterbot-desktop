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

/**
 * Fold a string to an ASCII, punctuation-stripped, lowercase comparison
 * form so homoglyph/accent substitution (Cyrillic 'і', "Víctor") cannot
 * slip an identifier past the substring check.
 */
const foldForMatch = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Capitalized tokens that commonly START a sentence or are generic — not
 * identifiers. Kept small; safety prefers over-extraction of proper nouns.
 */
const COMMON_CAP_WORDS = new Set([
  "the",
  "a",
  "an",
  "new",
  "how",
  "what",
  "why",
  "when",
  "where",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "our",
  "we",
  "user",
  "users",
  "note",
  "notes",
  "research",
  "topic",
  "based",
  "opened",
  "frontier",
  "dream",
  "insight",
]);

/**
 * Extract identifier-shaped entities from the SOURCE whose survival into
 * the output would leak private specifics: full URLs, emails, dotted
 * hostnames/slugs (a2a.bitterbot.ai, forage.post, soapbox.net),
 * multi-digit numbers, all-caps acronyms, and proper nouns — both
 * capitalized bigrams AND single capitalized tokens (project codenames,
 * people), which an imperfect local rewrite is most likely to keep.
 */
function extractSourceEntities(sourceText: string): string[] {
  const out: string[] = [];
  const push = (arr: RegExpMatchArray | null) => {
    for (const m of arr ?? []) {
      const f = foldForMatch(m);
      if (f.length >= 2) {
        out.push(f);
      }
    }
  };
  push(sourceText.match(/https?:\/\/\S+/g));
  push(sourceText.match(/[\w.+-]+@[\w-]+\.[\w.]+/g));
  // Dotted hostnames / slugs: 2+ alnum labels joined by dots.
  push(sourceText.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi));
  push(sourceText.match(/\d[\d,./:-]*\d|\b\d\b/g));
  push(sourceText.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g)); // capitalized bigrams
  push(sourceText.match(/\b[A-Z]{3,}\b/g)); // acronyms
  // Single capitalized proper nouns not in the common-word stoplist.
  for (const m of sourceText.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) {
    if (!COMMON_CAP_WORDS.has(m.toLowerCase())) {
      out.push(foldForMatch(m));
    }
  }
  return out;
}

/**
 * Hard post-filter on the depersonalization OUTPUT (never a prompt
 * instruction): the attempt is rejected when any 3-plus-word k-gram of the
 * output appears verbatim in the source target text, OR when any extracted
 * source entity (URL, email, dotted host/slug, number, acronym, or proper
 * noun — single or bigram) survives into the output. Matching is
 * homoglyph/accent-folded so unicode substitution cannot evade it.
 * Returns true when the output LEAKS.
 *
 * Deliberately safety-over-availability (PLAN-34 §5.3): a note whose topic
 * IS a private identifier will keep failing until the local model produces
 * a genuinely generic phrase. The `containment_rejected` outcome is
 * recorded and dashboard-visible, so this is never silent.
 */
export function containsSourceLeak(sourceText: string, output: string): boolean {
  const sourceNorm = ` ${foldForMatch(sourceText)} `;
  const outFolded = foldForMatch(output);
  const outTokens = outFolded.split(" ").filter(Boolean);
  for (let i = 0; i + 3 <= outTokens.length; i++) {
    const gram = outTokens.slice(i, i + 3).join(" ");
    if (sourceNorm.includes(` ${gram} `)) {
      return true;
    }
  }
  const paddedOut = ` ${outFolded} `;
  return extractSourceEntities(sourceText).some((e) => paddedOut.includes(` ${e} `));
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
      if (!row) {
        return 0;
      }
      const n = parseInt(row.value, 10);
      // Fail CLOSED on a corrupt value: treat as budget exhausted, never as 0.
      return Number.isFinite(n) ? n : this.maxPerDay;
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
