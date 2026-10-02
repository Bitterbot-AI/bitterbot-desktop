import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ModelRegistry } from "../runtime/engines/pi/model-discovery.js";

/**
 * pi-coding-agent >= 0.73 resolves request auth only inside the default
 * `streamFn` that createAgentSession installs (ModelRegistry
 * .getApiKeyAndHeaders: runtime key overrides, stored auth profiles,
 * models.json apiKey/headers/authHeader), and no longer gives the Agent a
 * `getApiKey` callback. Replacing `agent.streamFn`, as the embedded runner
 * does, therefore dropped the API key and headers for every provider.
 *
 * Wrap the final (outermost) stream function so every inner layer, including
 * the in-tree Anthropic provider, receives the resolved key and headers.
 * Explicit per-call headers win over registry headers.
 */
export function withSessionRequestAuth(streamFn: StreamFn, modelRegistry: ModelRegistry): StreamFn {
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
