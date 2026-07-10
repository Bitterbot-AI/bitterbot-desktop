/**
 * PLAN-34 Phase 1: apply validated open-question answers found by the
 * session extractor, and finalize the two-tier resolution state machine.
 *
 * The loop this closes: canonical-ledger conflicts (and the existing
 * contradiction/knowledge-gap producers) create epistemic directives ->
 * `getDirectivesForSession` injects them as `[question]` lines -> the user
 * answers in conversation -> the extraction cycle offers the open questions
 * to the extractor, which quotes the user's answer with line citations ->
 * this module marks the directive answered, stores the answer as a
 * world_fact crystal with evidence, and routes canonical-shaped answers
 * through the PLAN-33 reconciler as NORMAL extraction-tier proposals
 * (subject to trust tiers — an extraction answer can corroborate or
 * supersede background beliefs but never overwrite a deliberate pin) ->
 * the NEXT extraction cycle sets resolved_at if the answer survived
 * uncontradicted. The question is never asked again.
 *
 * Called from `MemoryIndexManager.runSessionExtraction` for FIRST-PARTY
 * sessions only (session-trust gating happens at the call site, next to
 * the identical gates for directive-preferences and canonical pins).
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { CanonicalFactsStore } from "./canonical-facts.js";
import type { EpistemicDirective, EpistemicDirectiveEngine } from "./epistemic-directives.js";
import type { DirectiveResolutionCandidate } from "./session-extractor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { USER_ANSWERABLE_TYPES } from "./epistemic-directives.js";

const log = createSubsystemLogger("memory/directive-resolution");

/** Minimum extraction confidence for an answer to mark a question answered. */
export const ANSWER_CONFIDENCE_FLOOR = 0.75;
/** Higher floor for routing an answer into the canonical ledger. */
export const CANONICAL_ANSWER_FLOOR = 0.8;

const CANONICAL_TAG_PREFIX = "canonical:";
const CANDIDATE_TAG_PREFIX = "candidate:";

/** The canonical-ledger key a conflict directive adjudicates, if any. */
export function canonicalKeyForDirective(d: { sourceEntityIds: string[] }): string | null {
  const tag = d.sourceEntityIds.find((s) => s.startsWith(CANONICAL_TAG_PREFIX));
  return tag ? tag.slice(CANONICAL_TAG_PREFIX.length) : null;
}

/** The candidate values a conflict directive adjudicates between. */
export function candidateValuesForDirective(d: { sourceEntityIds: string[] }): string[] {
  return d.sourceEntityIds
    .filter((s) => s.startsWith(CANDIDATE_TAG_PREFIX))
    .map((s) => s.slice(CANDIDATE_TAG_PREFIX.length));
}

/**
 * The value a canonical conflict answer may pin: it must EXACTLY equal one
 * of the candidate values the question adjudicated (the extractor's
 * selectedValue mapping first, then the verbatim quote itself). Anything
 * else — deictic replies ("the first one"), negated mentions, stitched or
 * hallucinated strings — never reaches the ledger; the question still gets
 * answered, the ledger just doesn't move.
 */
