/**
 * PLAN-54: the motor of the curiosity loop.
 *
 * On its own schedule the agent takes a question it is wondering about, turns
 * it into a topic phrase that carries nothing personal, searches the web,
 * reads a few pages, distills a cited answer, and remembers it with full
 * provenance. The next time the owner talks about that topic, proactive
 * recall surfaces the fact marked "learned on my own", and the use ledger
 * records that curiosity paid off there.
 *
 * Privacy by construction: the phrase that leaves the node is written by the
 * agent's own model (the party that already holds the note), then checked
 * deterministically for leaked fragments and the owner's name; anything that
 * fails is never sent. Every egress is logged.
 *
 * Verification: an answer becomes a fact only when at least two fetched
 * sources support it, or one does at high confidence; otherwise the attempt is
 * recorded as inconclusive and the question is tried once more later.
 *
 * Nothing here needs approval. It is visible (Curiosity page, dream brief,
 * usage ledger) and stoppable (pause, dismiss, config) by design.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { containsSourceLeak, isSensitiveTopic } from "./auto-research-egress.js";
import { setChunkLifecycle } from "./chunk-writer.js";
import {
  cosineSimilarity,
  insertNovelTargets,
  researchableTargets,
  type ResearchableTarget,
} from "./curiosity-gaps.js";
import { curiosityRoiByRegion, curiosityUtility } from "./curiosity-use.js";

const log = createSubsystemLogger("memory/curiosity");

export type CuriosityResearchConfig = {
  /** Default true. The legacy `autoResearch.enabled: false` also disables. */
  enabled?: boolean;
  /** Minutes between research passes. Default 240. */
  intervalMinutes?: number;
  /** Questions researched per day. Default 6 (hormones shift it by up to 2). */
  maxPerDay?: number;
  /** Default 2. */
  maxSearchesPerTarget?: number;
  /** Pages fetched per question. Default 3. */
  maxPagesPerTarget?: number;
  /** Confidence floor for a finding to become a fact. Default 0.55. */
  minConfidence?: number;
  /** Hosts never fetched. */
  blockedDomains?: string[];
  /** Attempts before a question is closed as unanswered. Default 2. */
  maxAttempts?: number;
};

export const DEFAULT_CURIOSITY_RESEARCH: Required<CuriosityResearchConfig> = {
  enabled: true,
  intervalMinutes: 240,
  maxPerDay: 6,
  maxSearchesPerTarget: 2,
  maxPagesPerTarget: 3,
  minConfidence: 0.55,
  blockedDomains: [],
  maxAttempts: 2,
};

export type SearchHit = { title: string; url: string; snippet?: string };
export type LlmResult = { text: string; costUsd: number };

export type CuriosityResearchDeps = {
  db: DatabaseSync;
  config: CuriosityResearchConfig;
  /** Configured web search; null when no provider/key is set. */
  search: ((query: string, count: number) => Promise<SearchHit[] | null>) | null;
  /** SSRF-guarded page fetch returning readable text, or null; must honor blocked hosts after redirects. */
  fetchPage: (
    url: string,
    blockedDomains?: string[],
  ) => Promise<{ text: string; title?: string } | null>;
  /** Wall-clock cap for one pass; targets not started by then wait for the next. Default 8 min. */
  passDeadlineMs?: number;
  /** The agent's own model, attributed to the usage ledger as memory/curiosity. */
  llm: (prompt: string) => Promise<LlmResult>;
  /** A genuinely local model, preferred for the abstraction step when present. */
  llmLocal?: ((prompt: string) => Promise<LlmResult>) | null;
  /** Query embedding for region assignment; null when unavailable. */
  embed?: ((text: string) => Promise<number[] | null>) | null;
  hormonal?: () => { dopamine: number; cortisol: number; oxytocin: number } | null;
  onEvent?: (event: "curiosity_progress" | "curiosity_stagnant") => void;
  /** Names that must never appear in an outgoing phrase (the owner, close contacts). */
  ownerNames?: string[];
  /** Search provider label for the egress log. */
  searchProvider?: string;
  now?: () => number;
};

