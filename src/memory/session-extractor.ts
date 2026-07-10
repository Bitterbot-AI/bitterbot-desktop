/**
 * Session Fact Extraction Pipeline
 *
 * Processes raw session transcripts through an LLM to extract structured,
 * atomic facts classified into four epistemic layers (inspired by Hindsight):
 *
 * - world_fact:   Objective knowledge (versions, configs, endpoints, names)
 * - experience:   Episodic events (what happened, causal sequences, outcomes)
 * - mental_model: Beliefs, reasoning frameworks, patterns the user expressed
 * - directive:    Standing instructions, preferences, hard rules from the user
 *
 * Also generates a session handover brief for seamless cross-session continuity.
 *
 * The extraction prompt is modulated by the current hormonal state:
 * - High cortisol → prioritize error/friction facts
 * - High oxytocin → prioritize relational facts
 * - High dopamine → prioritize achievement facts
 */

import type { SessionHandoverBrief } from "./session-handover.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeCanonicalKey } from "./canonical-facts.js";

const log = createSubsystemLogger("memory/session-extractor");

export type EpistemicLayer = "world_fact" | "experience" | "mental_model" | "directive";

/**
 * PLAN-24 HORMA Phase 0: a provenance pointer from a synthesized memory back to
 * its raw source. Session refs point at a line in the flattened session
 * transcript (resolved on demand by re-building the session entry); journal refs
 * point at an exact PLAN-16 event-journal row. Session extraction runs on
 * flattened transcript files with no run_id/seq, so the extractor only ever
 * emits `session` refs — journal refs are attached by callers that have a live
 * (runId, seq) cursor.
 */
export type EvidenceRef =
  | { kind: "session"; path: string; line: number }
  | { kind: "journal"; runId: string; seq: number };

export type ExtractedFact = {
  text: string;
  epistemicLayer: EpistemicLayer;
  confidence: number;
  semanticType: string;
  sessionId: string;
  /** Provenance pointers to the transcript lines this fact was derived from. */
  evidence: EvidenceRef[];
  /**
   * PLAN-33 Phase 2: set when the extractor judged this a canonical key-value
   * fact (stable ground truth the user treats as durable: repo names,
   * endpoints, identities, standing choices). The key is a validated dot-slug
   * ("project.repo") and the value is the exact atom ("github.com/org/repo").
   * Routed into the canonical ledger by the ingest loop — this is what makes
   * pinning automatic instead of something the user must ask for.
   */
  canonical?: { key: string; value: string };
};

/**
 * PLAN-34 Phase 1: an open user-answerable question (epistemic directive)
 * offered to the extractor. Deliberately called "open question" everywhere
 * in the prompt — "directive" already names an epistemic LAYER (user hard
 * rules) in the same prompt, and the two must not blur.
 */
export type OpenQuestion = { id: string; question: string };

/**
 * A validated candidate answer the extractor found in the transcript:
 * the id passed the supplied-set check, the quoted answer appears verbatim
 * in the cited USER-authored transcript lines, and the citations parse.
 */
export type DirectiveResolutionCandidate = {
  directiveId: string;
  answer: string;
  confidence: number;
  evidence: EvidenceRef[];
  /**
   * For which-is-current questions: the candidate value the extractor says
   * the user indicated. Untrusted here — the resolution layer only pins it
   * when it exactly matches one of the candidate values carried by the
   * directive itself, so an arbitrary or deictic quote can never become a
   * canonical value.
   */
  selectedValue?: string;
};

export type ExtractionResult = {
  facts: ExtractedFact[];
  handoverBrief: SessionHandoverBrief;
  processingTimeMs: number;
  /** PLAN-34 Phase 1: validated answers to open questions (usually empty). */
  resolutions: DirectiveResolutionCandidate[];
};

export type HormonalBias = {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
};

const EPISTEMIC_TO_SEMANTIC: Record<EpistemicLayer, string> = {
  world_fact: "fact",
  experience: "episode",
  mental_model: "insight",
  directive: "preference",
};

