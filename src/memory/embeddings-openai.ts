import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import {
  isLocalEmbeddingBaseUrl,
  recordEmbeddingUsage,
  type EmbedCallOptions,
} from "./embeddings-usage.js";

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

export function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("openai/")) {
    return trimmed.slice("openai/".length);
  }
  return trimmed;
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
  const localEndpoint = isLocalEmbeddingBaseUrl(client.baseUrl);

  const embed = async (input: string[], opts?: EmbedCallOptions): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const started = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ model: client.model, input }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai embeddings failed: ${res.status} ${text}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    // PLAN-50: OpenAI (and OpenAI-compatible endpoints such as vLLM/Ollama) report
    // usage.prompt_tokens / usage.total_tokens on /embeddings.
    recordEmbeddingUsage({
      providerId: "openai",
      model: client.model,
      texts: input,
      tokens: payload.usage?.total_tokens ?? payload.usage?.prompt_tokens,
      feature: opts?.feature,
      agentId: options.agentId,
      durationMs: Date.now() - started,
      local: localEndpoint,
    });
    const data = payload.data ?? [];
    return data.map((entry) => entry.embedding ?? []);
  };

  return {
    provider: {
      id: "openai",
      model: client.model,
      maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model],
      embedQuery: async (text, opts) => {
        const [vec] = await embed([text], opts);
        return vec ?? [];
      },
      embedBatch: (texts, opts) => embed(texts, opts),
    },
    client,
  };
}

export async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<OpenAiEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();

  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: "openai",
          cfg: options.config,
          agentDir: options.agentDir,
        }),
        "openai",
      );

  const providerConfig = options.config.models?.providers?.openai;
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  const model = normalizeOpenAiModel(options.model);
  return { baseUrl, headers, model };
}
