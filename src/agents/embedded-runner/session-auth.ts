import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ModelRegistry } from "../runtime/models/index.js";

/**
 * Request auth for a turn's model calls. The owned session checks that auth
 * resolves before a prompt and passes it to the compaction summary itself,
 * but the agent loop calls `agent.streamFn` for turns without it (ModelRegistry
 * .getApiKeyAndHeaders: runtime key overrides, stored auth profiles,
 * models.json apiKey/headers/authHeader).
 *
 * Wrap the final (outermost) stream function so every inner layer, including
 * the in-tree Anthropic provider, receives the resolved key and headers.
 * Explicit per-call headers win over registry headers.
 */
export function withSessionRequestAuth(
  streamFn: StreamFn,
  modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">,
): StreamFn {
  return async (model, context, options) => {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    const headers =
      auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
    return streamFn(model, context, {
      ...options,
      apiKey: auth.apiKey ?? options?.apiKey,
      headers,
    });
  };
}
