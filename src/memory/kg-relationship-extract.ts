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

import type { EntityType, ExtractedRelationship, RelationType } from "./knowledge-graph.js";
import {
  dropTruncatedFragments,
  isAdmissibleEntityName,
  maskNonEntitySpans,
} from "./kg-entity-admission.js";

/** Map fact text to a relation type. Falls back to `related_to`. */
export function relationTypeForText(text: string): RelationType {
  if (/\b(?:manages|leads?|reports? to|supervis)/i.test(text)) return "manages";
  if (/\b(?:works? on|working on|contributes? to)\b/i.test(text)) return "works_on";
  // NOTE: bare "like(s)" is deliberately EXCLUDED — it matched ordinary
  // English ("a graph like this", "sounds like") and produced 39% of all live
  // edges as bogus `prefers` relations. A preference needs an explicit
  // preference verb.
  if (/\b(?:prefers?|favou?rites?|enjoys?)\b/i.test(text)) return "prefers";
  if (/\b(?:knows|met|colleague|friend)\b/i.test(text)) return "knows";
  if (/\b(?:located (?:at|in)|based in|hosted (?:at|on)|runs on|lives in)\b/i.test(text))
    return "located_at";
  if (/\b(?:uses?|using|depends? on|built with|powered by)\b/i.test(text)) return "uses";
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

/**
 * Capitalized-run name heuristic, shared with the manager's NER pass.
 *
 * Hardened 2026-08-11: non-entity spans (timezones, URLs, paths, ISO dates)
 * are masked BEFORE matching — "America/Toronto" used to yield two `person`
 * entities — candidates pass full admission control, and truncated fragments
 * (`explo` beside `explore`) are dropped.
 */
export function extractPersonNames(text: string): string[] {
  const masked = maskNonEntitySpans(text);
  const matches = masked.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
  return dropTruncatedFragments(matches.filter((n) => isAdmissibleEntityName(n)));
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
    // Type from the relation context rather than assuming `person`
    // (2026-08-11): this path produced "america (person) -[located_at]->
    // toronto (person)" from an IANA timezone string.
    sourceType: typeEntityInContext(distinct[0]!, relationType, "source"),
    targetName: distinct[1],
    targetType: typeEntityInContext(distinct[1]!, relationType, "target"),
    relationType,
    // related_to is the low-confidence fallback; typed relations are stronger.
    weight: relationType === "related_to" ? 0.3 : 0.5,
  };
}

// ── PLAN-28 A1: broadened, dictionary-typed entity recognition ──
//
// The hot-path extractor above types every capitalized run as a `person`. That
// loses "X uses Docker" / "service hosted on AWS" — relational content sitting
// in fact/insight/world_fact crystals that never becomes a typed edge. A small,
// curated dictionary types the common non-person entities; the long tail still
// falls back to `person` (matching the existing precision profile). No LLM.

const TOOL_RX =
  /^(?:Docker|Postgres|PostgreSQL|MySQL|Redis|React|Node|NodeJS|Python|Git|Kubernetes|MongoDB|GraphQL|REST|Rust|TypeScript|JavaScript|Webpack|Vite|SQLite|Nginx|Kafka|RabbitMQ|Terraform|Ansible|Pytorch|TensorFlow|Numpy|Pandas)$/i;

const SERVICE_RX =
  /^(?:AWS|GCP|Azure|GitHub|GitLab|Bitbucket|Stripe|Slack|Notion|Cloudflare|Vercel|Netlify|Twilio|SendGrid|Datadog|Sentry|Heroku|Supabase|Firebase|OpenAI|Anthropic)$/i;

const ORG_RX = /^(?:Google|Microsoft|Amazon|Apple|Meta|Nvidia|IBM|Oracle|Intel|Salesforce)$/i;
// Corporate suffixes that mark the *trailing* token of an organization name.
const ORG_SUFFIX_RX = /\b(?:Inc|Incorporated|LLC|Corp|Corporation|Ltd|Limited|GmbH|PLC|Co)\b\.?$/;