function buildHormonalGuidance(hormones?: HormonalBias): string {
  if (!hormones) {
    return "";
  }
  const lines: string[] = [];
  if (hormones.cortisol > 0.3) {
    lines.push(
      "- PRIORITY: Extract errors, frictions, and blockers encountered during this session.",
    );
  }
  if (hormones.dopamine > 0.3) {
    lines.push("- PRIORITY: Extract achievements, breakthroughs, and successful outcomes.");
  }
  if (hormones.oxytocin > 0.3) {
    lines.push(
      "- PRIORITY: Extract relational information, user preferences, and personal details shared.",
    );
  }
  return lines.length > 0
    ? `\n## Extraction Priority (hormonal modulation)\n${lines.join("\n")}\n`
    : "";
}

/**
 * Prefix each line of the transcript with an `L<n>:` marker so the extraction
 * LLM can cite the exact source line(s) for every fact (HORMA's `(D1:3)` turn
 * pointer trick). Line numbers are 1-based and index into this numbered view,
 * which `memory_expand` reproduces by re-building the session entry.
 */
function numberTranscriptLines(sessionContent: string): string {
  return sessionContent
    .split("\n")
    .map((line, i) => `L${i + 1}: ${line}`)
    .join("\n");
}

/**
 * PLAN-24 HORMA Phase 3: render the evolving "Learned Construction Rules" block.
 * These are natural-language rules the memory-architect loop has promoted from
 * contrastive construction failures (e.g. "preserve exact dates and relative
 * ordering"). Empty when no rules have been learned yet.
 */
function buildLearnedRules(learnedRules?: string[]): string {
  if (!learnedRules || learnedRules.length === 0) {
    return "";
  }
  const body = learnedRules.map((r) => `- ${r}`).join("\n");
  return `\n## Learned Construction Rules\nThese rules were learned from past extraction failures. Follow them carefully:\n${body}\n`;
}

/**
 * PLAN-34 Phase 1: render the Open Questions block plus its output-schema
 * and rules additions. Empty when no open questions exist — most cycles.
 */
function buildOpenQuestionsBlock(openQuestions?: OpenQuestion[]): {
  block: string;
  schemaField: string;
  rules: string;
} {
  if (!openQuestions || openQuestions.length === 0) {
    return { block: "", schemaField: "", rules: "" };
  }
  const list = openQuestions.map((q) => `- ${q.id}: ${q.question}`).join("\n");
  return {
    block:
      `\n## Open Questions\n` +
      `These are open questions this system previously asked the user (ids are opaque tokens). ` +
      `Check whether THIS transcript contains a user-authored answer to any of them.\n${list}\n`,
    schemaField: `,\n  "resolutions": [\n    { "id": "<open question id>", "answer": "verbatim answer atom quoted from the user's line", "lines": [42], "confidence": 0.0-1.0, "selectedValue": "<only for which-is-current questions: the exact candidate value the user indicated, copied verbatim from the question>" }\n  ]`,
    rules:
      `\n- **resolutions (usually empty):** resolve an open question ONLY when the USER (never the assistant) AFFIRMATIVELY answered it in this transcript. ` +
      `"answer" must quote the answer atom verbatim from ONE of the user's cited lines — never paraphrase, never stitch text from multiple lines. ` +
      `"lines" must cite the exact L<n> line(s) of the user's answer. ` +
      `NEVER resolve from a mention, negation, or quotation: "it is NOT X", "you asked about X?", or the user pasting third-party text containing X are not answers. ` +
      `Skip sarcasm, hypotheticals, jokes, and answers the user retracted later in the session. ` +
      `When the question offers two candidate values ("Which is current for <key>: A or B?"), also set "selectedValue" to the exact candidate the user indicated (copied verbatim from the question text), even when the user answered indirectly ("the first one"). ` +
      `Most sessions answer nothing: an empty "resolutions" list is the normal output.`,
  };
}

