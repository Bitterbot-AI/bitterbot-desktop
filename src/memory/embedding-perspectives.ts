/**
 * Multi-Perspective Embedding System: generates embeddings from 4 perspectives
 * (semantic, procedural, causal, entity) using prefix-tuning on the same model.
 *
 * Prefix-tuning reuses the existing embedding provider — no new models needed.
 * Research shows instruction-prefixed embeddings from the same model capture
 * different semantic facets.
 */

import type { EmbeddingPerspective, MultiPerspectiveEmbedding } from "./crystal-types.js";

export type EmbeddingProvider = (texts: string[]) => Promise<number[][]>;

const PERSPECTIVE_PREFIXES: Record<EmbeddingPerspective, string> = {
  semantic: "", // no prefix — original embedding
  procedural: "Steps, prerequisites, and execution order: ",
  causal: "Causes, effects, and consequences: ",
  entity: "Tools, APIs, technologies, and entities: ",
};

/**
 * Extract entities from text for the entity perspective.
 */
function extractEntities(text: string): string {
  const patterns = [
    // Programming tools and CLIs
    /\b(?:git|npm|node|python3?|cargo|docker|curl|wget|pip|yarn|bun|deno|rustc|gcc|make|cmake)\b/gi,
    // APIs and services
    /\b(?:REST|GraphQL|gRPC|WebSocket|HTTP|HTTPS|OAuth|JWT|API)\b/g,
    // Frameworks and libraries
    /\b(?:React|Vue|Angular|Express|FastAPI|Django|Flask|Next\.js|Svelte)\b/g,
    // Databases
    /\b(?:PostgreSQL|MySQL|MongoDB|Redis|SQLite|Supabase|Firebase)\b/g,
    // Languages
    /\b(?:TypeScript|JavaScript|Python|Rust|Go|Java|C\+\+|Ruby|Swift)\b/g,
    // Cloud/Infra
    /\b(?:AWS|GCP|Azure|Kubernetes|Docker|Terraform|CI\/CD|GitHub)\b/g,
  ];

  const entities = new Set<string>();
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) entities.add(m.toLowerCase());
    }
  }

  // Also extract capitalized multi-word terms (likely proper nouns / tool names)
  const capitalizedPattern = /\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\b/g;
  const capitalMatches = text.match(capitalizedPattern);
  if (capitalMatches) {
    for (const m of capitalMatches.slice(0, 10)) {
      entities.add(m.toLowerCase());
    }
  }

  return [...entities].join(", ") || text.slice(0, 200);
}

/**
 * Generate embeddings from all 4 perspectives for a given text.
 */
export async function embedWithPerspectives(
  text: string,
  provider: EmbeddingProvider,
): Promise<MultiPerspectiveEmbedding> {
  const entityText = extractEntities(text);

  const inputs = [
    text, // semantic (no prefix)
    PERSPECTIVE_PREFIXES.procedural + text.slice(0, 1500),
    PERSPECTIVE_PREFIXES.causal + text.slice(0, 1500),
    PERSPECTIVE_PREFIXES.entity + entityText,
  ];

  const embeddings = await provider(inputs);

  return {
    semantic: embeddings[0] ?? [],
    procedural: embeddings[1] ?? [],
    causal: embeddings[2] ?? [],
    entity: embeddings[3] ?? [],
  };
}

/**
 * Generate a single perspective embedding.
 */
export async function embedSinglePerspective(
  text: string,
  perspective: EmbeddingPerspective,
  provider: EmbeddingProvider,
): Promise<number[]> {
  let input: string;
  if (perspective === "entity") {
    input = PERSPECTIVE_PREFIXES.entity + extractEntities(text);
  } else {
    input = PERSPECTIVE_PREFIXES[perspective] + text.slice(0, 1500);
  }

  const embeddings = await provider([input]);
  return embeddings[0] ?? [];
}

/**
 * Batch embed multiple texts with all perspectives.
 */
export async function batchEmbedWithPerspectives(
  texts: string[],
  provider: EmbeddingProvider,
): Promise<MultiPerspectiveEmbedding[]> {
  if (texts.length === 0) return [];

  // Build all inputs: 4 per text
  const allInputs: string[] = [];
  for (const text of texts) {
    const entityText = extractEntities(text);
    allInputs.push(
      text,
      PERSPECTIVE_PREFIXES.procedural + text.slice(0, 1500),
      PERSPECTIVE_PREFIXES.causal + text.slice(0, 1500),
      PERSPECTIVE_PREFIXES.entity + entityText,
    );
  }

  const allEmbeddings = await provider(allInputs);

  const results: MultiPerspectiveEmbedding[] = [];
  for (let i = 0; i < texts.length; i++) {
    const base = i * 4;
    results.push({
      semantic: allEmbeddings[base] ?? [],
      procedural: allEmbeddings[base + 1] ?? [],
      causal: allEmbeddings[base + 2] ?? [],
      entity: allEmbeddings[base + 3] ?? [],
    });
  }

  return results;
}

export { extractEntities };
