/**
 * PLAN-45 Phase 0: the wiki-evolution provenance trailer as a parsed record,
 * not a substring.
 *
 * The publisher appends `<!-- wiki-evolution-provenance {json} -->` to the
 * SKILL.md it broadcasts (p2p-publish.ts). The receiver used to treat the
 * bare marker text as "carries validation evidence", which let any envelope
 * that merely contained the phrase skip legacy-crystal rejection. Now the
 * trailer must parse into a closed-shape record with an `accepted` verdict
 * and a real timestamp, and the parsed record is stored alongside the
 * envelope so the receiver re-gate (PLAN-45 Phase 4) can read it.
 *
 * Integrity: the envelope signature covers the SKILL.md bytes, so a parsed
 * trailer is bound to the author key. It is still the SENDER's claim; it
 * never substitutes for local measurement.
 */

import type { EvolutionMeta } from "./validation-gate.js";

export const PROVENANCE_TRAILER_MARKER = "wiki-evolution-provenance";

export interface EvolutionProvenanceRecord {
  origin: "wiki-evolution";
  verdict: "accepted";
  /** PLAN-45 2.8: only tasks-mode verdicts are evidence; a records trailer never parses. */
  mode: "tasks";
  validatedAt: string;
  meanDelta?: number;
  ci95Low?: number;
  trials?: number;
  corpusVersion?: string;
  model?: string;
  notice?: string;
}

export const RECEIVER_NOTICE =
  "Receiving nodes should re-validate locally; this is the sender's evidence, not a guarantee.";

export function buildProvenanceTrailer(meta: EvolutionMeta): string {
  const v = meta.validation;
  const record = {
    origin: "wiki-evolution",
    verdict: v?.verdict,
    mode: v?.mode,
    ...(typeof v?.meanDelta === "number" ? { meanDelta: v.meanDelta } : {}),
    ...(typeof v?.ci95Low === "number" ? { ci95Low: v.ci95Low } : {}),
    ...(typeof v?.trials === "number" ? { trials: v.trials } : {}),
    ...(v?.corpusVersion ? { corpusVersion: v.corpusVersion } : {}),
    ...(v?.model ? { model: v.model } : {}),
    validatedAt: v?.validatedAt,
    notice: RECEIVER_NOTICE,
  };
  return `\n<!-- ${PROVENANCE_TRAILER_MARKER} ${JSON.stringify(record)} -->\n`;
}

// The publisher emits single-line JSON. Confining the capture to one line
// means a stray unterminated opener earlier in the body cannot swallow the
// real trailer, and a "-->" inside a string breaks only that trailer.
const TRAILER_RE = /<!--[ \t]*wiki-evolution-provenance[ \t]+(\{[^\n]*?\})[ \t]*-->/g;

function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function optionalString(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * The LAST well-formed trailer in the body, or null. Only an `accepted`
 * verdict with a parseable `validatedAt` counts as evidence; anything else
 * (bare marker, malformed JSON, held/rejected verdicts, unknown mode) is
 * treated exactly like no trailer at all.
 */
export function parseProvenanceTrailer(md: string): EvolutionProvenanceRecord | null {
  let last: EvolutionProvenanceRecord | null = null;
  for (const match of md.matchAll(TRAILER_RE)) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (r.origin !== "wiki-evolution" || r.verdict !== "accepted") {
      continue;
    }
    if (r.mode !== "tasks") {
      continue;
    }
    const validatedAt = optionalString(r.validatedAt, 64);
    if (!validatedAt || Number.isNaN(Date.parse(validatedAt))) {
      continue;
    }
    last = {
      origin: "wiki-evolution",
      verdict: "accepted",
      mode: "tasks",
      validatedAt,
      meanDelta: optionalNumber(r.meanDelta),
      ci95Low: optionalNumber(r.ci95Low),
      trials: optionalNumber(r.trials),
      corpusVersion: optionalString(r.corpusVersion),
      model: optionalString(r.model),
      notice: optionalString(r.notice, 400),
    };
  }
  return last;
}
