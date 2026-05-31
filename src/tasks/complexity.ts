/**
 * Prompt complexity appraisal (PLAN-22 Phase 1, Affective Goal Drive).
 *
 * Pure, side-effect-free Stage-1 of the FrugalGPT-style cascade described
 * in PLAN-22. Given an inbound user prompt and (optionally) a snapshot of
 * the affective modulators, it produces a {@link ComplexityVerdict}: a raw
 * heuristic score in [0,1], the (hormonally modulated) decision thresholds,
 * and a tier of `inline` / `gray` / `goal`.
 *
 * The gray band is deliberately *not* resolved here - it returns
 * `needsLlm: true` so the caller (Phase 2 `auto-initiate`) can consult the
 * temp=0 Judge only when the cheap heuristic is genuinely ambiguous. The
 * common trivial and obviously-large cases never pay for an LLM round-trip.
 *
 * Design invariants (asserted by the tests):
 *   - The scorer is pure: same input -> same output, no I/O, no clock.
 *   - Modulation shifts the *thresholds*, never the raw text score, and the
 *     shifted thresholds are clamped to fixed rails so behaviour stays
 *     bounded and testable regardless of hormonal state.
 *   - A long-but-simple prompt (a pasted log or fenced code block) must not
 *     be pushed into the goal tier by sheer length: prose length, not raw
 *     length, drives the length signal. (PLAN-22 Addendum item 4.)
 */

export type ComplexityTier = "inline" | "gray" | "goal";

/**
 * Affective modulators consumed by threshold modulation. Kept minimal and
 * decoupled from `HormonalState` on purpose so this module stays pure and
 * trivially testable; Phase 2 adapts the live snapshot into this shape.
 * All fields are 0..1; omitted fields are treated as the neutral baseline.
 */
export interface ComplexityModulators {
  /** Stress/threat. High cortisol narrows scope: raises the thresholds. */
  cortisol?: number;
  /** Reward/novelty. High dopamine lowers the thresholds (more eager). */
  dopamine?: number;
  /** GCCRF curiosity drive. High curiosity lowers the thresholds. */
  curiosity?: number;
}

/** Cheap textual features extracted from the prompt. */
export interface ComplexitySignals {
  /** Prose character count (excludes fenced code / pasted-log lines). */
  proseChars: number;
  /** Count of imperative/action verbs (implement, refactor, deploy, ...). */
  actionVerbs: number;
  /** Sequencing markers ("then", "after that", "first", numbered steps). */
  sequencingMarkers: number;
  /** Conjoined or enumerated sub-requests ("and", bullets, numbered list). */
  enumerationItems: number;
  /** Multi-deliverable / cross-cutting artifact hints (PR, tests, across packages). */
  artifactHints: number;
  /** Fraction of the prompt that is fenced code or log-like, 0..1. */
  pastedFraction: number;
}

export interface ComplexityVerdict {
  tier: ComplexityTier;
  /** Raw heuristic score from the text alone, 0..1. */
  score: number;
  /** Decision thresholds after hormonal modulation (clamped to rails). */
  thresholds: { low: number; high: number };
  /** True iff `tier === "gray"`: the caller should resolve via the Judge. */
  needsLlm: boolean;
  signals: ComplexitySignals;
  /** Human-readable contributors, for telemetry and debuggability. */
  reasons: string[];
}

// --- Tunables (deterministic; tests assert against these) ---------------

/** Baseline gray band: score < low -> inline; score >= high -> goal. */
const BASE_LOW = 0.35;
const BASE_HIGH = 0.52;

/** Hard rails. Modulation may move thresholds only within these bounds. */
const RAIL_LOW_MIN = 0.2;
const RAIL_LOW_MAX = 0.45;
const RAIL_HIGH_MIN = 0.48;
const RAIL_HIGH_MAX = 0.78;

/** Max threshold shift contributed by a fully saturated modulator. */
const MOD_SHIFT = 0.12;

/** Length at which the prose-length signal saturates to 1.0. */
const LENGTH_SATURATION_CHARS = 600;

/** Feature weights for the raw score (pre-clamp). */
const W = {
  length: 0.3,
  actionVerbs: 0.22,
  sequencing: 0.18,
  enumeration: 0.18,
  artifacts: 0.22,
} as const;

const ACTION_VERB_RE =
  /\b(implement|build|create|add|refactor|fix|migrate|design|investigate|analy[sz]e|integrate|rewrite|port|deploy|set\s?up|configure|generate|write|review|audit|optimi[sz]e|debug|test|plan|research|compare|evaluate|wire|extract)\b/gi;

const SEQUENCING_RE =
  /\b(then|after that|afterwards|next|first(?:ly)?|second(?:ly)?|third(?:ly)?|finally|lastly|once .* (?:is|are) done|before you|followed by)\b/gi;

/** "across all three packages", "end to end", "open a PR", "with tests", etc. */
const ARTIFACT_RE =
  /\b(across (?:all|every|the)|end[- ]to[- ]end|open a (?:pr|pull request)|with tests?|add tests?|all (?:three|four|\d+|the) (?:packages|services|modules|files)|each (?:package|service|module)|multiple files|whole (?:codebase|repo|repository)|every (?:file|module))\b/gi;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * Strip fenced code blocks and pasted-log lines so that a long quoted blob
 * does not masquerade as a complex multi-step request. Returns the prose
 * remainder and the fraction of the original that was stripped.
 */
