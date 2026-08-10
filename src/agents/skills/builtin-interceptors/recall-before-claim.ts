/**
 * PLAN-20 reference interceptor #1: recall-before-claim.
 *
 * Goal: when the agent is about to send a message containing a factual
 * claim AND it has not consulted memory this turn, require a memory_search
 * prereq first. This is the closest analog to HASP's web-search PFs and
 * is the headline functionality win: citation rate target ≥ 90% from a
 * ~40% baseline.
 */

import type { CandidateAction, PreActionInterceptor, StepContext } from "../interceptor.js";
import { MESSAGE_TOOL_NAMES } from "./message-tools.js";

const MEMORY_LIKE_TOOLS = new Set([
  "memory_search",
  "deep_recall",
  "knowledge_graph_search",
  "knowledge_graph",
  "graph_search",
]);

// Lightweight factual-assertion shape: at least one capitalized non-stop
// noun and a present-tense indicative verb. Conservative on purpose; we'd
// rather under-fire than annoy with hedges on opinions.
const ASSERTION_RX = /\b([A-Z][a-zA-Z]{2,})\b[^.?!]*\b(is|are|was|were|has|have|did|does|do)\b/;

// Opinion/question shapes — don't fire on these.
const NON_ASSERTION_RX =
  /\b(I think|I feel|maybe|perhaps|could be|might be|sounds like|in my opinion|\?)/i;

// Denial/negation shapes — calling something fabricated is a factual claim too,
// and a higher-stakes one: "X doesn't exist" when X does is worse than a fuzzy
// positive claim. These fire recall-before-claim even when ASSERTION_RX (which
// keys off a capitalized subject) would miss the phrasing.
const NEGATION_RX =
  /\b(hallucinated|made up|making it up|doesn'?t exist|does not exist|never (existed|happened)|fabricated|invented|not real|isn'?t real|that'?s fake|no such|didn'?t happen)\b/i;

const MESSAGE_TOOLS = MESSAGE_TOOL_NAMES;

export const recallBeforeClaim: PreActionInterceptor = {
  id: "recall-before-claim:default",
  skill: "recall-before-claim",
  priority: 80,
  maxFiresPerEpisode: 8,
  tools: MESSAGE_TOOLS,

  shouldActivate(ctx: StepContext, _action: CandidateAction): boolean {
    const draft = ctx.draftReply ?? "";
    if (!draft) return false;
    const isNegation = NEGATION_RX.test(draft);
    // Negations are factual claims too — don't let an opinion/question shape
    // ("maybe that's made up?") suppress them, but do require either a positive
    // assertion or a denial to be present.
    if (!isNegation) {
      if (NON_ASSERTION_RX.test(draft)) return false;
      if (!ASSERTION_RX.test(draft)) return false;
    }
    // Skip if any memory tool has fired this turn (tsDelta within ~30s).
    const recent = ctx.toolHistory.filter((t) => t.tsDelta < 30_000);
    if (recent.some((t) => MEMORY_LIKE_TOOLS.has(t.tool))) return false;
    return true;
  },

  intervene(ctx: StepContext, _action: CandidateAction) {
    const draft = ctx.draftReply ?? "";
    const match = draft.match(ASSERTION_RX);
    // For a denial, the disputed subject may not be the ASSERTION_RX capture —
    // fall back to the leading text so the grounding search targets the claim.
    const subject = match?.[1] ?? draft.slice(0, 80);
    return {
      type: "require_prereq" as const,
      tool: "memory_search",
      params: { query: subject, limit: 5 },
      reason: `recall-before-claim: ground the assertion "${subject}" before sending`,
    };
  },
};
