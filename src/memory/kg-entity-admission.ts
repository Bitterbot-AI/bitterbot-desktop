/**
 * Knowledge-graph admission control — the single gate every entity and edge
 * must pass before it can enter the graph.
 *
 * WHY THIS EXISTS (2026-08-11 trace): the graph had 63 entities, 60 of them
 * typed `person`, including `are`, `could`, `which`, `water`, truncated
 * fragments (`explo`, `iden`, `investiga`), and the two halves of the IANA
 * timezone string "America/Toronto". The producer accepted ANY capitalized
 * run with a 7-word stop list and defaulted every unmatched name to `person`;
 * nothing validated at the write path. A graph like that cannot make an agent
 * feel familiar — it makes it sound deranged — so precision beats recall here:
 * a missing edge costs nothing, a wrong one poisons every future recall.
 *
 * Rules are deliberately mechanical and testable. No LLM in this module.
 */

import type { EntityType, RelationType } from "./knowledge-graph.js";

/** Types the graph is allowed to store from extraction paths. */
export const ADMISSIBLE_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  "person",
  "project",
  "concept",
  "tool",
  "organization",
  "location",
  "file",
  "service",
  "event",
]);

/**
 * Shortest admissible entity name. Three, not four: real people are named
 * Bob, Ana, Jon, and Amy — the blocklist (not a length rule) is what rejects
 * `are`, `can`, `our`, and `old`.
 */
export const MIN_ENTITY_NAME_LENGTH = 3;
/** Longest admissible entity name — beyond this it is a sentence, not a name. */
export const MAX_ENTITY_NAME_LENGTH = 60;
/** Names longer than this many words are prose, not entities. */
export const MAX_ENTITY_NAME_WORDS = 4;

/**
 * Common English words that a capitalized-run extractor picks up at the start
 * of a sentence. Every one of these was a live `person` entity on the node
 * that motivated this module. Compared lowercased.
 */
const COMMON_WORD_BLOCKLIST = new Set([
  // pronouns / determiners / conjunctions
  "the",
  "this",
  "that",
  "these",
  "those",
  "there",
  "their",
  "them",
  "they",
  "then",
  "than",
  "our",
  "ours",
  "your",
  "yours",
  "his",
  "her",
  "hers",
  "its",
  "which",
  "what",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "both",
  "each",
  "some",
  "any",
  "all",
  "none",
  "one",
  "two",
  "other",
  "another",
  // modals / auxiliaries / common verbs
  "are",
  "was",
  "were",
  "been",
  "being",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "does",
  "did",
  "given",
  "assuming",
  "using",
  "based",
  "note",
  "noted",
  "including",
  // extraction verbs that show up in machine-written plans
  "analyze",
  "analyse",
  "examine",
  "explore",
  "exploring",
  "investigate",
  "identify",
  "understand",
  "understanding",
  "clarify",
  "clarifying",
  "develop",
  "review",
  "reviewing",
  "check",
  "checking",
  "conduct",
  "consider",
  "generate",
  "generated",
  "process",
  "processed",
  "summarize",
  "summarized",
  "testing",
  "sending",
  "responses",
  "response",
  "cross",
  "old",
  "new",
  "next",
  // system/domain nouns that are never useful graph entities
  "user",
  "assistant",
  "system",
  "agent",
  "session",
  "sessions",
  "date",
  "time",
  "modes",
  "mode",
  "mood",
  "task",
  "tasks",
  "skills",
  "skill",
  "memory",
  "working memory",
  "working memory state",
  "session handover brief",
  "dream cycle",
  "dream",
  "quarantined",
  "status",
  "summary",
  "context",
]);