function separateProse(prompt: string): { prose: string; pastedFraction: number } {
  const total = prompt.length || 1;
  let stripped = 0;

  // Fenced code blocks (``` ... ```), including unterminated trailing fences.
  let prose = prompt.replace(/```[\s\S]*?(?:```|$)/g, (block) => {
    stripped += block.length;
    return " ";
  });

  // Log-like lines: ISO timestamps, [LEVEL] tags, or stack-trace "at " frames.
  prose = prose
    .split("\n")
    .filter((line) => {
      const isLogLike =
        /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(line) ||
        /^\s*(?:\[)?(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\b/i.test(line) ||
        /^\s*at\s+\S+\s+\(/.test(line);
      if (isLogLike) {
        stripped += line.length + 1;
        return false;
      }
      return true;
    })
    .join("\n");

  return { prose, pastedFraction: clamp(stripped / total, 0, 1) };
}

/**
 * Stage-1 heuristic scorer. Pure: derives a raw [0,1] complexity score and
 * the contributing signals from the prompt text alone.
 */
export function scorePrompt(prompt: string): {
  score: number;
  signals: ComplexitySignals;
  reasons: string[];
} {
  const { prose, pastedFraction } = separateProse(prompt);
  const proseChars = prose.trim().length;

  const actionVerbs = countMatches(prose, ACTION_VERB_RE);
  const sequencingMarkers = countMatches(prose, SEQUENCING_RE);

  // Enumeration: bullet/numbered list markers plus clause-joining "and".
  const listMarkers = countMatches(prose, /^\s*(?:[-*]|\d+[.)])\s+/gm);
  const andJoins = countMatches(prose, /\b and \b/gi);
  const enumerationItems = listMarkers + andJoins;

  const artifactHints = countMatches(prose, ARTIFACT_RE);

  const lengthScore = clamp(proseChars / LENGTH_SATURATION_CHARS, 0, 1);
  const verbScore = clamp(actionVerbs / 4, 0, 1);
  const seqScore = clamp(sequencingMarkers / 3, 0, 1);
  const enumScore = clamp(enumerationItems / 4, 0, 1);
  const artifactScore = clamp(artifactHints / 2, 0, 1);

  const raw =
    lengthScore * W.length +
    verbScore * W.actionVerbs +
    seqScore * W.sequencing +
    enumScore * W.enumeration +
    artifactScore * W.artifacts;

  const score = clamp(raw, 0, 1);

  const reasons: string[] = [];
  if (lengthScore > 0)
    reasons.push(`prose_length=${proseChars} (+${(lengthScore * W.length).toFixed(2)})`);
  if (actionVerbs > 0)
    reasons.push(`action_verbs=${actionVerbs} (+${(verbScore * W.actionVerbs).toFixed(2)})`);
  if (sequencingMarkers > 0)
    reasons.push(`sequencing=${sequencingMarkers} (+${(seqScore * W.sequencing).toFixed(2)})`);
  if (enumerationItems > 0)
    reasons.push(`enumeration=${enumerationItems} (+${(enumScore * W.enumeration).toFixed(2)})`);
  if (artifactHints > 0)
    reasons.push(`artifacts=${artifactHints} (+${(artifactScore * W.artifacts).toFixed(2)})`);
  if (pastedFraction > 0.25)
    reasons.push(`pasted_fraction=${pastedFraction.toFixed(2)} (length discounted)`);

  return {
    score,
    signals: {
      proseChars,
      actionVerbs,
      sequencingMarkers,
      enumerationItems,
      artifactHints,
      pastedFraction,
    },
    reasons,
  };
}

/**
 * Modulate the decision thresholds by affective state. High cortisol raises
 * the thresholds (be conservative: fewer goals under stress); high dopamine
 * and curiosity lower them (be eager: start goals, decompose deeper). The
 * result is clamped to fixed rails so behaviour stays bounded.
 */
export function modulateThresholds(mod: ComplexityModulators = {}): { low: number; high: number } {
  const cortisol = clamp(mod.cortisol ?? 0, 0, 1);
  const dopamine = clamp(mod.dopamine ?? 0, 0, 1);
  const curiosity = clamp(mod.curiosity ?? 0, 0, 1);

  // Positive shift = more conservative (higher thresholds).
  const eagerness = (dopamine + curiosity) / 2;
  const shift = (cortisol - eagerness) * MOD_SHIFT;

  const low = clamp(BASE_LOW + shift, RAIL_LOW_MIN, RAIL_LOW_MAX);
  const high = clamp(BASE_HIGH + shift, RAIL_HIGH_MIN, RAIL_HIGH_MAX);
  return { low, high };
}

/**
 * Full Stage-1 appraisal: score the text, modulate the thresholds by
 * affective state, and assign a tier. The gray band returns
 * `needsLlm: true` for the caller to resolve.
 */
export function appraiseComplexity(
  prompt: string,
  mod: ComplexityModulators = {},
): ComplexityVerdict {
  const { score, signals, reasons } = scorePrompt(prompt);
  const thresholds = modulateThresholds(mod);

  let tier: ComplexityTier;
  if (score < thresholds.low) {
    tier = "inline";
  } else if (score >= thresholds.high) {
    tier = "goal";
  } else {
    tier = "gray";
  }

  const modReasons: string[] = [];
  if (mod.cortisol != null) modReasons.push(`cortisol=${mod.cortisol.toFixed(2)}`);
  if (mod.dopamine != null) modReasons.push(`dopamine=${mod.dopamine.toFixed(2)}`);
  if (mod.curiosity != null) modReasons.push(`curiosity=${mod.curiosity.toFixed(2)}`);
  if (modReasons.length > 0) {
    modReasons.push(`-> thresholds [${thresholds.low.toFixed(2)}, ${thresholds.high.toFixed(2)}]`);
  }

  return {
    tier,
    score,
    thresholds,
    needsLlm: tier === "gray",
    signals,
    reasons: [...reasons, ...modReasons],
  };
}
