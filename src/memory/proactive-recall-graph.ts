/**
 * PLAN-27: graph-anchored stage for proactive recall.
 *
 * For entity/identity-shaped turns ("who is Donna", "who is my wife") the flat
 * vector probe in proactive-recall.ts is the wrong tool: the answer is a
 * *relationship*, not text overlap, and natural phrasings ("who is my wife")
 * embed far from the stored sentence ("User's wife is named Donna"). This stage
 * resolves the entity in the knowledge graph and reads its current, SABM-valid
 * family edges directly — a structural match with no similarity gate, surfaced as
 * a high-confidence fact so identity recall stops rendering as "(uncertain)".
 *
 * Scope is deliberately narrow (family relations only) so we never inject an
 * ambiguous or wrong structural fact: a confidently-wrong relation is worse than
 * a miss. Non-entity turns skip the stage entirely (zero graph cost).
 */

import type { KnowledgeGraphManager, RelationType } from "./knowledge-graph.js";
import type { ProactiveFact } from "./proactive-recall.js";
import { FAMILY_RELATION_LABEL } from "./kg-relationship-extract.js";

const FAMILY_RELATIONS = new Set<RelationType>([
  "spouse_of",
  "parent_of",
  "child_of",
  "sibling_of",
]);

/**
 * Relations that make the agent feel familiar beyond kinship — what someone
 * works on, who they know, where they are, what they use.
 *
 * 2026-08-11: recall used to accept ONLY the four family relations, which are
 * disjoint from every relation type the graph actually contains — so 73 of 73
 * live edges were discarded and the graph layer never contributed once in the
 * node's lifetime. Family stays first-class (it phrases as "your spouse");
 * these render with a plain, hedge-free label.
 *
 * `related_to` is deliberately absent: it is the untyped fallback and says
 * nothing worth injecting.
 */
const SOCIAL_RELATIONS = new Set<RelationType>([
  "knows",
  "works_on",
  "manages",
  "located_at",
  "uses",
  "prefers",
]);

/** Human phrasing for the non-family relations, read subject → object. */
const SOCIAL_RELATION_LABEL: Partial<Record<RelationType, string>> = {
  knows: "knows",
  works_on: "works on",
  manages: "manages",
  located_at: "is based in",
  uses: "uses",
  prefers: "prefers",
};

/**
 * Second-person conjugation. Without this the block reads "You works on
 * Circles" — the agent is supposed to sound like a friend who remembers, not
 * a database dump.
 */
const SOCIAL_RELATION_LABEL_YOU: Partial<Record<RelationType, string>> = {
  knows: "know",
  works_on: "work on",
  manages: "manage",
  located_at: "are based in",
  uses: "use",
  prefers: "prefer",
};

