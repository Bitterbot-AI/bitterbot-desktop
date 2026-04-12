/**
 * Dream synthesis: prompt templates and response parsing for LLM-based
 * dream insight generation, plus heuristic fallback.
 */

import type { DreamCluster, DreamSynthesisResult } from "./dream-types.js";

/**
 * Build the LLM prompt for a batch of dream clusters.
 */
export function buildDreamSynthesisPrompt(
  clusters: DreamCluster[],
  chunkTexts: Map<string, string>,
): string {
  const sections = clusters.map((cluster, i) => {
    const modeLabel = cluster.mode.replace("_", "-");
    const texts = cluster.chunkIds
      .map((id) => chunkTexts.get(id) ?? "")
      .filter(Boolean)
      .map((t) => t.slice(0, 500));
    return (
      `## Cluster ${i + 1} (${modeLabel})\n` +
      `Keywords: ${cluster.keywords.join(", ") || "none"}\n\n` +
      texts.map((t, j) => `Memory ${j + 1}:\n${t}`).join("\n\n")
    );
  });

  return (
    `You are a Dream Engine synthesizing cross-domain insights from memory clusters.\n\n` +
    `For each cluster, identify a non-obvious pattern, connection, or meta-insight that\n` +
    `spans the memories. Focus on higher-order relationships rather than restating content.\n\n` +
    `${sections.join("\n\n---\n\n")}\n\n` +
    `---\n\n` +
    `Respond with a JSON array of objects, one per cluster, each with:\n` +
    `- "content": a concise insight (1-3 sentences)\n` +
    `- "confidence": float 0-1 indicating how strong the pattern is\n` +
    `- "keywords": array of 2-5 relevant keywords\n\n` +
    `Respond ONLY with the JSON array, no other text.`
  );
}

/**
 * Parse the LLM response into DreamSynthesisResult[].
 */
export function parseDreamSynthesisResponse(raw: string): DreamSynthesisResult[] {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/```\s*$/, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (item: unknown): item is { content: string; confidence: number; keywords: string[] } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).content === "string" &&
          typeof (item as Record<string, unknown>).confidence === "number",
      )
      .map((item) => ({
        content: String(item.content).slice(0, 2000),
        confidence: Math.max(0, Math.min(1, item.confidence)),
        keywords: Array.isArray(item.keywords)
          ? item.keywords.filter((k: unknown): k is string => typeof k === "string").slice(0, 10)
          : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Heuristic synthesis: extract overlapping keywords across cluster memories
 * and generate template insights without any LLM call.
 */
export function heuristicSynthesize(
  clusters: DreamCluster[],
  chunkTexts: Map<string, string>,
): DreamSynthesisResult[] {
  return clusters.map((cluster) => {
    const texts = cluster.chunkIds.map((id) => chunkTexts.get(id) ?? "").filter(Boolean);

    // Collect word frequencies across all texts in cluster
    const wordFreq = new Map<string, number>();
    for (const text of texts) {
      const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const seen = new Set<string>();
      for (const word of words) {
        if (!seen.has(word)) {
          seen.add(word);
          wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
        }
      }
    }

    // Words appearing in multiple texts are cross-cutting themes
    const shared = [...wordFreq.entries()]
      .filter(([, count]) => count >= Math.max(2, Math.ceil(texts.length * 0.5)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word]) => word);

    const keywords = shared.length > 0 ? shared : cluster.keywords;
    const themeStr = keywords.slice(0, 5).join(", ");
    const content =
      texts.length > 1
        ? `Cross-domain pattern across ${texts.length} memories: recurring themes of ${themeStr}. These memories share conceptual overlap suggesting a deeper structural relationship.`
        : `Memory pattern: themes of ${themeStr}.`;

    // Confidence is proportional to number of texts and shared keywords
    const confidence = Math.min(
      0.8,
      0.2 + 0.1 * Math.min(texts.length, 4) + 0.05 * Math.min(shared.length, 6),
    );

    return { content, confidence, keywords };
  });
}