export function buildExtractionPrompt(
  sessionContent: string,
  maxFacts: number,
  hormones?: HormonalBias,
  learnedRules?: string[],
  openQuestions?: OpenQuestion[],
): string {
  const numbered = numberTranscriptLines(sessionContent);
  const oq = buildOpenQuestionsBlock(openQuestions);
  return `You are a memory extraction system. Analyze the following conversation transcript and extract structured facts.

The transcript is line-numbered (each line begins with \`L<n>:\`). For every fact you MUST cite the line number(s) it was derived from, so the fact can be traced back to its exact source.

## Task
1. Extract up to ${maxFacts} atomic facts from the conversation, classified into epistemic layers.
2. Generate a session handover brief summarizing the session state.

## Epistemic Layers
- **world_fact**: Objective knowledge — software versions, configuration values, API endpoints, hardware specs, names, dates, established technical facts.
- **experience**: Episodic events — what was attempted, what succeeded/failed, debugging steps taken, causal sequences.
- **mental_model**: Synthesized beliefs — user's reasoning patterns, architectural preferences, design principles expressed.
- **directive**: Hard rules — explicit instructions like "always do X", "never do Y", formatting requirements, workflow preferences.
${buildHormonalGuidance(hormones)}${oq.block}
## Output Format
Respond with ONLY a JSON object (no markdown fences):
{
  "facts": [
    { "text": "atomic fact statement", "layer": "world_fact|experience|mental_model|directive", "confidence": 0.0-1.0, "lines": [12, 13], "canonicalKey": "project.repo", "canonicalValue": "github.com/org/repo" }
  ]${oq.schemaField},
  "handover": {
    "purpose": "one-line session purpose",
    "milestones": ["completed milestone 1", "..."],
    "decisions": ["decision made and rationale", "..."],
    "blockers": ["current blocker or open question", "..."],
    "nextSteps": ["immediate next action", "..."],
    "entities": [
      { "name": "filename.ts or functionName() or CONFIG_KEY", "type": "file|function|variable|config|service|tool", "lastAction": "edited|debugged|created|discussed|configured" }
    ]
  }
}

## Rules
- Each fact must be a single, self-contained assertion. No compound statements.
- Facts must be extractable truths, not conversational filler.
- "lines" must list the 1-based \`L<n>\` line number(s) the fact came from (at least one). Cite the most specific lines, not the whole transcript.
- Confidence reflects how certain the fact is: 1.0 = explicitly stated, 0.5 = inferred.
- Prefer fewer high-quality facts over many low-quality ones.
- **canonicalKey/canonicalValue (optional, rare):** set these ONLY when the fact is stable key-value ground truth the user treats as durable and will reference across many future sessions — the project's repository, a service endpoint, a person's name/role, a standing tool or workflow choice. canonicalKey is a lowercase dot-slug that MUST start with one of exactly these category prefixes: identity. | project. | infra. | preference. | relationship. (any other prefix is discarded), e.g. "project.repo" or "identity.user_name". canonicalValue is the exact atom, copied verbatim (never paraphrase a URL, slug, version, or name). Most facts are NOT canonical — omit these fields for events, one-off details, and anything transient. NEVER emit canonical fields for: the current date/time; counts, metrics, or balances that drift on their own (clone counts, peer counts, open-item counts); observations about the assistant's own memory, performance, or incidents; status snapshots; or assertion-shaped claims whose value would be "true"/"false". Test: if the value could change within a month without anyone deciding to change it, it is NOT canonical. When the user corrects a previously-established fact, DO emit the canonical fields so the correction supersedes the old belief.
- The handover brief should let a new session pick up exactly where this one left off.
- The entities list should capture specific files, functions, variables, config keys, and services the user was working with — concrete referents that allow resolving references like "that file" or "the second parameter" in the next session. Focus on the 5-10 most recently touched entities.${oq.rules}
${buildLearnedRules(learnedRules)}
## Conversation Transcript
${numbered}`;
}