export function pinnableCandidateValue(
  d: { sourceEntityIds: string[] },
  res: { answer: string; selectedValue?: string },
): string | null {
  const candidates = candidateValuesForDirective(d);
  if (candidates.length === 0) {
    return null;
  }
  for (const proposed of [res.selectedValue, res.answer]) {
    if (typeof proposed !== "string") {
      continue;
    }
    const match = candidates.find((c) => c.trim() === proposed.trim());
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

export function applyDirectiveResolutions(params: {
  db: DatabaseSync;
  engine: EpistemicDirectiveEngine;
  canonicalStore: CanonicalFactsStore | null;
  resolutions: DirectiveResolutionCandidate[];
  /** Transcript path — becomes the answer crystal's path (provenance). */
  sessionPath: string;
  now: number;
}): { answered: number; pinned: number } {
  let answered = 0;
  let pinned = 0;
  for (const res of params.resolutions) {
    if (res.confidence < ANSWER_CONFIDENCE_FLOOR) {
      continue;
    }
    const directive = params.engine.getDirective(res.directiveId);
    // Only user-answerable questions resolve this way; late answers to
    // expired questions still count, already-resolved ones never re-resolve.
    if (
      !directive ||
      directive.resolvedAt !== null ||
      !USER_ANSWERABLE_TYPES.has(directive.directiveType)
    ) {
      continue;
    }
    // For which-is-current questions the effective answer is the candidate
    // value the user picked (when it validates); storing it as the
    // resolution keeps finalize's ledger-vs-resolution survival check
    // coherent with what was actually pinned.
    const key = canonicalKeyForDirective(directive);
    const pinValue = pinnableCandidateValue(directive, res);
    const effectiveAnswer = pinValue ?? res.answer;
    if (!params.engine.markAnswered(directive.id, effectiveAnswer)) {
      continue;
    }
    answered++;

    // Store the answer as a world_fact crystal with the transcript evidence,
    // mirroring the extraction ingest insert shape — this is what makes the
    // answer retrievable forever.
    const crystalId = `fact_${crypto.randomUUID()}`;
    const answerText = `${directive.question} — ${effectiveAnswer}`;
    try {
      params.db
        .prepare(
          `INSERT OR IGNORE INTO chunks (id, path, source, start_line, end_line, text, hash,
           model, embedding,
           importance_score, lifecycle, semantic_type, epistemic_layer, evidence_refs,
           access_count, last_accessed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crystalId,
          params.sessionPath,
          "sessions",
          0,
          0,
          answerText,
          crypto.createHash("sha256").update(answerText).digest("hex"),
          "pending",
          "[]",
          res.confidence,
          "generated",
          "fact",
          "world_fact",
          JSON.stringify(res.evidence),
          0,
          null,
          params.now,
          params.now,
        );
    } catch (err) {
      log.debug(`answer crystal insert failed: ${String(err)}`);
    }

    // Canonical-shaped answers route through the reconciler at extraction
    // tier with the raised floor — as normal proposals subject to trust
    // tiers, never a special path. Additionally CANDIDATE-CONSTRAINED
    // (Phase 1 adversarial pass): the pinned value must exactly equal one
    // of the two values the question adjudicated, so a mention, negation,
    // deictic reply, or hallucinated string can never move the ledger. A
    // tier rejection here remains correct behavior (deliberate pins outrank
    // conversational answers).
    if (
      key &&
      pinValue !== null &&
      params.canonicalStore &&
      res.confidence >= CANONICAL_ANSWER_FLOOR
    ) {
      const pinResult = params.canonicalStore.pin({
        key,
        value: pinValue,
        category: key.split(".")[0],
        confidence: Math.min(res.confidence, 0.85),
        source: "extraction",
        evidenceChunkIds: [crystalId],
      });
      if (pinResult.op !== "rejected") {
        pinned++;
        log.debug(`open-question answer pinned (${pinResult.op}): [${key}]`);
      }
    }
  }
  if (answered > 0) {
    log.info(`directive resolution: ${answered} open question(s) answered, ${pinned} pinned`);
  }
  return { answered, pinned };
}

/**
 * Tier 2 of the two-tier resolution: resolve directives answered before
 * this extraction run whose answers survived. A canonical-backed answer is
 * contradicted when the ledger's current value moved away from it.
 */
export function finalizeAnsweredDirectives(params: {
  engine: EpistemicDirectiveEngine;
  canonicalStore: CanonicalFactsStore | null;
  cutoffTs: number;
}): number {
  return params.engine.finalizeAnswered(params.cutoffTs, (d: EpistemicDirective) => {
    const key = canonicalKeyForDirective(d);
    if (!key || !params.canonicalStore || d.resolution == null) {
      return false;
    }
    const current = params.canonicalStore.get(key);
    return current !== null && current.value !== d.resolution;
  });
}
