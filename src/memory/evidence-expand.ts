import type { EvidenceRef } from "./session-extractor.js";
/**
 * PLAN-24 HORMA Phase 0: resolve a provenance EvidenceRef back to verbatim raw
 * source. Synthesized memories (extracted facts, dream insights) are paraphrases;
 * an EvidenceRef lets the agent — and the reconsolidation faithfulness check —
 * recover the exact text the paraphrase was derived from, the way HORMA's
 * structured notes carry `(D1:3)` pointers into the raw trajectory.
 *
 * Resolution is best-effort and never throws: a session whose file moved, or a
 * journal row purged by task cleanup / a disabled journal, yields `found:false`
 * so callers degrade gracefully instead of failing the recall.
 */
import { getActiveEventJournal } from "../infra/event-journal.js";

export type ExpandedEvidence = {
  ref: EvidenceRef;
  found: boolean;
  /** The raw source window, or "" when unresolved. */
  text: string;
  /** Human-readable provenance location (e.g. `path#L10-L16` or `journal:run#42`). */
  location: string;
};

const DEFAULT_WINDOW = 3;

function notFound(ref: EvidenceRef): ExpandedEvidence {
  return { ref, found: false, text: "", location: describeRef(ref) };
}

export function describeRef(ref: EvidenceRef): string {
  if (ref.kind === "session") {
    return `${ref.path}#L${ref.line}`;
  }
  if (ref.kind === "url") {
    return ref.url;
  }
  return `journal:${ref.runId}#${ref.seq}`;
}

/**
 * Resolve a single EvidenceRef. `window` is the number of context lines on each
 * side of a session-line ref (ignored for journal refs, which return the whole
 * event payload).
 */
export async function expandEvidenceRef(
  ref: EvidenceRef,
  window: number = DEFAULT_WINDOW,
): Promise<ExpandedEvidence> {
  if (ref.kind === "session") {
    try {
      const { buildSessionEntry } = await import("./session-files.js");
      const entry = await buildSessionEntry(ref.path);
      if (!entry) {
        return notFound(ref);
      }
      const lines = entry.content.split("\n");
      const idx = ref.line - 1;
      if (idx < 0 || idx >= lines.length) {
        return notFound(ref);
      }
      const from = Math.max(0, idx - window);
      const to = Math.min(lines.length, idx + window + 1);
      return {
        ref,
        found: true,
        text: lines.slice(from, to).join("\n"),
        location: `${ref.path}#L${from + 1}-L${to}`,
      };
    } catch {
      return notFound(ref);
    }
  }

  if (ref.kind === "url") {
    // PLAN-34 Phase 2b: web provenance resolves to the pointer itself —
    // deliberately no fetch (expansion must never cause network egress).
    return {
      ref,
      found: true,
      text: `Web source: ${ref.url}`,
      location: ref.url,
    };
  }

  // journal ref
  const journal = getActiveEventJournal();
  if (!journal) {
    return notFound(ref);
  }
  try {
    const evt = journal.getByRunSeq(ref.runId, ref.seq);
    if (!evt) {
      return notFound(ref);
    }
    return {
      ref,
      found: true,
      text: JSON.stringify(evt.data, null, 2),
      location: `journal:${ref.runId}#${ref.seq} (${evt.stream})`,
    };
  } catch {
    return notFound(ref);
  }
}

/** Resolve many refs, preserving order. */
export async function expandEvidenceRefs(
  refs: EvidenceRef[],
  window: number = DEFAULT_WINDOW,
): Promise<ExpandedEvidence[]> {
  return Promise.all(refs.map((r) => expandEvidenceRef(r, window)));
}

// ---------------------------------------------------------------------------
// Faithfulness check (HORMA anti-confabulation, applied to reconsolidation).
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "this",
  "that",
  "as",
  "by",
  "from",
  "we",
  "i",
  "you",
  "he",
  "she",
  "they",
  "his",
  "her",
  "their",
]);

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 3 && !STOP_WORDS.has(tok)) {
      out.add(tok);
    }
  }
  return out;
}

