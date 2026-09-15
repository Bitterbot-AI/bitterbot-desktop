/**
 * PLAN-50: embedding usage reporting. Every embedding provider (remote, local, batch) calls
 * `recordEmbeddingUsage` so memory indexing, search, recall and dream embeddings show up in the
 * usage ledger next to chat tokens. Providers that report no counts (Gemini on some versions,
 * the local GGUF model) are estimated at ~4 chars/token and tagged `estimated` (or `local`).
 */

import { USAGE_FEATURES } from "../infra/usage-features.js";
import { recordUsage } from "../infra/usage-ledger.js";

export type EmbedCallOptions = {
  /** Ledger attribution, e.g. "memory/search". Defaults to "memory/embeddings". */
  feature?: string;
};

const LOCAL_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.local)$/i;

/** OpenAI-compatible endpoints on loopback/private hosts (vLLM, Ollama, LM Studio) are free by construction. */
export function isLocalEmbeddingBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const host = new URL(baseUrl).hostname;
    return LOCAL_HOST_RE.test(host) || LOCAL_HOST_RE.test(`${host}.`);
  } catch {
    return false;
  }
}

export function estimateEmbeddingTokens(texts: readonly string[]): number {
  let total = 0;
  for (const text of texts) {
    total += Math.ceil(text.length / 4);
  }
  return total;
}

export function recordEmbeddingUsage(params: {
  providerId: string;
  model: string;
  texts?: readonly string[];
  items?: number;
  /** Provider-reported token count; estimated from `texts` when absent. */
  tokens?: number | null;
  feature?: string;
  agentId?: string;
  batch?: boolean;
  durationMs?: number;
  status?: "ok" | "error";
  /** Force $0 / `local` (e.g. an OpenAI-compatible server on localhost). */
  local?: boolean;
}): void {
  try {
    const local = params.local === true || params.providerId === "local";
    const reported =
      typeof params.tokens === "number" && Number.isFinite(params.tokens) && params.tokens > 0;
    const tokens = reported
      ? Math.round(params.tokens as number)
      : estimateEmbeddingTokens(params.texts ?? []);
    if (tokens <= 0) {
      return;
    }
    recordUsage({
      kind: "embedding",
      feature: params.feature ?? USAGE_FEATURES.memoryEmbeddings,
      provider: params.providerId,
      model: params.model,
      agentId: params.agentId,
      usage: { input: tokens, total: tokens },
      costSource: local ? "local" : reported ? undefined : "estimated",
      batch: params.batch,
      items: params.items ?? params.texts?.length,
      durationMs: params.durationMs,
      status: params.status,
    });
  } catch {
    // Accounting never affects embedding.
  }
}
