/**
 * PLAN-24 HORMA Phase 3: the self-evolving memory architect.
 *
 * HORMA's recursive skill refinement (Eq. 5): the memory-construction prompt is
 * not hand-designed — it evolves. We harvest `construction_feedback` (the
 * Phase 1 blame router's exogenous verdicts + the Phase 2 contrastive corpus),
 * run one "textual gradient descent" step (an LLM proposes amended natural-
 * language rules from the failures), validate the candidates against held-out
 * sessions, and promote only the ones that do not regress extraction quality.
 * Promoted rules are injected into the extraction prompt (`buildExtractionPrompt`).
 *
 * The validation gate is what bitterbot has and HORMA lacks: a rule can only land
 * if re-extracting held-out sessions with it does not lose faithful, cited facts.
 *
 * LLM and extraction are injected, so the harvest / propose / validate / promote
 * logic is unit-testable without a live model.
 */
import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { scoreCitationSupport } from "./evidence-expand.js";
import { type HormonalBias, extractSessionFacts } from "./session-extractor.js";

const log = createSubsystemLogger("memory/architect");

export type ConstructionRule = {
  id: string;
  ruleText: string;
  category: string | null;
  status: string;
  source: string;
  version: number;
  ci95Low: number | null;
  birthDopamine: number | null;
  birthCortisol: number | null;
  birthOxytocin: number | null;
};

export type ConstructionFeedbackRecord = {
  comparisonType: string;
  question: string;
  terms?: string[];
  rootCauseSummary?: string;
};

export type RuleCandidate = { ruleText: string; category?: string };

export type HeldOutSession = { id: string; content: string };

// ── Rule store ──────────────────────────────────────────────────────────────

function rowToRule(r: Record<string, unknown>): ConstructionRule {
  return {
    id: r.id as string,
    ruleText: r.rule_text as string,
    category: (r.category as string | null) ?? null,
    status: r.status as string,
    source: r.source as string,
    version: r.version as number,
    ci95Low: (r.ci95_low as number | null) ?? null,
    birthDopamine: (r.birth_dopamine as number | null) ?? null,
    birthCortisol: (r.birth_cortisol as number | null) ?? null,
    birthOxytocin: (r.birth_oxytocin as number | null) ?? null,
  };
}