// Entity-query shapes that justify a graph lookup. Conservative on purpose.
const ENTITY_QUERY_RX =
  /\b(?:who(?:'s| is| are)|what(?:'s| is)|where(?:'s| is| does| do)|which\s+\w+|tell me about|remind me about|what do you know about)\s+/i;
// First-person only: a kinship query that should resolve through the *user's*
// edges. "who is her wife" is about a third party — handled (if at all) by the
// proper-name path, not by adding the user as a candidate.
const POSSESSIVE_KINSHIP_RX =
  /\b(?:my|the user'?s|user'?s)\s+(?:wife|husband|spouse|partner|mother|mom|father|dad|parent|son|daughter|child|kid|brother|sister|sibling)\b/i;
// Candidate person names mentioned in the turn (multi-word allowed).
const PROPER_NAME_RX = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)*\b/g;
// Interrogatives that lead a question but are never the entity being asked about.
const NAME_NOISE = new Set(["Who", "What", "Tell", "Whose", "Where", "When", "Why", "How"]);

const titleCase = (name: string): string => name.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Entity types worth resolving a conversational subject against. */
const RESOLVABLE_TYPES: RelationType[] | string[] = [
  "person",
  "project",
  "organization",
  "location",
  "tool",
  "service",
  "concept",
];

/**
 * Resolve a mentioned name to a stored entity across plausible types, trying
 * the full string first and then its leading token (so "Victor M. Gil"
 * matches a stored "victor").
 */
function resolveEntity(
  kg: KnowledgeGraphManager,
  name: string,
): ReturnType<KnowledgeGraphManager["findEntityByNameType"]> {
  const variants = [name.trim()];
  const first = name.trim().split(/\s+/)[0];
  if (first && first.toLowerCase() !== name.trim().toLowerCase()) {
    variants.push(first);
  }
  for (const variant of variants) {
    for (const type of RESOLVABLE_TYPES) {
      const hit = kg.findEntityByNameType(variant, type as never);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

export interface GraphAnchoredOptions {
  userMessage: string;
  kg: KnowledgeGraphManager | null | undefined;
  /** Resolved user name (from the user model) used to phrase "your <relation>". */
  userName?: string | null;
  maxFacts: number;
  recentlySurfaced: Map<string, number>;
  currentTurn: number;
  cooldownTurns: number;
}

/**
 * Resolve entity/identity turns to high-confidence family facts from the graph.
 * Returns [] for non-entity turns, when no KG is available, or when the resolved
 * entities have no current family edges (graceful fallback to the vector probe).
 */
export function graphAnchoredFacts(opts: GraphAnchoredOptions): ProactiveFact[] {
  const { kg, userMessage, userName, maxFacts, recentlySurfaced, currentTurn, cooldownTurns } =
    opts;
  if (!kg || !userMessage.trim() || maxFacts <= 0) {
    return [];
  }

  const isInterrogative = ENTITY_QUERY_RX.test(userMessage);
  const isKinshipQuery = POSSESSIVE_KINSHIP_RX.test(userMessage);
  if (!isInterrogative && !isKinshipQuery) {
    return [];
  }

  // Candidate person entities: proper names in the turn, plus the user themselves
  // when the turn asks about a kinship relation ("who is my wife").
  const candidateNames = new Set<string>();
  for (const raw of userMessage.match(PROPER_NAME_RX) ?? []) {
    if (!NAME_NOISE.has(raw)) {
      candidateNames.add(raw);
    }
  }
  const trimmedUser = userName?.trim();
  // The user is a candidate for kinship queries AND for any first-person
  // question ("where do I live", "what am I working on") — previously the user
  // could only be reached via kinship, so "where do I live" resolved nothing
  // even with a populated graph (2026-08-11).
  const isFirstPerson = /\b(?:i|me|my|mine|i'?m)\b/i.test(userMessage);
  if ((isKinshipQuery || isFirstPerson) && trimmedUser) {
    candidateNames.add(trimmedUser);
  }
  if (candidateNames.size === 0) {
    return [];
  }

  const facts: ProactiveFact[] = [];
  const seenEntities = new Set<string>();
  const seenEdges = new Set<string>();

  for (const name of candidateNames) {
    // Resolve across the plausible types rather than assuming `person`: a
    // place, project, or tool is just as likely to be the subject of "what is
    // X". Also try the leading token so a stored "victor" matches a resolved
    // user name of "Victor M. Gil".
    const entity = resolveEntity(kg, name);
    if (!entity || seenEntities.has(entity.id)) {
      continue;
    }
    seenEntities.add(entity.id);

    // currentOnly=true => SABM-valid edges only; superseded beliefs never surface.
    const traversal = kg.traverseEntity(entity.id, true);
    if (!traversal) {
      continue;
    }

    for (const edge of traversal.relationships) {
      const relationType = edge.relationship.relationType;
      const isFamily = FAMILY_RELATIONS.has(relationType);
      if (!isFamily && !SOCIAL_RELATIONS.has(relationType)) {
        continue;
      }
      if (seenEdges.has(edge.relationship.id)) {
        continue;
      }
      const cooldownKey = `graph:${edge.relationship.id}`;
      const lastTurn = recentlySurfaced.get(cooldownKey) ?? -Infinity;
      if (currentTurn - lastTurn < cooldownTurns) {
        continue;
      }

      const label = isFamily
        ? (FAMILY_RELATION_LABEL[relationType] ?? relationType)
        : (SOCIAL_RELATION_LABEL[relationType] ?? relationType);
      const other = edge.connectedEntity;
      const userIsEntity = !!trimmedUser && entity.name.toLowerCase() === trimmedUser.toLowerCase();
      const userIsOther = !!trimmedUser && other.name.toLowerCase() === trimmedUser.toLowerCase();

      // Non-family edges read as a plain sentence in stored direction:
      // "Bitterbot works on circles", "you are based in Toronto".
      if (!isFamily) {
        const subjEnt = edge.direction === "outgoing" ? entity : other;
        const objEnt = edge.direction === "outgoing" ? other : entity;
        const subjIsUser =
          !!trimmedUser && subjEnt.name.toLowerCase() === trimmedUser.toLowerCase();
        const subject = subjIsUser ? "You" : titleCase(subjEnt.name);
        const verb = subjIsUser ? (SOCIAL_RELATION_LABEL_YOU[relationType] ?? label) : label;
        seenEdges.add(edge.relationship.id);
        recentlySurfaced.set(cooldownKey, currentTurn);
        facts.push({
          text: `${subject} ${verb} ${titleCase(objEnt.name)}`,
          source: "crystal",
          confidence: Math.max(0.6, edge.relationship.weight ?? 0.6),
          epistemicLayer: "directive",
          chunkId: edge.relationship.id,
        });
        if (facts.length >= maxFacts) {
          return facts;
        }
        continue;
      }

      let text: string;
      if (userIsOther) {
        // Asked about the person; the other endpoint is the user. "Donna — your spouse".
        text = `${titleCase(entity.name)} — your ${label}`;
      } else if (userIsEntity) {
        // Asked about the user's relation; surface the person. "Donna — your spouse".
        text = `${titleCase(other.name)} — your ${label}`;
      } else {
        // Two third parties. Phrase by stored direction (source is <label> of target).
        const subj = edge.direction === "outgoing" ? entity.name : other.name;
        const obj = edge.direction === "outgoing" ? other.name : entity.name;
        text = `${titleCase(subj)} — ${label} of ${titleCase(obj)}`;
      }

      seenEdges.add(edge.relationship.id);
      recentlySurfaced.set(cooldownKey, currentTurn);
      facts.push({
        text,
        source: "crystal",
        // Structural, user-stated edges are high-confidence by construction; never
        // rendered as "(uncertain)". Floor at 0.8 regardless of stored weight.
        confidence: Math.max(0.8, edge.relationship.weight ?? 0.8),
        epistemicLayer: "directive",
        chunkId: edge.relationship.id,
      });
      if (facts.length >= maxFacts) {
        return facts;
      }
    }
  }

  return facts;
}