/**
 * Coerce the LLM's `lines` citation field into session EvidenceRefs. Tolerant of
 * missing/garbage citations (returns []), de-duplicates, and drops non-positive
 * line numbers. Caps at 8 refs so a fact that cites the whole transcript does
 * not bloat the row.
 */
function parseFactEvidence(rawLines: unknown, sessionId: string): EvidenceRef[] {
  if (!Array.isArray(rawLines)) {
    return [];
  }
  const seen = new Set<number>();
  const refs: EvidenceRef[] = [];
  for (const v of rawLines) {
    const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
    if (!Number.isFinite(n) || n < 1 || seen.has(n)) {
      continue;
    }
    seen.add(n);
    refs.push({ kind: "session", path: sessionId, line: n });
    if (refs.length >= 8) {
      break;
    }
  }
  return refs;
}

/**
 * PLAN-33 Phase 2: validate the LLM's optional canonical fields. The key must
 * normalize to a ledger slug and the value must be a non-empty atom; anything
 * else is silently dropped (the fact itself is still kept as a crystal) —
 * ledger hygiene beats recall here, since the dream-cycle promotion pass
 * (Phase 3) catches what the hot path misses.
 */
function parseCanonicalFields(
  rawKey: unknown,
  rawValue: unknown,
): { key: string; value: string } | undefined {
  if (typeof rawKey !== "string" || typeof rawValue !== "string") {
    return undefined;
  }
  const key = normalizeCanonicalKey(rawKey);
  const value = rawValue.trim();
  if (!key || !value || value.length > 500) {
    return undefined;
  }
  return { key, value };
}

/**
 * PLAN-34 Phase 1: resolve which speaker authored transcript line `n`
 * (1-based). Flattened session entries prefix each message's FIRST line
 * with `User: ` / `Assistant: `; continuation lines carry no prefix, so
 * walk upward to the nearest labeled line.
 */
function lineIsUserAuthored(transcriptLines: string[], n: number): boolean {
  for (let i = n - 1; i >= 0; i--) {
    const line = transcriptLines[i];
    if (line === undefined) {
      return false;
    }
    if (line.startsWith("User: ")) {
      return true;
    }
    if (line.startsWith("Assistant: ")) {
      return false;
    }
  }
  return false;
}

const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
/** Case-insensitive, whitespace-normalized comparison form. */
const matchForm = (s: string) => normalizeWs(s).toLowerCase();

/** Strip the flattening role prefix so it can never be part of a "quote". */
const stripRolePrefix = (line: string) => line.replace(/^(User|Assistant): /, "");

/**
 * Trivially-contained strings that would validate against almost any user
 * line. An answer this thin can never resolve a question mechanically.
 */
const TRIVIAL_ANSWERS = new Set([
  "the",
  "a",
  "an",
  "it",
  "that",
  "this",
  "one",
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "first",
  "second",
  "latter",
  "former",
]);

/**
 * Negators that, appearing immediately before the quoted answer in the
 * cited line, mark it as a MENTION ("the repo is NOT beta"), not an
 * assertion. Deterministic and conservative: only the few tokens directly
 * preceding the match are inspected, so "it's not alpha, it's beta" still
 * validates beta while rejecting alpha.
 */
const NEGATORS = new Set([
  "not",
  "never",
  "no",
  "without",
  "stopped",
  "dropped",
  "deprecated",
  "retired",
  "instead",
  "rather",
]);
const NEGATOR_WINDOW_TOKENS = 3;

