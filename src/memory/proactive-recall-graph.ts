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

// Entity-query shapes that justify a graph lookup. Conservative on purpose.
const ENTITY_QUERY_RX = /\b(?:who(?:'s| is| are)|what(?:'s| is)|tell me about)\s+/i;
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
  if (isKinshipQuery && trimmedUser) {
    candidateNames.add(trimmedUser);
  }
  if (candidateNames.size === 0) {
    return [];
  }

  const facts: ProactiveFact[] = [];
  const seenEntities = new Set<string>();
  const seenEdges = new Set<string>();

  for (const name of candidateNames) {
    const entity = kg.findEntityByNameType(name, "person");
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
      if (!FAMILY_RELATIONS.has(relationType)) {
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

      const label = FAMILY_RELATION_LABEL[relationType] ?? relationType;
      const other = edge.connectedEntity;
      const userIsEntity = !!trimmedUser && entity.name.toLowerCase() === trimmedUser.toLowerCase();
      const userIsOther = !!trimmedUser && other.name.toLowerCase() === trimmedUser.toLowerCase();

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
