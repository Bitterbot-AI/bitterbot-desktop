/**
 * Divergence Detector: identifies when a query falls outside known knowledge,
 * measuring per-perspective novelty and suggesting exploration actions.
 */

import type {
  DivergenceReport,
  EmbeddingPerspective,
  MultiPerspectiveEmbedding,
} from "./crystal-types.js";
import type { ScoredCrystal } from "./multi-perspective-search.js";

/**
 * Detect how far a query diverges from the best matching results.
 * High divergence = knowledge gap, low divergence = well-covered territory.
 */
export function detectDivergence(
  queryEmbeddings: MultiPerspectiveEmbedding,
  topResults: ScoredCrystal[],
): DivergenceReport {
  const perspectives: EmbeddingPerspective[] = ["semantic", "procedural", "causal", "entity"];

  // Compute per-perspective novelty: 1 - max_similarity for that perspective
  const novelScores: Record<EmbeddingPerspective, number> = {
    semantic: 1,
    procedural: 1,
    causal: 1,
    entity: 1,
  };

  for (const perspective of perspectives) {
    if (queryEmbeddings[perspective].length === 0) {
      novelScores[perspective] = 1; // unknown = novel
      continue;
    }

    let maxSim = 0;
    for (const result of topResults) {
      const sim = result.perspectiveScores[perspective] ?? 0;
      if (sim > maxSim) maxSim = sim;
    }
    novelScores[perspective] = 1 - maxSim;
  }

  // Find weak perspectives (high novelty = weak coverage)
  const weakPerspectives: EmbeddingPerspective[] = perspectives.filter(
    (p) => novelScores[p] > 0.8,
  );

  // Overall severity: based on max similarity across all perspectives
  const maxOverallSim = Math.max(
    ...perspectives.map((p) => 1 - novelScores[p]),
  );

  let severity: DivergenceReport["severity"];
  if (maxOverallSim < 0.15) {
    severity = "high";
  } else if (maxOverallSim < 0.3) {
    severity = "medium";
  } else if (maxOverallSim < 0.5) {
    severity = "low";
  } else {
    severity = "none";
  }

  // Suggest action
  let suggestedAction: DivergenceReport["suggestedAction"] = "none";
  if (severity === "high") {
    suggestedAction = "acquire_skill";
  } else if (severity === "medium") {
    suggestedAction = "explore";
  }

  return {
    severity,
    novelScores,
    weakPerspectives,
    suggestedAction,
  };
}