/** True when `line` contains `answer` NOT preceded by a nearby negator. */
function lineAsserts(lineForm: string, answerForm: string): boolean {
  let from = 0;
  while (true) {
    const idx = lineForm.indexOf(answerForm, from);
    if (idx === -1) {
      return false;
    }
    const prefixTokens = lineForm
      .slice(0, idx)
      .split(/\s+/)
      .filter(Boolean)
      .slice(-NEGATOR_WINDOW_TOKENS)
      .map((t) => t.replace(/[^a-z']/g, ""));
    const negated = prefixTokens.some((t) => NEGATORS.has(t) || t.endsWith("n't"));
    if (!negated) {
      return true;
    }
    from = idx + 1;
  }
}

/**
 * PLAN-34 Phase 1: validate the LLM's `resolutions` output. Hard checks,
 * all fail-closed: id must be in the supplied open-question set; the quoted
 * answer must appear verbatim (whitespace-normalized, case-insensitive)
 * inside a SINGLE cited USER-authored transcript line with its role prefix
 * stripped — never across a concatenation of lines, which would admit
 * strings the user never uttered. Trivial quotes are rejected outright.
 * What this layer deliberately does NOT decide: whether the quote is an
 * assertion rather than a mention/negation — that judgment stays with the
 * extractor's rules, and the canonical ledger is protected downstream by
 * the candidate-set constraint (a pin must match a value actually in
 * dispute) plus trust tiers.
 */
function parseResolutions(
  rawResolutions: unknown,
  sessionId: string,
  openQuestionIds: ReadonlySet<string>,
  transcriptLines: string[],
): DirectiveResolutionCandidate[] {
  if (!Array.isArray(rawResolutions) || openQuestionIds.size === 0) {
    return [];
  }
  const out: DirectiveResolutionCandidate[] = [];
  const seenIds = new Set<string>();
  for (const r of rawResolutions as Array<{
    id?: unknown;
    answer?: unknown;
    lines?: unknown;
    confidence?: unknown;
    selectedValue?: unknown;
  }>) {
    if (typeof r?.id !== "string" || !openQuestionIds.has(r.id) || seenIds.has(r.id)) {
      continue;
    }
    if (typeof r.answer !== "string") {
      continue;
    }
    const answer = r.answer.trim();
    if (!answer || answer.length < 3 || answer.length > 500) {
      continue;
    }
    const answerForm = matchForm(answer);
    if (TRIVIAL_ANSWERS.has(answerForm)) {
      continue;
    }
    const evidence = parseFactEvidence(r.lines, sessionId);
    if (evidence.length === 0) {
      continue;
    }
    // Verbatim containment within ONE user-authored cited line (role
    // prefix stripped). Joining cited lines would accept stitched strings
    // the user never uttered, and a match directly preceded by a negator
    // is a mention, not an answer.
    const contained = evidence.some(
      (e) =>
        e.kind === "session" &&
        lineIsUserAuthored(transcriptLines, e.line) &&
        lineAsserts(matchForm(stripRolePrefix(transcriptLines[e.line - 1] ?? "")), answerForm),
    );
    if (!contained) {
      continue;
    }
    seenIds.add(r.id);
    out.push({
      directiveId: r.id,
      answer,
      confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.5,
      evidence,
      ...(typeof r.selectedValue === "string" && r.selectedValue.trim().length > 0
        ? { selectedValue: r.selectedValue.trim().slice(0, 500) }
        : {}),
    });
  }
  return out;
}

function parseExtractionResponse(
  raw: string,
  sessionId: string,
  openQuestionIds?: ReadonlySet<string>,
  transcriptLines?: string[],
): {
  facts: ExtractedFact[];
  handover: SessionHandoverBrief;
  resolutions: DirectiveResolutionCandidate[];
} | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      facts?: Array<{
        text?: string;
        layer?: string;
        confidence?: number;
        lines?: unknown;
        canonicalKey?: unknown;
        canonicalValue?: unknown;
      }>;
      resolutions?: unknown;
      handover?: {
        purpose?: string;
        milestones?: string[];
        decisions?: string[];
        blockers?: string[];
        nextSteps?: string[];
      };
    };

    if (!parsed.facts || !Array.isArray(parsed.facts)) {
      return null;
    }

    const validLayers = new Set<string>(["world_fact", "experience", "mental_model", "directive"]);

    const facts: ExtractedFact[] = parsed.facts
      .filter(
        (f) =>
          typeof f.text === "string" &&
          f.text.length > 0 &&
          typeof f.layer === "string" &&
          validLayers.has(f.layer),
      )
      .map((f) => ({
        text: f.text!,
        epistemicLayer: f.layer as EpistemicLayer,
        confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.7,
        semanticType: EPISTEMIC_TO_SEMANTIC[f.layer as EpistemicLayer] ?? "general",
        sessionId,
        evidence: parseFactEvidence(f.lines, sessionId),
        canonical: parseCanonicalFields(f.canonicalKey, f.canonicalValue),
      }));

    const h = parsed.handover;

    // Parse entity registry from LLM output
    const rawEntities = Array.isArray((h as Record<string, unknown>)?.entities)
      ? ((h as Record<string, unknown>).entities as Array<{
          name?: string;
          type?: string;
          lastAction?: string;
        }>)
      : [];
    const entities = rawEntities
      .filter((e) => typeof e?.name === "string" && e.name.length > 0)
      .map((e) => ({
        name: e.name!,
        type: typeof e.type === "string" ? e.type : "unknown",
        lastAction: typeof e.lastAction === "string" ? e.lastAction : "discussed",
      }))
      .slice(0, 10);

    const handover: SessionHandoverBrief = {
      sessionId,
      purpose: typeof h?.purpose === "string" ? h.purpose : "Session purpose not determined",
      milestones: Array.isArray(h?.milestones)
        ? h.milestones.filter((s) => typeof s === "string")
        : [],
      decisions: Array.isArray(h?.decisions)
        ? h.decisions.filter((s) => typeof s === "string")
        : [],
      blockers: Array.isArray(h?.blockers) ? h.blockers.filter((s) => typeof s === "string") : [],
      nextSteps: Array.isArray(h?.nextSteps)
        ? h.nextSteps.filter((s) => typeof s === "string")
        : [],
      entities,
      timestamp: Date.now(),
    };

    const resolutions =
      openQuestionIds && transcriptLines
        ? parseResolutions(parsed.resolutions, sessionId, openQuestionIds, transcriptLines)
        : [];

    return { facts, handover, resolutions };
  } catch {
    return null;
  }
}

