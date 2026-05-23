/**
 * PLAN-20 reference interceptor #2: route-by-query-shape.
 *
 * Goal: when the agent calls memory_search with a relationship-shaped
 * query ("who did I talk to about X", "what did X say to Y"), redirect to
 * knowledge_graph_search with the salient entity. Vector search misses
 * these; the graph nails them.
 */

import type { CandidateAction, PreActionInterceptor, StepContext } from "../interceptor.js";

const RELATIONSHIP_RX =
  /\b(who|whom)\b.*\b(did|talked|met|worked|messaged|emailed|called|saw|met with|spoke (?:to|with))\b/i;
const ABOUT_RX = /\babout\s+([A-Z][a-zA-Z]{2,})/;
const ENTITY_FALLBACK_RX = /\b([A-Z][a-zA-Z]{2,})\b/;

function extractEntity(query: string): string | null {
  const about = query.match(ABOUT_RX)?.[1];
  if (about) return about;
  const cap = query.match(ENTITY_FALLBACK_RX)?.[1];
  return cap ?? null;
}

export const routeByQueryShape: PreActionInterceptor = {
  id: "route-by-query-shape:relationship",
  skill: "route-by-query-shape",
  priority: 60,
  maxFiresPerEpisode: 12,
  tools: ["memory_search"],

  shouldActivate(_ctx: StepContext, action: CandidateAction): boolean {
    const query = (action.params as { query?: unknown }).query;
    if (typeof query !== "string") return false;
    if (!RELATIONSHIP_RX.test(query)) return false;
    return extractEntity(query) !== null;
  },

  intervene(_ctx: StepContext, action: CandidateAction) {
    const query = (action.params as { query: string }).query;
    const entity = extractEntity(query) ?? query;
    // Route relationship-shaped queries to `deep_recall`, which can reason
    // over the full memory + knowledge graph via the RLM sandbox. Vector
    // memory_search misses these — deep_recall is the right hammer.
    // Crafted so the agent reads the directive and switches tools cleanly.
    return {
      type: "require_prereq" as const,
      tool: "deep_recall",
      params: { query: `Who and what is associated with ${entity}? Context: "${query}"` },
      reason: `route-by-query-shape: relationship query is better served by deep_recall (entity=${entity})`,
    };
  },
};
