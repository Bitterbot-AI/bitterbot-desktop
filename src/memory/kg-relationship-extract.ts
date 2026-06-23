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

// ── PLAN-27: family / identity relations ──
//
// Maps a kinship surface word to its (gender-neutral) RelationType. The relation
// reads "<named person> is the <word> of <owner>", so a wife/husband is a spouse,
// a mom/dad is a parent, a son/daughter is a child. Direction is always
// (named person) -[relation]-> (owner).
const KINSHIP_RELATION: Record<string, RelationType> = {
  wife: "spouse_of",
  husband: "spouse_of",
  spouse: "spouse_of",
  partner: "spouse_of",
  mother: "parent_of",
  mom: "parent_of",
  father: "parent_of",
  dad: "parent_of",
  parent: "parent_of",
  son: "child_of",
  daughter: "child_of",
  child: "child_of",
  kid: "child_of",
  brother: "sibling_of",
  sister: "sibling_of",
  sibling: "sibling_of",
};

/** Human label for a family RelationType, for natural prompt rendering. */
export const FAMILY_RELATION_LABEL: Partial<Record<RelationType, string>> = {
  spouse_of: "spouse",
  parent_of: "parent",
  child_of: "child",
  sibling_of: "sibling",
};

const KINSHIP_WORDS = Object.keys(KINSHIP_RELATION).join("|");
// First-person owners ONLY. "his/her/their wife" refers to a third party, so it
// must never be attributed to the user — that would forge a wrong family edge.
const OWNER = String.raw`(?:the\s+)?(?:user'?s|my)`;
const NAME = String.raw`([A-Z][a-z]+)`;
// The regex carries the `i` flag for the owner/kinship keywords, which also
// loosens the NAME group; re-assert that the captured name is a real proper noun
// (capitalized) so "her wife is ... what" can't yield a "what" person.
const PROPER_NAME = /^[A-Z][a-z]+$/;

// Two phrasings, both anchored on the user as owner:
//   "<owner> <relation> is (named) <Name>"   e.g. "User's wife is named Donna"
//   "<Name> is <owner> <relation>"           e.g. "Donna is my wife"
const POSSESSIVE_RX = new RegExp(
  String.raw`\b${OWNER}\s+(${KINSHIP_WORDS})\b[^.?!]*?\bis\s+(?:called\s+|named\s+)?${NAME}`,
  "i",
);
const PREDICATE_RX = new RegExp(String.raw`\b${NAME}\s+is\s+${OWNER}\s+(${KINSHIP_WORDS})\b`, "i");

/**
 * Extract a typed family edge from an identity fact about the user, e.g.
 * "User's wife is named Donna" or "Donna is my wife" -> Donna spouse_of <user>.
 *
 * `userName` is the resolved name of the user entity (from the user model) so the
 * edge links to the real person node rather than a literal "User" node. Returns
 * null when the text is not a user-kinship statement or the name is unknown.
 */
export function extractIdentityRelationship(
  text: string,
  opts: { userName: string },
): ExtractedRelationship | null {
  const userName = opts.userName?.trim();
  if (!userName) {
    return null;
  }
  let kinship: string | undefined;
  let personName: string | undefined;
  const poss = POSSESSIVE_RX.exec(text);
  if (poss) {
    kinship = poss[1];
    personName = poss[2];
  } else {
    const pred = PREDICATE_RX.exec(text);
    if (pred) {
      personName = pred[1];
      kinship = pred[2];
    }
  }
  if (!kinship || !personName || !PROPER_NAME.test(personName)) {
    return null;
  }
  const relationType = KINSHIP_RELATION[kinship.toLowerCase()];
  if (!relationType) {
    return null;
  }
  // Guard against degenerate self-reference ("Victor is my ... Victor").
  if (personName.toLowerCase() === userName.toLowerCase()) {
    return null;
  }
  return {
    sourceName: personName,
    sourceType: "person",
    targetName: userName,
    targetType: "person",
    relationType,
    // Explicit, user-stated identity facts are high-confidence edges.
    weight: 0.85,
  };
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