/**
 * Extract structured facts and a handover brief from a session transcript.
 *
 * @param sessionContent  The raw session text (concatenated user/assistant messages)
 * @param sessionId       Unique identifier for the session (typically the file path)
 * @param llmCall         Function to call the LLM: (prompt) => response
 * @param maxFacts        Maximum facts to extract (default 20)
 * @param hormones        Current hormonal state for extraction bias (optional)
 * @returns Extraction result with facts and handover, or null on LLM failure
 */
export async function extractSessionFacts(
  sessionContent: string,
  sessionId: string,
  llmCall: (prompt: string) => Promise<string>,
  maxFacts = 20,
  hormones?: HormonalBias,
  learnedRules?: string[],
  openQuestions?: OpenQuestion[],
): Promise<ExtractionResult | null> {
  const start = Date.now();

  const prompt = buildExtractionPrompt(
    sessionContent,
    maxFacts,
    hormones,
    learnedRules,
    openQuestions,
  );

  let response: string;
  try {
    response = await llmCall(prompt);
  } catch (err) {
    // The LLM call failing (network/auth/overload) means this session's facts
    // are silently never extracted. Surface it instead of returning null mute.
    log.warn(`session fact extraction LLM call failed for ${sessionId}: ${String(err)}`);
    return null;
  }

  const openQuestionIds = new Set((openQuestions ?? []).map((q) => q.id));
  const parsed = parseExtractionResponse(
    response,
    sessionId,
    openQuestionIds,
    sessionContent.split("\n"),
  );
  if (!parsed) {
    log.debug(`session fact extraction: unparseable LLM response for ${sessionId}`);
    return null;
  }

  return {
    facts: parsed.facts.slice(0, maxFacts),
    handoverBrief: parsed.handover,
    processingTimeMs: Date.now() - start,
    resolutions: parsed.resolutions,
  };
}

export { EPISTEMIC_TO_SEMANTIC };