/** IANA timezone (America/Toronto), path, URL, ISO date/time fragments. */
const TIMEZONE_RX = /\b[A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+\b/g;
const URL_RX = /\bhttps?:\/\/\S+/gi;
const PATH_RX = /(?:[~.]?\/[\w.-]+)+/g;
const ISO_DATE_RX = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;

/**
 * Strip spans that a capitalized-run matcher would mine for bogus names:
 * timezones, URLs, filesystem paths, and ISO timestamps. Replaced with spaces
 * so surrounding word boundaries are preserved.
 */
export function maskNonEntitySpans(text: string): string {
  return text
    .replace(URL_RX, (m) => " ".repeat(m.length))
    .replace(TIMEZONE_RX, (m) => " ".repeat(m.length))
    .replace(PATH_RX, (m) => " ".repeat(m.length))
    .replace(ISO_DATE_RX, (m) => " ".repeat(m.length));
}

/**
 * True when the name is a plausible entity. Applied AFTER any normalization,
 * so it must not depend on capitalization.
 */
export function isAdmissibleEntityName(rawName: string): boolean {
  const name = rawName.trim();
  if (name.length < MIN_ENTITY_NAME_LENGTH || name.length > MAX_ENTITY_NAME_LENGTH) {
    return false;
  }
  const lower = name.toLowerCase();
  if (COMMON_WORD_BLOCKLIST.has(lower)) {
    return false;
  }
  // Every word individually blocked ("the system", "this task") is still junk.
  const words = lower.split(/\s+/);
  if (words.length > MAX_ENTITY_NAME_WORDS) {
    return false;
  }
  if (words.every((w) => COMMON_WORD_BLOCKLIST.has(w))) {
    return false;
  }
  // Must contain a letter; pure numbers/punctuation are never entities.
  if (!/[a-z]/i.test(name)) {
    return false;
  }
  // Reject stray punctuation-laden fragments (paths, code, markdown bullets).
  if (/[/\\{}()<>|@#$%^*=+`~]/.test(name)) {
    return false;
  }
  return true;
}

/**
 * Detect truncated words produced by slicing crystal text mid-token — the
 * `explo` / `investiga` / `understa` class. A candidate is truncated when it
 * is a strict prefix of a longer candidate from the same text, or when it sits
 * flush against the end of a text that was cut at a slice boundary.
 */
export function dropTruncatedFragments(names: readonly string[]): string[] {
  return names.filter(
    (n) => !names.some((m) => m !== n && m.toLowerCase().startsWith(n.toLowerCase())),
  );
}

/** Type must be in the vocabulary — no free-form types from any caller. */
export function isAdmissibleEntityType(type: string): type is EntityType {
  return ADMISSIBLE_ENTITY_TYPES.has(type as EntityType);
}

/**
 * Machine-generated crystal shapes: dream reports, session handover briefs,
 * working-memory dumps, mode/mood telemetry. Extracting entities from the
 * agent's OWN output is how "cognitive processes and analysis" became an
 * entity that "summarizes" the word "explore" — the graph learning from its
 * own noise. Only human-authored content should shape the social graph.
 */
const MACHINE_TEXT_RX =
  /^(?:#{1,3}\s|\*\*(?:Modes|Mood|Working Memory|Session|Date)\b)|^-\s*\[(?:exploration|extrapolation|mutation|replay|simulation|compression|hygiene|distillation|anticipation)\]|Session Handover(?: Brief)?|^Working Memory State\b|dream[- ]generated/im;

export function looksMachineGenerated(text: string): boolean {
  return MACHINE_TEXT_RX.test(text);
}

// ── Type-pair constrained relations (Graphiti `edge_type_map` pattern) ──
//
// Research consensus (2026-08-11 sweep): constraining WHICH relation may hold
// between WHICH entity types is what makes whole junk classes structurally
// impossible rather than merely filtered. `prefers` requires a concept-ish
// object, so a discourse-marker "like" has nowhere to land; `located_at`
// requires a location object, so "america (person) -> toronto (person)" cannot
// be expressed. Unmapped pairs are REJECTED rather than downgraded — an edge
// we cannot type is an edge we do not want.
const RELATION_TYPE_PAIRS: Partial<Record<RelationType, ReadonlyArray<[string, string]>>> = {
  spouse_of: [["person", "person"]],
  parent_of: [["person", "person"]],
  child_of: [["person", "person"]],
  sibling_of: [["person", "person"]],
  knows: [
    ["person", "person"],
    ["person", "organization"],
  ],
  manages: [
    ["person", "person"],
    ["person", "project"],
    ["person", "organization"],
  ],
  works_on: [
    ["person", "project"],
    ["person", "tool"],
    ["organization", "project"],
  ],
  located_at: [
    ["person", "location"],
    ["organization", "location"],
    ["project", "location"],
    ["service", "location"],
  ],
  uses: [
    ["person", "tool"],
    ["person", "service"],
    ["project", "tool"],
    ["project", "service"],
    ["organization", "tool"],
    ["organization", "service"],
    ["tool", "tool"],
    ["tool", "service"],
    ["service", "service"],
  ],
  prefers: [
    ["person", "concept"],
    ["person", "tool"],
    ["person", "service"],
    ["person", "location"],
  ],
};

/**
 * True when this relation is permitted between these entity types. Relations
 * absent from the map (notably the untyped `related_to` fallback) are refused.
 */
export function isAdmissibleRelation(
  sourceType: string,
  relationType: string,
  targetType: string,
): boolean {
  const pairs = RELATION_TYPE_PAIRS[relationType as RelationType];
  if (!pairs) {
    return false;
  }
  return pairs.some(([s, t]) => s === sourceType && t === targetType);
}

/** Convenience: admit a full candidate (name + type) in one call. */
export function isAdmissibleEntity(name: string, type: string): boolean {
  return isAdmissibleEntityType(type) && isAdmissibleEntityName(name);
}