// Places the extractor should never call people. Deliberately small: the
// point is not world coverage, it is refusing to type a city as a human.
const LOCATION_RX =
  /^(?:Toronto|Montreal|Vancouver|Ottawa|Calgary|Miami|Boston|Chicago|Seattle|Austin|Denver|Portland|Atlanta|Detroit|Phoenix|Dallas|Houston|London|Paris|Berlin|Madrid|Lisbon|Dublin|Amsterdam|Zurich|Geneva|Vienna|Prague|Warsaw|Rome|Milan|Athens|Istanbul|Tokyo|Osaka|Kyoto|Seoul|Beijing|Shanghai|Singapore|Sydney|Melbourne|Auckland|Mumbai|Delhi|Bangalore|Toronto|America|Americas|Canada|Mexico|Brazil|Argentina|England|Scotland|Ireland|France|Germany|Spain|Portugal|Italy|Greece|Turkey|Japan|China|India|Australia|Africa|Europe|Asia|California|Florida|Texas|Ontario|Quebec|Alberta|Manitoba)$/i;

/**
 * Type a single capitalized entity name via the curated dictionaries.
 *
 * Hardened 2026-08-11: `person` is no longer the catch-all. Defaulting the
 * long tail to `person` is what produced 60 "people" named `are`, `water`,
 * and `america`. An unknown capitalized token is far more often a concept or
 * a proper noun of unknown kind, and mislabeling it `person` is the error
 * that makes the agent sound deranged when it surfaces the fact.
 */
export function typeEntityName(name: string): EntityType {
  if (SERVICE_RX.test(name)) return "service";
  if (TOOL_RX.test(name)) return "tool";
  if (ORG_RX.test(name) || ORG_SUFFIX_RX.test(name)) return "organization";
  if (LOCATION_RX.test(name)) return "location";
  // Single capitalized token with no dictionary hit: could be a personal name,
  // but we cannot tell. `concept` is the honest, harmless default; genuine
  // people arrive through the kinship/identity extractor (weight 0.85) which
  // types them explicitly.
  return "concept";
}

/**
 * Type an entity using the relation it participates in, which carries far more
 * signal than the bare token. "Alice manages Bob" makes both endpoints people;
 * "Bitterbot uses Docker" makes the object a tool; "Victor is based in Toronto"
 * makes the object a location. Dictionary hits always win; this only decides
 * the otherwise-unknown long tail, which previously defaulted to `person` and
 * produced 60 "people" including `water` and `america`.
 */
export function typeEntityInContext(
  name: string,
  relationType: RelationType,
  position: "source" | "target",
): EntityType {
  const dictionaryType = typeEntityName(name);
  if (dictionaryType !== "concept") {
    return dictionaryType;
  }
  if (relationType === "manages" || relationType === "knows") {
    return "person";
  }
  if (relationType === "works_on") {
    return position === "source" ? "person" : "project";
  }
  if (relationType === "located_at") {
    return position === "source" ? "person" : "location";
  }
  if (relationType === "uses") {
    return position === "source" ? "person" : "tool";
  }
  if (relationType === "prefers") {
    return position === "source" ? "person" : "concept";
  }
  return "concept";
}

export interface TypedEntity {
  name: string;
  type: EntityType;
}

/**
 * Capitalized-run NER with dictionary typing. Returns entities in mention
 * order, de-duplicated by lowercased name (first type wins).
 */
export function extractTypedEntities(text: string): TypedEntity[] {
  const out: TypedEntity[] = [];
  const seen = new Set<string>();
  for (const name of extractPersonNames(text)) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ name, type: typeEntityName(name) });
  }
  return out;
}

/**
 * PLAN-28 A1 hot-path extractor: a single typed edge from any fact-like text,
 * conservative by construction (PLAN-27's lesson — a wrong edge is worse than no
 * edge):
 *
 *   1. The text must carry a *typed* relation verb. `related_to` (the untyped
 *      fan-out fallback) is refused outright on the hot path.
 *   2. At least two distinct entities must be present; the leading pair becomes
 *      the edge, typed via the dictionary (so Docker → tool, not person).
 *
 * Direction follows mention order. Returns null otherwise.
 */
export function extractTypedRelationshipFromFact(text: string): ExtractedRelationship | null {
  const relationType = relationTypeForText(text);
  if (relationType === "related_to") {
    return null;
  }
  const entities = extractTypedEntities(text);
  if (entities.length < 2) {
    return null;
  }
  const [source, target] = entities;
  return {
    sourceName: source!.name,
    sourceType: typeEntityInContext(source!.name, relationType, "source"),
    targetName: target!.name,
    targetType: typeEntityInContext(target!.name, relationType, "target"),
    relationType,
    // Deterministic typed edge: confident, but below explicit identity edges.
    weight: 0.5,
  };
}
