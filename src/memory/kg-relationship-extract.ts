/**
 * PLAN-23 SABM Phase 0: deterministic relationship extraction.
 *
 * Pure helpers that turn a relationship fact's text + the person names found in
 * it into candidate `ExtractedRelationship` edges. No LLM, no embeddings: a
 * keyword table maps the text to a `RelationType`, and only the leading pair of
 * distinct persons is emitted (conservative, never a combinatorial fan-out).
 *
 * Kept separate from manager.ts so the classification is unit-testable in
 * isolation. The manager wires this into the session-extraction path behind the
 * `BITTERBOT_KG_RELATIONSHIPS` flag (default on).
 */

import type { ExtractedRelationship, RelationType } from "./knowledge-graph.js";

/** Map fact text to a relation type. Falls back to `related_to`. */
export function relationTypeForText(text: string): RelationType {
  if (/\b(?:manages|leads?|reports? to|supervis)/i.test(text)) return "manages";
  if (/\b(?:works? on|working on|contributes? to)\b/i.test(text)) return "works_on";
  if (/\b(?:prefers?|likes?|favou?rite|enjoys?)\b/i.test(text)) return "prefers";
  if (/\b(?:knows|met|colleague|friend)\b/i.test(text)) return "knows";
  if (/\b(?:uses?|using|depends? on)\b/i.test(text)) return "uses";
  return "related_to";
}

/** Capitalized-word person-name heuristic, shared with the manager's NER pass. */
const STOP_WORDS = new Set(["The", "This", "That", "When", "What", "How", "Why"]);

export function extractPersonNames(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
  return matches.filter((n) => n.length > 2 && !STOP_WORDS.has(n));
}

/**
 * Build a candidate relationship from a single relationship fact, pairing the
 * first two distinct persons mentioned. Returns null when fewer than two
 * distinct persons are present. Direction follows mention order.
 */
export function extractRelationshipFromFact(text: string): ExtractedRelationship | null {
  const distinct = [...new Set(extractPersonNames(text))];
  if (distinct.length < 2) {
    return null;
  }
  const relationType = relationTypeForText(text);
  return {
    sourceName: distinct[0],
    sourceType: "person",
    targetName: distinct[1],
    targetType: "person",
    relationType,
    // related_to is the low-confidence fallback; typed relations are stronger.
    weight: relationType === "related_to" ? 0.3 : 0.5,
  };
}