export type ResearchOutcome =
  | "learned"
  | "inconclusive"
  | "unanswered"
  | "no_results"
  | "sensitive_skipped"
  | "containment_rejected"
  | "transient_error"
  | "dismissed";

export type CuriosityRunSummary = {
  ran: boolean;
  reason?: string;
  attempted: number;
  learned: number;
  outcomes: Partial<Record<ResearchOutcome, number>>;
  costUsd: number;
};

// ── persisted state (memory_meta) ───────────────────────────────────────────

const META_PAUSED = "curiosity_research_paused";
const META_LAST_RUN = "curiosity_research_last_run";
const metaDayKey = (now: number) =>
  `curiosity_research_day_${new Date(now).toISOString().slice(0, 10)}`;

function ensureMeta(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

function getMeta(db: DatabaseSync, key: string): string | null {
  try {
    ensureMeta(db);
    const row = db.prepare(`SELECT value FROM memory_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  ensureMeta(db);
  db.prepare(
    `INSERT INTO memory_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function isCuriosityPaused(db: DatabaseSync): boolean {
  return getMeta(db, META_PAUSED) === "1";
}

export function setCuriosityPaused(db: DatabaseSync, paused: boolean): void {
  setMeta(db, META_PAUSED, paused ? "1" : "0");
}

export function resolveCuriosityResearchConfig(
  raw: CuriosityResearchConfig | undefined,
  legacyAutoResearchEnabled?: boolean,
): Required<CuriosityResearchConfig> {
  const cfg = { ...DEFAULT_CURIOSITY_RESEARCH, ...raw };
  if (legacyAutoResearchEnabled === false && raw?.enabled !== true) {
    cfg.enabled = false;
  }
  return cfg;
}

// ── abstraction (what may leave the node) ───────────────────────────────────

const EMAIL_OR_URL = /[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/|www\./i;

/** True when the phrase carries a fragment of the note, a name, an address, or a URL. */
const STOPWORDS = new Set(
  "a an the and or of to in on for with is are was were be been do does did how what when where why which who whom whose my your our their his her its this that these those it i you we they at by from as if than then so not no any some about into over under up down out off".split(
    " ",
  ),
);

const tokensOf = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export function phraseLeaks(question: string, phrase: string, ownerNames: string[] = []): boolean {
  if (EMAIL_OR_URL.test(phrase)) {
    return true;
  }
  if (containsSourceLeak(question, phrase)) {
    return true;
  }
  const qTokens = tokensOf(question);
  const pTokens = tokensOf(phrase);
  // Any two consecutive words copied from the question (not both stopwords)
  // is a fragment, whatever its case: "lena birthday" from "when is lena's
  // birthday". containsSourceLeak only catches capitalized entities and
  // 3-grams; owners type their questions in lowercase.
  const qBigrams = new Set<string>();
  for (let i = 0; i + 1 < qTokens.length; i += 1) {
    if (!(STOPWORDS.has(qTokens[i]!) && STOPWORDS.has(qTokens[i + 1]!))) {
      qBigrams.add(`${qTokens[i]} ${qTokens[i + 1]}`);
    }
  }
  for (let i = 0; i + 1 < pTokens.length; i += 1) {
    if (qBigrams.has(`${pTokens[i]} ${pTokens[i + 1]}`)) {
      return true;
    }
  }
  // A non-ASCII token copied from the question (names the ASCII fold erases).
  const qNonAscii = new Set(qTokens.filter((t) => /\P{ASCII}/u.test(t)));
  if (pTokens.some((t) => qNonAscii.has(t))) {
    return true;
  }
  const pSet = new Set(pTokens);
  const lowerPhrase = phrase.toLowerCase();
  for (const name of ownerNames) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed.length >= 2 && lowerPhrase.includes(trimmed)) {
      return true;
    }
    for (const token of tokensOf(name)) {
      if (token.length >= 2 && pSet.has(token)) {
        return true;
      }
    }
  }
  return false;
}

function abstractionPrompt(question: string): string {
  return (
    "Rewrite the private note below as a short, generic web-search phrase of 3 to 10 words " +
    "about its underlying topic. Output ONLY the phrase. Never include names of people, " +
    "companies or products the note mentions, numbers, dates, email addresses, URLs, or any " +
    "quoted fragment of the note. Prefer the general subject someone else could also search.\n\n" +
    `Note: ${question}`
  );
}

export async function abstractQuestion(
  question: string,
  llm: (prompt: string) => Promise<LlmResult>,
  ownerNames: string[] = [],
): Promise<{ phrase: string | null; costUsd: number }> {
  const { text, costUsd } = await llm(abstractionPrompt(question));
  const phrase = text
    .trim()
    .split("\n")[0]!
    .replace(/^["'`]+|["'`.]+$/g, "")
    .trim()
    .slice(0, 120);
  if (phrase.length < 3 || phraseLeaks(question, phrase, ownerNames)) {
    return { phrase: null, costUsd };
  }
  return { phrase, costUsd };
}

// ── distillation (what becomes a fact) ──────────────────────────────────────

type Distilled = {
  answer: string;
  confidence: number;
  supportingSources: number[];
};

function distillPrompt(question: string, pages: Array<{ url: string; text: string }>): string {
  const sources = pages.map((p, i) => `[${i + 1}] ${p.url}\n${p.text.slice(0, 6000)}`).join("\n\n");
  return (
    "You are researching a question on behalf of someone who is not present. Using ONLY the " +
    "sources below, write a concise answer (at most 120 words) a well-informed friend would " +
    "give. If the sources do not answer it, say so and give low confidence. Then output a JSON " +
    "object on its own last line with keys: answer (string), confidence (0 to 1, how well the " +
    "sources support the answer), supporting_sources (array of source numbers that support " +
    "the answer).\n\n" +
    `Question: ${question}\n\nSources:\n${sources}`
  );
}

export function parseDistilled(text: string): Distilled | null {
  const match = text.match(/\{[\s\S]*\}\s*$/);
  const candidates = match ? [match[0]] : [];
  const firstBrace = text.indexOf("{");
  if (firstBrace >= 0) {
    candidates.push(text.slice(firstBrace));
  }
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as Record<string, unknown>;
      const answer = typeof v.answer === "string" ? v.answer.trim() : "";
      const confidence = typeof v.confidence === "number" ? v.confidence : Number.NaN;
      const supporting = Array.isArray(v.supporting_sources)
        ? v.supporting_sources.filter((n): n is number => Number.isInteger(n) && n > 0)
        : [];
      if (answer && Number.isFinite(confidence)) {
        return {
          answer: answer.slice(0, 1200),
          confidence: Math.max(0, Math.min(1, confidence)),
          supportingSources: [...new Set(supporting)],
        };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Two agreeing sources, or one at clearly higher confidence. */
export function findingIsVerified(d: Distilled, floor: number): boolean {
  if (d.confidence < floor) {
    return false;
  }
  return d.supportingSources.length >= 2 || d.confidence >= Math.min(0.95, floor + 0.2);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostBlocked(host: string, blocked: string[]): boolean {
  return blocked.some((b) => {
    const d = b.toLowerCase().replace(/^\*\./, "");
    return host === d || host.endsWith(`.${d}`);
  });
}

function logEgress(
  db: DatabaseSync,
  seam: string,
  destination: string,
  payload: string,
  now: number,
) {
  try {
    db.prepare(
      `INSERT INTO research_egress_log (id, seam, destination, payload_hash, payload_len, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      seam,
      destination,
      crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16),
      payload.length,
      now,
    );
  } catch {
    // the log table is optional on old databases
  }
}

function nearestRegion(db: DatabaseSync, embedding: number[]): string | null {
  try {
    const rows = db
      .prepare(`SELECT id, centroid FROM curiosity_regions`)
      .all() as unknown as Array<{
      id: string;
      centroid: string;
    }>;
    let best: { id: string; sim: number } | null = null;
    for (const r of rows) {
      let c: number[];
      try {
        c = JSON.parse(r.centroid) as number[];
      } catch {
        continue;
      }
      const sim = cosineSimilarity(embedding, c);
      if (!best || sim > best.sim) {
        best = { id: r.id, sim };
      }
    }
    return best && best.sim >= 0.5 ? best.id : null;
  } catch {
    return null;
  }
}

function recordOutcome(
  db: DatabaseSync,
  targetId: string,
  outcome: ResearchOutcome,
  opts: {
    resolve: boolean;
    countAttempt: boolean;
    now: number;
    phrase?: string | null;
    /** Current attempts before this one; with maxAttempts, the last counted attempt closes the target. */
    attempts: number;
    maxAttempts: number;
  },
): void {
  const exhausted = opts.countAttempt && opts.attempts + 1 >= opts.maxAttempts;
  const resolve = opts.resolve || exhausted;
  db.prepare(
    `UPDATE curiosity_targets
        SET metadata = json_set(COALESCE(metadata, '{}'),
              '$.researchOutcome', ?, '$.researchedAt', ?, '$.queryPhrase', ?,
              '$.transientErrors', CASE WHEN ? THEN COALESCE(json_extract(metadata, '$.transientErrors'), 0) + 1 ELSE 0 END),
            attempts = attempts + ?,
            resolved_at = CASE WHEN ? THEN COALESCE(resolved_at, ?) ELSE resolved_at END
      WHERE id = ?`,
  ).run(
    outcome,
    opts.now,
    opts.phrase ?? null,
    outcome === "transient_error" ? 1 : 0,
    opts.countAttempt ? 1 : 0,
    resolve ? 1 : 0,
    opts.now,
    targetId,
  );
}

/** Three transient errors in a row count as one real attempt, so a target cannot be re-picked forever. */
const TRANSIENT_ERRORS_PER_ATTEMPT = 3;

// ── the pass ────────────────────────────────────────────────────────────────

export async function runCuriosityResearch(
  deps: CuriosityResearchDeps,
  opts: { force?: boolean } = {},
): Promise<CuriosityRunSummary> {
  const now = deps.now?.() ?? Date.now();
  const cfg = resolveCuriosityResearchConfig(deps.config);
  const summary: CuriosityRunSummary = {
    ran: false,
    attempted: 0,
    learned: 0,
    outcomes: {},
    costUsd: 0,
  };
  const bump = (o: ResearchOutcome) => {
    summary.outcomes[o] = (summary.outcomes[o] ?? 0) + 1;
  };
  if (!cfg.enabled) {
    return { ...summary, reason: "disabled" };
  }
  if (isCuriosityPaused(deps.db)) {
    return { ...summary, reason: "paused" };
  }
  if (!deps.search) {
    return { ...summary, reason: "no web search configured" };
  }
  const lastRun = Number(getMeta(deps.db, META_LAST_RUN) ?? 0);
  if (!opts.force && now - lastRun < cfg.intervalMinutes * 60 * 1000) {
    return { ...summary, reason: "interval not elapsed" };
  }
  const h = deps.hormonal?.() ?? null;
  // Dopamine widens the day's breadth; cortisol narrows it and raises the bar.
  const budget = Math.max(
    1,
    cfg.maxPerDay + (h && h.dopamine > 0.65 ? 2 : 0) - (h && h.cortisol > 0.65 ? 2 : 0),
  );
  const floor = Math.min(0.9, cfg.minConfidence + (h && h.cortisol > 0.65 ? 0.1 : 0));
  const dayKey = metaDayKey(now);
  const doneToday = Number(getMeta(deps.db, dayKey) ?? 0);
  if (doneToday >= budget) {
    return { ...summary, reason: "daily budget reached" };
  }
  setMeta(deps.db, META_LAST_RUN, String(now));
  summary.ran = true;

  const targets = researchableTargets(deps.db, {
    now,
    limit: Math.min(3, budget - doneToday),
    maxAttempts: cfg.maxAttempts,
    regionRoi: curiosityRoiByRegion(deps.db),
  });
  let countedToday = doneToday;
  const deadline = now + (deps.passDeadlineMs ?? 8 * 60 * 1000);
  for (const target of targets) {
    if ((deps.now?.() ?? Date.now()) > deadline) {
      summary.reason = "pass deadline reached";
      break;
    }
    summary.attempted += 1;
    const costBefore = summary.costUsd;
    const transientSoFar = Number(target.metadata.transientErrors ?? 0);
    const finish = (o: ResearchOutcome, resolve: boolean, phrase?: string | null) => {
      bump(o);
      // A transient error (provider outage) is not the agent's attempt and
      // does not spend the day's budget, but three in a row do.
      const transientCounts =
        o === "transient_error" && transientSoFar + 1 >= TRANSIENT_ERRORS_PER_ATTEMPT;
      const countAttempt = o !== "transient_error" || transientCounts;
      if (countAttempt) {
        countedToday += 1;
        setMeta(deps.db, dayKey, String(countedToday));
      }
      recordOutcome(deps.db, target.id, o, {
        resolve,
        countAttempt,
        now,
        phrase,
        attempts: target.attempts,
        maxAttempts: cfg.maxAttempts,
      });
    };
    try {
      await researchOne(
        deps,
        cfg,
        target,
        floor,
        h,
        finish,
        summary,
        () => summary.costUsd - costBefore,
      );
    } catch (err) {
      // A closed database handle (reindex swapped it) or a bug: stop the pass, never the gateway.
      log.warn(`curiosity research pass stopped: ${String(err)}`);
      summary.reason = "error";
      break;
    }
    if (countedToday >= budget) {
      break;
    }
  }
  return summary;
}

async function researchOne(
  deps: CuriosityResearchDeps,
  cfg: Required<CuriosityResearchConfig>,
  target: ResearchableTarget,
  floor: number,
  h: { dopamine: number; cortisol: number; oxytocin: number } | null,
  finish: (o: ResearchOutcome, resolve: boolean, phrase?: string | null) => void,
  summary: CuriosityRunSummary,
  costSoFar: () => number,
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  {
    if (isSensitiveTopic(target.description)) {
      finish("sensitive_skipped", true);
      return;
    }
    let phrase: string | null;
    try {
      const abstracted = await abstractQuestion(
        target.description,
        deps.llmLocal ?? deps.llm,
        deps.ownerNames ?? [],
      );
      summary.costUsd += abstracted.costUsd;
      phrase = abstracted.phrase;
    } catch (err) {
      log.debug(`abstraction failed for ${target.id.slice(0, 8)}: ${String(err)}`);
      finish("transient_error", false);
      return;
    }
    if (!phrase) {
      finish("containment_rejected", false);
      return;
    }
    // Search (bounded), then read a few pages from distinct hosts.
    let hits: SearchHit[] = [];
    try {
      logEgress(deps.db, "curiosity-search", deps.searchProvider ?? "web-search", phrase, now);
      const first = await deps.search(phrase, Math.max(3, cfg.maxPagesPerTarget + 2));
      hits = first ?? [];
      if (hits.length === 0 && cfg.maxSearchesPerTarget >= 2) {
        const second = await deps.search(`${phrase} explained`, cfg.maxPagesPerTarget + 2);
        hits = second ?? [];
      }
    } catch (err) {
      log.debug(`search failed for ${target.id.slice(0, 8)}: ${String(err)}`);
      finish("transient_error", false, phrase);
      return;
    }
    const seenHosts = new Set<string>();
    const pages: Array<{ url: string; title?: string; text: string }> = [];
    for (const hit of hits) {
      if (pages.length >= cfg.maxPagesPerTarget) {
        break;
      }
      const host = hostOf(hit.url);
      if (!host || seenHosts.has(host) || hostBlocked(host, cfg.blockedDomains)) {
        return;
      }
      seenHosts.add(host);
      try {
        logEgress(deps.db, "curiosity-fetch", host, hit.url, now);
        const page = await deps.fetchPage(hit.url, cfg.blockedDomains);
        const text = page?.text?.trim() ?? hit.snippet?.trim() ?? "";
        if (text.length >= 200) {
          pages.push({ url: hit.url, title: page?.title ?? hit.title, text });
        }
      } catch {
        // one unreadable page is not an outcome
      }
    }
    if (pages.length === 0) {
      finish("no_results", target.attempts + 1 >= cfg.maxAttempts, phrase);
      return;
    }
    let distilled: Distilled | null = null;
    try {
      const r = await deps.llm(distillPrompt(target.description, pages));
      summary.costUsd += r.costUsd;
      distilled = parseDistilled(r.text);
    } catch (err) {
      log.debug(`distillation failed for ${target.id.slice(0, 8)}: ${String(err)}`);
      finish("transient_error", false, phrase);
      return;
    }
    if (!distilled || !findingIsVerified(distilled, floor)) {
      const last = target.attempts + 1 >= cfg.maxAttempts;
      finish(last ? "unanswered" : "inconclusive", last, phrase);
      if (last) {
        deps.onEvent?.("curiosity_stagnant");
      }
      return;
    }
    const sources = distilled.supportingSources
      .map((n) => pages[n - 1])
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ url: p.url, title: p.title ?? null }));
    const regionId =
      target.regionId ??
      (deps.embed
        ? await deps
            .embed(target.description)
            .then((e) => (e ? nearestRegion(deps.db, e) : null))
            .catch(() => null)
        : null);
    const chunkId = storeFinding(deps.db, {
      target,
      phrase,
      answer: distilled.answer,
      confidence: distilled.confidence,
      sources,
      hormonal: h,
      costUsd: costSoFar(),
      regionId,
      now,
    });
    finish("learned", true, phrase);
    summary.learned += 1;
    deps.onEvent?.("curiosity_progress");
    log.info(
      `learned on my own: "${target.description.slice(0, 80)}" (confidence ${distilled.confidence.toFixed(2)}, ${sources.length} source(s), chunk ${chunkId.slice(0, 12)})`,
    );
  }
}

function storeFinding(
  db: DatabaseSync,
  p: {
    target: { id: string; description: string };
    phrase: string;
    answer: string;
    confidence: number;
    sources: Array<{ url: string; title: string | null }>;
    hormonal: { dopamine: number; cortisol: number; oxytocin: number } | null;
    costUsd: number;
    regionId: string | null;
    now: number;
  },
): string {
  const chunkId = `fact_${crypto.randomUUID()}`;
  const text = `${p.target.description}\n${p.answer}`;
  const evidence = p.sources.map((s) => ({
    kind: "url",
    url: s.url,
    title: s.title,
    fetchedAt: p.now,
  }));
  db.exec("BEGIN");
  try {
    // Bitemporal supersession: an earlier answer to the same question keeps
    // its row but stops being current.
    const prior = db
      .prepare(
        `SELECT chunk_id FROM curiosity_findings WHERE target_id = ? AND chunk_id IS NOT NULL`,
      )
      .all(p.target.id) as unknown as Array<{ chunk_id: string }>;
    for (const row of prior) {
      db.prepare(
        `UPDATE chunks SET valid_time_end = ? WHERE id = ? AND valid_time_end IS NULL`,
      ).run(p.now, row.chunk_id);
      setChunkLifecycle(db, row.chunk_id, { lifecycle: "archived", updatedAt: p.now });
    }
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         importance_score, lifecycle, lifecycle_state, semantic_type, epistemic_layer, origin,
         evidence_refs, valid_time_start, transaction_time, access_count, last_accessed_at,
         created_at, updated_at)
       VALUES (?, ?, 'memory', 0, 0, ?, ?, 'pending', '[]', ?, 'generated', 'active', 'fact',
         'world_fact', 'curiosity', ?, ?, ?, 0, NULL, ?, ?)`,
    ).run(
      chunkId,
      `curiosity/${p.target.id}`,
      text,
      crypto.createHash("sha256").update(text).digest("hex"),
      Math.min(0.8, 0.3 + 0.5 * p.confidence),
      JSON.stringify(evidence),
      p.now,
      p.now,
      p.now,
      p.now,
    );
    db.prepare(
      `INSERT INTO curiosity_findings
         (id, target_id, question, query_phrase, answer, confidence, sources_json, hormonal_json,
          cost_usd, chunk_id, region_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      p.target.id,
      p.target.description,
      p.phrase,
      p.answer,
      p.confidence,
      JSON.stringify(p.sources),
      p.hormonal ? JSON.stringify(p.hormonal) : null,
      p.costUsd,
      chunkId,
      p.regionId,
      p.now,
    );
    // The system-prompt block voices this once, on the owner's next turn.
    const host = p.sources[0] ? (hostOf(p.sources[0].url) ?? "the web") : "the web";
    db.prepare(
      `INSERT INTO research_findings (id, target_id, finding, source_url, relevance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      p.target.id,
      `I looked into "${p.target.description.slice(0, 120)}": ${p.answer.slice(0, 240)} (${host})`,
      p.sources[0]?.url ?? null,
      p.confidence,
      p.now,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return chunkId;
}

// ── owner-facing reads and controls ─────────────────────────────────────────

export type CuriosityStatus = {
  enabled: boolean;
  /** Which config key turned it off, when disabled. */
  disabledBy: string | null;
  paused: boolean;
  searchConfigured: boolean;
  intervalMinutes: number;
  maxPerDay: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  today: { attempted: number; budget: number };
  openQuestions: number;
  totals: { learned: number; used: number; roi: number; costUsd: number };
  last30d: { learned: number; used: number; roi: number; costUsd: number };
};

export function curiosityStatus(
  db: DatabaseSync,
  cfg: Required<CuriosityResearchConfig>,
  opts: {
    searchConfigured: boolean;
    now?: number;
    hormonal?: { dopamine: number; cortisol: number } | null;
    disabledBy?: string | null;
  },
): CuriosityStatus {
  const now = opts.now ?? Date.now();
  const lastRun = Number(getMeta(db, META_LAST_RUN) ?? 0) || null;
  const h = opts.hormonal ?? null;
  const budget = Math.max(
    1,
    cfg.maxPerDay + (h && h.dopamine > 0.65 ? 2 : 0) - (h && h.cortisol > 0.65 ? 2 : 0),
  );
  let openQuestions = 0;
  try {
    openQuestions = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM curiosity_targets
            WHERE resolved_at IS NULL AND expires_at > ?
              AND (type = 'question' OR json_extract(metadata, '$.researchable') = 1)`,
        )
        .get(now) as { c: number }
    ).c;
  } catch {
    openQuestions = 0;
  }
  return {
    enabled: cfg.enabled,
    disabledBy: opts.disabledBy ?? null,
    paused: isCuriosityPaused(db),
    searchConfigured: opts.searchConfigured,
    intervalMinutes: cfg.intervalMinutes,
    maxPerDay: cfg.maxPerDay,
    lastRunAt: lastRun,
    nextRunAt: lastRun ? lastRun + cfg.intervalMinutes * 60 * 1000 : null,
    today: { attempted: Number(getMeta(db, metaDayKey(now)) ?? 0), budget },
    openQuestions,
    totals: curiosityUtility(db),
    last30d: curiosityUtility(db, now - 30 * 24 * 60 * 60 * 1000),
  };
}

export type CuriosityListing = {
  wondering: Array<{
    id: string;
    type: string;
    description: string;
    priority: number;
    createdAt: number;
    attempts: number;
    lastOutcome: string | null;
    source: string | null;
  }>;
  learned: Array<{
    id: string;
    question: string;
    answer: string;
    confidence: number;
    sources: Array<{ url: string; title: string | null }>;
    createdAt: number;
    usedCount: number;
    firstUsedAt: number | null;
    costUsd: number;
    chunkId: string | null;
    current: boolean;
  }>;
  closed: Array<{ id: string; description: string; outcome: string | null; resolvedAt: number }>;
};

export function listCuriosity(
  db: DatabaseSync,
  opts: { now?: number; limit?: number } = {},
): CuriosityListing {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 50;
  const wondering = (
    db
      .prepare(
        `SELECT id, type, description, priority, created_at, attempts, metadata
           FROM curiosity_targets
          WHERE resolved_at IS NULL AND expires_at > ?
            AND (type = 'question' OR json_extract(metadata, '$.researchable') = 1)
          ORDER BY priority DESC, created_at ASC LIMIT ?`,
      )
      .all(now, limit) as unknown as Array<{
      id: string;
      type: string;
      description: string;
      priority: number;
      created_at: number;
      attempts: number;
      metadata: string | null;
    }>
  ).map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(r.metadata ?? "{}") as Record<string, unknown>;
    } catch {
      meta = {};
    }
    return {
      id: r.id,
      type: r.type,
      description: r.description,
      priority: r.priority,
      createdAt: r.created_at,
      attempts: r.attempts,
      lastOutcome: typeof meta.researchOutcome === "string" ? meta.researchOutcome : null,
      source: typeof meta.source === "string" ? meta.source : null,
    };
  });
  let learned: CuriosityListing["learned"] = [];
  try {
    learned = (
      db
        .prepare(
          `SELECT f.id, f.question, f.answer, f.confidence, f.sources_json, f.created_at,
                  f.used_count, f.first_used_at, f.cost_usd, f.chunk_id,
                  (c.valid_time_end IS NULL) AS current
             FROM curiosity_findings f LEFT JOIN chunks c ON c.id = f.chunk_id
            ORDER BY f.created_at DESC LIMIT ?`,
        )
        .all(limit) as unknown as Array<{
        id: string;
        question: string;
        answer: string;
        confidence: number;
        sources_json: string;
        created_at: number;
        used_count: number;
        first_used_at: number | null;
        cost_usd: number;
        chunk_id: string | null;
        current: number | null;
      }>
    ).map((r) => {
      let sources: Array<{ url: string; title: string | null }> = [];
      try {
        sources = JSON.parse(r.sources_json) as typeof sources;
      } catch {
        sources = [];
      }
      return {
        id: r.id,
        question: r.question,
        answer: r.answer,
        confidence: r.confidence,
        sources,
        createdAt: r.created_at,
        usedCount: r.used_count,
        firstUsedAt: r.first_used_at,
        costUsd: r.cost_usd,
        chunkId: r.chunk_id,
        current: r.current !== 0,
      };
    });
  } catch {
    learned = [];
  }
  const closed = (
    db
      .prepare(
        `SELECT id, description, metadata, resolved_at FROM curiosity_targets
          WHERE resolved_at IS NOT NULL
            AND (type = 'question' OR json_extract(metadata, '$.researchable') = 1)
            AND json_extract(metadata, '$.researchOutcome') <> 'learned'
          ORDER BY resolved_at DESC LIMIT 20`,
      )
      .all() as unknown as Array<{
      id: string;
      description: string;
      metadata: string | null;
      resolved_at: number;
    }>
  ).map((r) => {
    let outcome: string | null = null;
    try {
      const m = JSON.parse(r.metadata ?? "{}") as Record<string, unknown>;
      outcome = typeof m.researchOutcome === "string" ? m.researchOutcome : null;
    } catch {
      outcome = null;
    }
    return { id: r.id, description: r.description, outcome, resolvedAt: r.resolved_at };
  });
  return { wondering, learned, closed };
}

/** The owner says "don't bother": the question closes and never comes back. */
export function dismissCuriosityTarget(db: DatabaseSync, id: string, now = Date.now()): boolean {
  const res = db
    .prepare(
      `UPDATE curiosity_targets
          SET resolved_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.researchOutcome', 'dismissed')
        WHERE id = ? AND resolved_at IS NULL`,
    )
    .run(now, id);
  return Number(res.changes) > 0;
}

/** The owner hands the agent a question to go and learn. */
export async function askCuriosity(
  db: DatabaseSync,
  question: string,
  embed: (text: string) => Promise<number[] | null>,
  now = Date.now(),
): Promise<string | null> {
  const ids = await insertNovelTargets(db, {
    targets: [
      {
        type: "question",
        description: question,
        priority: 0.95,
        metadata: { source: "owner" },
      },
    ],
    embed,
    now,
    maxOpen: 50,
  });
  return ids[0] ?? null;
}