export function loadActiveRules(db: DatabaseSync, limit = 24): ConstructionRule[] {
  try {
    const rows = db
      .prepare(
        `SELECT * FROM construction_rules WHERE status = 'active'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToRule);
  } catch {
    return [];
  }
}

/** Just the rule texts, for injection into the extraction prompt. */
export function activeRuleTexts(db: DatabaseSync, limit = 24): string[] {
  return loadActiveRules(db, limit).map((r) => r.ruleText);
}

export function insertRule(
  db: DatabaseSync,
  rule: RuleCandidate & {
    ci95Low?: number;
    hormones?: HormonalBias;
    source?: string;
    now?: number;
  },
): string {
  const id = `crule_${crypto.randomUUID()}`;
  const now = rule.now ?? Date.now();
  db.prepare(
    `INSERT INTO construction_rules
       (id, rule_text, category, status, source, version, ci95_low,
        birth_dopamine, birth_cortisol, birth_oxytocin, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    rule.ruleText,
    rule.category ?? null,
    rule.source ?? "textgrad",
    rule.ci95Low ?? null,
    rule.hormones?.dopamine ?? null,
    rule.hormones?.cortisol ?? null,
    rule.hormones?.oxytocin ?? null,
    now,
    now,
  );
  return id;
}

/** Manual rollback (there is no auto-rollback — a regressed rule is retired here). */
export function retireRule(db: DatabaseSync, id: string): void {
  db.prepare(`UPDATE construction_rules SET status = 'retired', updated_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

export function countActiveRules(db: DatabaseSync): number {
  try {
    const r = db
      .prepare(`SELECT COUNT(*) AS c FROM construction_rules WHERE status = 'active'`)
      .get() as { c: number };
    return r.c;
  } catch {
    return 0;
  }
}

// ── Feedback harvest ─────────────────────────────────────────────────────────

export function harvestConstructionFeedback(
  db: DatabaseSync,
  opts?: { sinceTs?: number; limit?: number },
): ConstructionFeedbackRecord[] {
  try {
    const rows = db
      .prepare(
        `SELECT metadata FROM memory_audit_log
         WHERE event = 'construction_feedback' AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(opts?.sinceTs ?? 0, opts?.limit ?? 100) as Array<{ metadata: string | null }>;
    const out: ConstructionFeedbackRecord[] = [];
    for (const row of rows) {
      try {
        const m = JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
        out.push({
          comparisonType: (m.comparison_type as string) ?? "exogenous",
          question: (m.question as string) ?? (Array.isArray(m.terms) ? m.terms.join(" ") : ""),
          terms: Array.isArray(m.terms) ? (m.terms as string[]) : undefined,
          rootCauseSummary: m.root_cause_summary as string | undefined,
        });
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Textual-gradient propose step ────────────────────────────────────────────

export function buildProposePrompt(
  feedback: ConstructionFeedbackRecord[],
  existingRules: string[],
): string {
  const fb = feedback
    .slice(0, 30)
    .map(
      (f, i) =>
        `${i + 1}. [${f.comparisonType}] question: "${f.question}"${f.rootCauseSummary ? `\n   root cause: ${f.rootCauseSummary}` : ""}`,
    )
    .join("\n");
  const existing =
    existingRules.length > 0 ? existingRules.map((r) => `- ${r}`).join("\n") : "(none yet)";
  return `You improve a memory-extraction system by writing rules for how facts should be extracted from conversation transcripts.

Below are recall FAILURES where the answer was in the raw conversation but the extracted memory could not answer it — i.e. memory construction lost or distorted the fact.

## Failures
${fb}

## Existing construction rules
${existing}

## Your job
Propose 1-4 NEW, general, natural-language rules that would have prevented these failures (do not duplicate existing rules). Each rule must be a concrete instruction to the extractor (e.g. "Always record exact dates and pre-compute relative ordering between events"). Tie each rule to a failure class, not a single example.

Respond with ONLY a JSON array (no markdown fences):
[ { "rule": "the instruction", "category": "temporal|identity|aggregation|negative-evidence|other" } ]`;
}

export function parseProposedRules(raw: string): RuleCandidate[] {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: RuleCandidate[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const o = item as Record<string, unknown>;
      const text = typeof o.rule === "string" ? o.rule.trim() : "";
      if (text.length >= 8 && !seen.has(text.toLowerCase())) {
        seen.add(text.toLowerCase());
        out.push({
          ruleText: text,
          category: typeof o.category === "string" ? o.category : undefined,
        });
      }
      if (out.length >= 4) {
        break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Validation gate ──────────────────────────────────────────────────────────

/** Count facts whose citation actually supports them (faithful coverage). */
function faithfulCount(
  facts: Array<{ text: string; evidence: Array<{ kind: string }> }>,
  contentLines: string[],
): number {
  let n = 0;
  for (const f of facts) {
    const s = scoreCitationSupport(
      f.text,
      f.evidence as Parameters<typeof scoreCitationSupport>[1],
      contentLines,
    );
    if (s !== null && s >= 0.5) {
      n++;
    }
  }
  return n;
}

/** Paired bootstrap CI on per-session deltas (new - old). Pure. */
export function pairedBootstrap(
  deltas: number[],
  iterations = 1000,
  rng: () => number = Math.random,
): { meanDelta: number; ci95Low: number } {
  const n = deltas.length;
  if (n === 0) {
    return { meanDelta: 0, ci95Low: 0 };
  }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const observed = mean(deltas);
  const resamples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += deltas[Math.floor(rng() * n)] ?? 0;
    }
    resamples.push(sum / n);
  }
  resamples.sort((a, b) => a - b);
  const ci95Low = resamples[Math.floor(0.025 * iterations)] ?? observed;
  return { meanDelta: observed, ci95Low };
}

export type ValidationResult = {
  accepted: boolean;
  meanDelta: number;
  ci95Low: number;
  nSessions: number;
};

/**
 * Re-extract each held-out session under the baseline rules and under
 * baseline+candidates, and accept the candidate batch only if it does not
 * regress faithful-fact coverage (paired bootstrap CI on the per-session delta
 * is not significantly negative). This is the guardrail HORMA lacks.
 */
export async function validateCandidates(params: {
  llmCall: (prompt: string) => Promise<string>;
  heldOut: HeldOutSession[];
  baselineRules: string[];
  candidates: RuleCandidate[];
  hormones?: HormonalBias;
  maxFacts?: number;
  iterations?: number;
  rng?: () => number;
}): Promise<ValidationResult> {
  const { llmCall, heldOut, baselineRules, candidates } = params;
  if (heldOut.length === 0 || candidates.length === 0) {
    return { accepted: false, meanDelta: 0, ci95Low: 0, nSessions: 0 };
  }
  const withCandidates = [...baselineRules, ...candidates.map((c) => c.ruleText)];
  const deltas: number[] = [];
  for (const session of heldOut) {
    const lines = session.content.split("\n");
    const base = await extractSessionFacts(
      session.content,
      session.id,
      llmCall,
      params.maxFacts ?? 20,
      params.hormones,
      baselineRules,
    );
    const cand = await extractSessionFacts(
      session.content,
      session.id,
      llmCall,
      params.maxFacts ?? 20,
      params.hormones,
      withCandidates,
    );
    if (!base || !cand) {
      continue;
    }
    deltas.push(faithfulCount(cand.facts, lines) - faithfulCount(base.facts, lines));
  }
  const { meanDelta, ci95Low } = pairedBootstrap(deltas, params.iterations ?? 1000, params.rng);
  // Accept when not significantly worse and at least break-even on average.
  const accepted = deltas.length > 0 && meanDelta >= 0 && ci95Low > -1;
  return { accepted, meanDelta, ci95Low, nSessions: deltas.length };
}

// ── Orchestrating cycle ──────────────────────────────────────────────────────

export type ArchitectCycleResult = {
  ran: boolean;
  harvested: number;
  proposed: number;
  promoted: number;
  reason?: string;
};

export async function runArchitectCycle(params: {
  db: DatabaseSync;
  llmCall: (prompt: string) => Promise<string>;
  heldOut: HeldOutSession[];
  hormones?: HormonalBias;
  minFeedback?: number;
  sinceTs?: number;
  rng?: () => number;
}): Promise<ArchitectCycleResult> {
  const { db, llmCall } = params;
  const feedback = harvestConstructionFeedback(db, { sinceTs: params.sinceTs ?? 0, limit: 100 });
  if (feedback.length < (params.minFeedback ?? 5)) {
    return {
      ran: false,
      harvested: feedback.length,
      proposed: 0,
      promoted: 0,
      reason: "insufficient-feedback",
    };
  }

  const existing = activeRuleTexts(db);
  let candidates: RuleCandidate[];
  try {
    const raw = await llmCall(buildProposePrompt(feedback, existing));
    candidates = parseProposedRules(raw);
  } catch (err) {
    return {
      ran: true,
      harvested: feedback.length,
      proposed: 0,
      promoted: 0,
      reason: `propose-failed: ${String(err)}`,
    };
  }
  // Drop near-duplicates of existing rules.
  const existingLower = new Set(existing.map((r) => r.toLowerCase()));
  candidates = candidates.filter((c) => !existingLower.has(c.ruleText.toLowerCase()));
  if (candidates.length === 0) {
    return {
      ran: true,
      harvested: feedback.length,
      proposed: 0,
      promoted: 0,
      reason: "no-novel-candidates",
    };
  }

  const validation = await validateCandidates({
    llmCall,
    heldOut: params.heldOut,
    baselineRules: existing,
    candidates,
    hormones: params.hormones,
    rng: params.rng,
  });

  if (!validation.accepted) {
    log.debug(
      `architect: ${candidates.length} candidates rejected (meanDelta=${validation.meanDelta.toFixed(2)}, ci95Low=${validation.ci95Low.toFixed(2)})`,
    );
    return {
      ran: true,
      harvested: feedback.length,
      proposed: candidates.length,
      promoted: 0,
      reason: "validation-rejected",
    };
  }

  for (const c of candidates) {
    insertRule(db, {
      ...c,
      ci95Low: validation.ci95Low,
      hormones: params.hormones,
      source: "textgrad",
    });
  }
  log.info(
    `architect: promoted ${candidates.length} construction rule(s) (ci95Low=${validation.ci95Low.toFixed(2)})`,
  );
  return {
    ran: true,
    harvested: feedback.length,
    proposed: candidates.length,
    promoted: candidates.length,
  };
}