/**
 * Fraction of the claim's content tokens that appear in the evidence. 1.0 means
 * every salient token is grounded; low values flag paraphrase drift /
 * confabulation. Deterministic and cheap (no LLM) so it can guard a rewrite
 * inline. A claim with no content tokens scores 1 (nothing to ground).
 */
export function tokenSupportScore(claim: string, evidence: string): number {
  const claimToks = contentTokens(claim);
  if (claimToks.size === 0) {
    return 1;
  }
  const evidenceToks = contentTokens(evidence);
  let hits = 0;
  for (const t of claimToks) {
    if (evidenceToks.has(t)) {
      hits++;
    }
  }
  return hits / claimToks.size;
}

/**
 * PLAN-24 HORMA Phase 0: score how well a fact's session citations support it,
 * given the line-numbered transcript the fact was extracted from. Used at write
 * time to flag confabulated / mis-cited facts without a re-read. Returns null
 * when there are no resolvable session citations (nothing to check).
 */
export function scoreCitationSupport(
  factText: string,
  refs: EvidenceRef[],
  contentLines: string[],
): number | null {
  const cited = refs
    .filter((r): r is Extract<EvidenceRef, { kind: "session" }> => r.kind === "session")
    .map((r) => contentLines[r.line - 1] ?? "")
    .join("\n");
  if (cited.trim().length === 0) {
    return null;
  }
  return tokenSupportScore(factText, cited);
}

export type FaithfulnessVerdict = {
  /** True when the claim is sufficiently grounded in the resolved evidence. */
  supported: boolean;
  /** Token-support score in [0,1]. */
  score: number;
  /** Whether any evidence ref resolved (false → cannot judge, treated as supported). */
  evidenceFound: boolean;
};

/**
 * PLAN-24 HORMA Phase 0: verify a (possibly rewritten) claim against the raw
 * source its evidence refs point at. Reconsolidation and dream rewrites should
 * call this before committing a mutation so a labile memory cannot drift away
 * from ground truth. When no evidence resolves we cannot judge, so we do NOT
 * block (returns supported:true, evidenceFound:false).
 */
export async function verifyAgainstEvidence(
  refs: EvidenceRef[],
  claimText: string,
  opts?: { threshold?: number; window?: number },
): Promise<FaithfulnessVerdict> {
  const threshold = opts?.threshold ?? 0.5;
  if (refs.length === 0) {
    return { supported: true, score: 1, evidenceFound: false };
  }
  const expanded = await expandEvidenceRefs(refs, opts?.window);
  const found = expanded.filter((e) => e.found);
  if (found.length === 0) {
    return { supported: true, score: 1, evidenceFound: false };
  }
  const evidenceText = found.map((e) => e.text).join("\n");
  const score = tokenSupportScore(claimText, evidenceText);
  return { supported: score >= threshold, score, evidenceFound: true };
}

/**
 * Parse a stored `chunks.evidence_refs` JSON string into typed refs. Tolerant of
 * null / malformed values (returns []).
 */
export function parseEvidenceRefs(raw: string | null | undefined): EvidenceRef[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: EvidenceRef[] = [];
    for (const r of parsed) {
      if (!r || typeof r !== "object") {
        continue;
      }
      const o = r as Record<string, unknown>;
      if (o.kind === "session" && typeof o.path === "string" && typeof o.line === "number") {
        out.push({ kind: "session", path: o.path, line: o.line });
      } else if (o.kind === "journal" && typeof o.runId === "string" && typeof o.seq === "number") {
        out.push({ kind: "journal", runId: o.runId, seq: o.seq });
      } else if (o.kind === "url" && typeof o.url === "string") {
        out.push({ kind: "url", url: o.url });
      }
    }
    return out;
  } catch {
    return [];
  }
}
