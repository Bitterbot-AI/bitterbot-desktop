import { describe, expect, it } from "vitest";
import {
  adapterForApi,
  applyLiveDiscovery,
  type CatalogEntryLike,
  discoverProviderModels,
  type FetchLike,
  mergeDiscoveredForProvider,
  type ProviderMeta,
} from "./model-live-discovery.js";

// A FetchLike that returns a canned JSON body for an expected URL substring,
// and a non-ok response for anything else. Records the URLs it was asked for.
function stubFetch(routes: Array<{ match: string; status?: number; body: unknown }>): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.body ?? {},
    };
  };
  return { fetchImpl, calls };
}

describe("adapterForApi", () => {
  it("maps api families to adapters and returns null for unlistable ones", () => {
    expect(adapterForApi("anthropic-messages")).toBe("anthropic");
    expect(adapterForApi("openai-completions")).toBe("openai");
    expect(adapterForApi("openai-responses")).toBe("openai");
    expect(adapterForApi("google-generative-ai")).toBe("google");
    expect(adapterForApi("bedrock-converse-stream")).toBeNull();
    expect(adapterForApi("openai-codex-responses")).toBeNull();
    expect(adapterForApi(undefined)).toBeNull();
  });
});

describe("discoverProviderModels", () => {
  it("lists anthropic models via /v1/models with x-api-key", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: "api.anthropic.com/v1/models",
        body: {
          data: [
            { id: "claude-opus-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "", display_name: "junk" },
          ],
        },
      },
    ]);
    const models = await discoverProviderModels(
      {
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-test",
      },
      { fetchImpl },
    );
    expect(models?.map((m) => m.id)).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    expect(models?.[0]?.name).toBe("Claude Opus 5");
    expect(calls[0]).toContain("/v1/models");
  });

  it("lists openai-compatible models via /models with Bearer + context_length", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: "api.x.ai/v1/models",
        body: { data: [{ id: "grok-4", context_length: 256000 }] },
      },
    ]);
    const models = await discoverProviderModels(
      {
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        apiKey: "xai-key",
      },
      { fetchImpl },
    );
    expect(models).toEqual([{ id: "grok-4", name: undefined, contextWindow: 256000 }]);
  });

  it("lists google models, strips models/ prefix, drops non-generateContent", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: "generativelanguage.googleapis.com/v1beta/models",
        body: {
          models: [
            {
              name: "models/gemini-3-pro",
              displayName: "Gemini 3 Pro",
              inputTokenLimit: 1000000,
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/text-embedding-004",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        },
      },
    ]);
    const models = await discoverProviderModels(
      {
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "goog-key",
      },
      { fetchImpl },
    );
    expect(models).toEqual([{ id: "gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 1000000 }]);
    expect(calls[0]).toContain("key=goog-key");
  });

  it("returns null for an unlistable api family (bedrock) without fetching", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const models = await discoverProviderModels(
      {
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
        baseUrl: "https://x",
        apiKey: "k",
      },
      { fetchImpl },
    );
    expect(models).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null (not throw) on a non-200 response", async () => {
    const { fetchImpl } = stubFetch([
      { match: "api.anthropic.com", status: 401, body: { error: "nope" } },
    ]);
    const models = await discoverProviderModels(
      {
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "bad",
      },
      { fetchImpl },
    );
    expect(models).toBeNull();
  });

  it("returns null when the credential is missing", async () => {
    const { fetchImpl, calls } = stubFetch([{ match: "anything", body: {} }]);
    const models = await discoverProviderModels(
      {
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: null,
      },
      { fetchImpl },
    );
    expect(models).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null when the fetch throws (network error)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const models = await discoverProviderModels(
      {
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
      },
      { fetchImpl },
    );
    expect(models).toBeNull();
  });
});

describe("mergeDiscoveredForProvider", () => {
  const vendored: CatalogEntryLike[] = [
    {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      provider: "anthropic",
      contextWindow: 200000,
      reasoning: true,
      input: ["text", "image"],
    },
    { id: "claude-3-5-sonnet-20241022", name: "old", provider: "anthropic", contextWindow: 100000 },
    { id: "gpt-5.2", name: "GPT-5.2", provider: "openai", contextWindow: 400000 },
  ];

  it("keeps discovered IDs, joins vendored metadata, drops retired vendored IDs", () => {
    const out = mergeDiscoveredForProvider({
      provider: "anthropic",
      discovered: [{ id: "claude-opus-5", name: "Claude Opus 5" }, { id: "claude-opus-4-6" }],
      vendored,
    });
    expect(out.map((m) => m.id)).toEqual(["claude-opus-5", "claude-opus-4-6"]);
    // Brand-new ID with no vendored match inherits the richest vendored entry's
    // capability metadata (context window, modalities, reasoning).
    const opus5 = out.find((m) => m.id === "claude-opus-5")!;
    expect(opus5.contextWindow).toBe(200000);
    expect(opus5.input).toEqual(["text", "image"]);
    expect(opus5.reasoning).toBe(true);
    expect(opus5.name).toBe("Claude Opus 5");
    // Known vendored ID keeps its own metadata + name.
    const opus46 = out.find((m) => m.id === "claude-opus-4-6")!;
    expect(opus46.name).toBe("Claude Opus 4.6");
    // The retired claude-3-5-sonnet-20241022 is gone (not in discovered).
    expect(out.some((m) => m.id.startsWith("claude-3-5"))).toBe(false);
  });
});

describe("applyLiveDiscovery", () => {
  const vendored: CatalogEntryLike[] = [
    { id: "claude-3-5-sonnet-20241022", name: "old", provider: "anthropic", contextWindow: 200000 },
    {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      provider: "anthropic",
      contextWindow: 200000,
    },
    { id: "amazon.nova-2-lite", name: "Nova", provider: "amazon-bedrock", contextWindow: 300000 },
  ];
  const providerMeta = new Map<string, ProviderMeta>([
    ["anthropic", { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" }],
    ["amazon-bedrock", { baseUrl: "https://bedrock", api: "bedrock-converse-stream" }],
  ]);

  it("replaces a provider's slice on success, leaves unlistable providers intact", async () => {
    const fetchImpl: FetchLike = async (url) => ({
      ok: url.includes("api.anthropic.com"),
      status: url.includes("api.anthropic.com") ? 200 : 404,
      json: async () => ({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }] }),
    });
    const out = await applyLiveDiscovery({
      vendored,
      providerMeta,
      fetchImpl,
      resolveKey: async (p) => (p === "anthropic" ? { apiKey: "sk" } : null),
    });
    const anth = out.filter((m) => m.provider === "anthropic").map((m) => m.id);
    // Anthropic slice replaced by live list: retired gone, opus-5 in.
    expect(anth).toEqual(["claude-opus-5"]);
    // Bedrock (no adapter) untouched.
    expect(out.some((m) => m.id === "amazon.nova-2-lite")).toBe(true);
  });

  it("keeps the vendored list when discovery yields nothing (no credential)", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const out = await applyLiveDiscovery({
      vendored,
      providerMeta,
      fetchImpl,
      resolveKey: async () => null,
    });
    expect(out).toBe(vendored);
  });
});
