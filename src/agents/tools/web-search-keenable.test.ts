import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../../config/config.js";
import { VERSION } from "../../version.js";
import { Agent } from "../runtime/loop/agent.js";
import { keenablePublishedWindow } from "./web-search-keenable.js";
import {
  __testing,
  createWebSearchTool,
  isWebSearchConfigured,
  runConfiguredWebSearch,
} from "./web-search.js";

const config = {
  tools: { web: { search: { provider: "keenable" as const, cacheTtlMinutes: 0 } } },
};
const keyedConfig = {
  tools: {
    web: {
      search: { provider: "keenable" as const, cacheTtlMinutes: 0, keenable: { apiKey: "k" } },
    },
  },
};
const body = {
  query: "Node.js 22 codename",
  mode: "pro",
  results: [
    {
      title: "Node.js Releases",
      url: "https://nodejs.org/en/about/previous-releases",
      description: "",
      snippet: "Node.js 22 is named Jod.",
      published_at: "2026-09-23T18:22:40Z",
    },
    { title: "Invalid", url: "javascript:alert(1)", description: "", snippet: "unsafe" },
    { title: "Fallback", url: "http://example.com/", description: "Only a description." },
  ],
};
const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
let response: () => Response;

beforeEach(() => {
  requests.length = 0;
  response = () => Response.json(body);
  for (const key of [
    "KEENABLE_API_KEY",
    "BRAVE_API_KEY",
    "TAVILY_API_KEY",
    "PERPLEXITY_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "GROK_API_KEY",
    "SERPLY_API_KEY",
  ])
    vi.stubEnv(key, "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init: RequestInit = {}) => {
      requests.push({
        url: String(url),
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : {},
      });
      return response();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("keyless Keenable web search", () => {
  it("loads selected configuration and delivers wrapped results through the owned agent loop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keenable-search-"));
    try {
      const file = path.join(dir, "bitterbot.json");
      fs.writeFileSync(file, JSON.stringify(config));
      const loaded = createConfigIO({ configPath: file, homedir: () => dir, env: {} }).loadConfig();
      expect(loaded.tools?.web?.search?.provider).toBe("keenable");
      const tool = createWebSearchTool({ config: loaded })!;
      let turn = 0;
      const agent = new Agent({
        initialState: { tools: [tool] },
        streamFn: (_model, context) => {
          const stream = new AssistantMessageEventStream();
          const content: AssistantMessage["content"] =
            turn++ === 0
              ? [
                  {
                    type: "toolCall",
                    id: "search",
                    name: "web_search",
                    arguments: { query: "Node.js 22 codename" },
                  },
                ]
              : (() => {
                  const result = context.messages.find((message) => message.role === "toolResult");
                  const text = result?.content.find((block) => block.type === "text");
                  const data = JSON.parse(text && "text" in text ? text.text : "{}");
                  expect(data.results[0].description).toContain("Node.js 22 is named Jod.");
                  return [
                    {
                      type: "text" as const,
                      text: `Jod\nSource: ${data.results[0].url}`,
                    },
                  ];
                })();
          const stopReason = turn === 1 ? "toolUse" : "stop";
          const message: AssistantMessage = {
            role: "assistant",
            content,
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            stopReason,
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          stream.push({ type: "done", reason: stopReason, message });
          return stream;
        },
      });
      await agent.prompt("What is Node.js 22's codename? Cite the source.");
      expect(agent.state.messages.at(-1)?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("Source: https://nodejs.org/en/about/previous-releases"),
          }),
        ]),
      );
      expect(turn).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends only the query, count and snippet cap, and wraps http(s) results", async () => {
    const result = await createWebSearchTool({ config })!.execute("keyless", {
      query: "Node.js 22 codename",
      count: 10,
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe("https://api.keenable.ai/v1/search/public");
    expect(request.body).toEqual({
      query: "Node.js 22 codename",
      max_results: 10,
      snippet_max_length: 1000,
    });
    expect(request.headers.get("X-Keenable-Title")).toBe("Bitterbot");
    expect(request.headers.get("User-Agent")).toBe(`Bitterbot/${VERSION}`);
    expect(request.headers.has("X-API-Key")).toBe(false);
    expect(request.headers.has("Authorization")).toBe(false);
    const details = result.details as {
      provider: string;
      count: number;
      externalContent: { untrusted: boolean };
      results: Array<{ url: string; description: string; siteName?: string }>;
    };
    expect(details).toMatchObject({ provider: "keenable", count: 2 });
    expect(details.externalContent.untrusted).toBe(true);
    expect(details.results.map((entry) => entry.url)).toEqual([
      "https://nodejs.org/en/about/previous-releases",
      "http://example.com/",
    ]);
    expect(details.results[0].description).toContain("Node.js 22 is named Jod.");
    expect(details.results[0].description).not.toBe("Node.js 22 is named Jod.");
    expect(details.results[1].description).toContain("Only a description.");
    expect(details.results[0].siteName).toBe("nodejs.org");
  });

  it("trims results to the requested count", async () => {
    const result = await createWebSearchTool({ config })!.execute("one", {
      query: "hello",
      count: 1,
    });
    expect(requests[0].body.max_results).toBe(1);
    expect(result.details).toMatchObject({ count: 1 });
  });

  it("maps a date range to the publication window", async () => {
    await createWebSearchTool({ config })!.execute("range", {
      query: "hello",
      freshness: "2026-09-19to2026-10-19",
    });
    expect(requests[0].body).toMatchObject({
      published_after: "2026-09-19",
      published_before: "2026-10-19",
    });
  });

  it("maps a relative window to a publication cutoff", async () => {
    const before = Date.now();
    await createWebSearchTool({ config })!.execute("week", { query: "hello", freshness: "PW" });
    const cutoff = Date.parse(String(requests[0].body.published_after));
    expect(cutoff).toBeGreaterThanOrEqual(before - 7 * 86_400_000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    expect(requests[0].body).not.toHaveProperty("published_before");
  });

  it.each([
    ["pd", { published_after: "2026-10-19T12:00:00.000Z" }],
    ["pm", { published_after: "2026-09-20T12:00:00.000Z" }],
    ["py", { published_after: "2025-10-20T12:00:00.000Z" }],
    ["2026-01-01to2026-01-01", { published_after: "2026-01-01", published_before: "2026-01-01" }],
    [undefined, {}],
  ])("maps freshness %s", (freshness, window) => {
    expect(keenablePublishedWindow(freshness, Date.parse("2026-10-20T12:00:00Z"))).toEqual(window);
  });

  it.each([
    [{ country: "DE" }, "unsupported_search_filter"],
    [{ search_lang: "de" }, "unsupported_search_filter"],
    [{ ui_lang: "de" }, "unsupported_search_filter"],
    [{ freshness: "yesterday" }, "invalid_freshness"],
  ])("rejects %o without a request", async (filter, error) => {
    const result = await createWebSearchTool({ config })!.execute("filter", {
      query: "hello",
      ...filter,
    });
    expect(result.details).toMatchObject({ error });
    expect(requests).toHaveLength(0);
  });

  it("is configured keyless for status surfaces and non-tool callers", async () => {
    expect(isWebSearchConfigured(config)).toBe(true);
    expect(await runConfiguredWebSearch(config, "Node.js releases", 1)).toEqual([
      {
        title: expect.stringContaining("Node.js Releases"),
        url: body.results[0].url,
        snippet: expect.stringContaining("Node.js 22 is named Jod."),
      },
    ]);
    expect(requests[0].url).toBe("https://api.keenable.ai/v1/search/public");
  });

  it("keeps the default and disabled providers unchanged", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "env-key");
    expect(
      (await createWebSearchTool({ config: {} })!.execute("default", { query: "hello" })).details,
    ).toMatchObject({ error: "missing_brave_api_key" });
    expect(
      createWebSearchTool({
        config: { tools: { web: { search: { provider: "keenable", enabled: false } } } },
      }),
    ).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("explains a keyless rate limit with Retry-After and the key that lifts it", async () => {
    response = () =>
      Response.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": "30" } },
      );
    await expect(
      createWebSearchTool({ config })!.execute("limited", { query: "hello" }),
    ).rejects.toThrow(
      /^Keenable rate limit reached \(429, Retry-After: 30\)\. Keyless search is limited per IP; set KEENABLE_API_KEY/,
    );
  });

  it("surfaces other API errors with the response detail", async () => {
    response = () => Response.json({ error: "Bad request" }, { status: 400 });
    await expect(
      createWebSearchTool({ config })!.execute("error", { query: "hello" }),
    ).rejects.toThrow('Keenable API error (400): {"error":"Bad request"}');
  });

  it("forwards only the first line of an HTML error page", async () => {
    response = () =>
      new Response(
        `\n  <!DOCTYPE   html>\n<html><body>${"Service Unavailable ".repeat(5_000)}</body></html>`,
        { status: 503, headers: { "Content-Type": "text/html" } },
      );
    const error = await createWebSearchTool({ config })!
      .execute("html", { query: "hello" })
      .catch((err: unknown) => err);
    expect((error as Error).message).toBe("Keenable API error (503): <!DOCTYPE html>");
  });

  it("caps a long rate-limit body at 300 characters", async () => {
    response = () => new Response(`upstream   overloaded ${"x".repeat(100_000)}`, { status: 429 });
    const error = await createWebSearchTool({ config })!
      .execute("long", { query: "hello" })
      .catch((err: unknown) => err);
    const message = (error as Error).message;
    expect(message).toMatch(/hourly limit\. upstream overloaded x+…$/);
    expect(message.slice(message.indexOf("upstream"))).toHaveLength(301);
  });

  it("rejects an invalid response body", async () => {
    response = () => Response.json({ items: [] });
    await expect(
      createWebSearchTool({ config })!.execute("invalid", { query: "hello" }),
    ).rejects.toThrow("Keenable returned an invalid search response.");
  });

  it("honors cancellation before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWebSearchTool({ config })!.execute("cancel", { query: "hello" }, controller.signal),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("bounds a stalled request by the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    const cfg = {
      tools: { web: { search: { provider: "keenable" as const, timeoutSeconds: 1 } } },
    };
    await expect(
      createWebSearchTool({ config: cfg })!.execute("timeout", { query: "hello" }),
    ).rejects.toThrow("Keenable search timed out after 1s.");
  });

  it("caches successful results", async () => {
    const cfg = {
      tools: { web: { search: { provider: "keenable" as const, cacheTtlMinutes: 1 } } },
    };
    const tool = createWebSearchTool({ config: cfg })!;
    await tool.execute("first", { query: "unique keenable cached query" });
    expect(
      (await tool.execute("second", { query: "unique keenable cached query" })).details,
    ).toMatchObject({ cached: true });
    expect(requests).toHaveLength(1);
  });
});

describe("keyed Keenable web search", () => {
  it("sends a configured key to the keyed endpoint", async () => {
    await createWebSearchTool({ config: keyedConfig })!.execute("keyed", { query: "hello" });
    expect(requests[0].url).toBe("https://api.keenable.ai/v1/search");
    expect(requests[0].headers.get("X-API-Key")).toBe("k");
    expect(requests[0].headers.get("X-Keenable-Title")).toBe("Bitterbot");
  });

  it("reads KEENABLE_API_KEY only when Keenable is selected", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "env-key");
    expect(__testing.resolveKeenableApiKey({})).toBe("env-key");
    await runConfiguredWebSearch(config, "hello", 1);
    expect(requests[0].url).toBe("https://api.keenable.ai/v1/search");
    expect(requests[0].headers.get("X-API-Key")).toBe("env-key");
  });

  it("omits the key hint from a keyed rate limit", async () => {
    response = () => Response.json({ error: "Too many requests" }, { status: 429 });
    const error = await createWebSearchTool({ config: keyedConfig })!
      .execute("limited", { query: "hello" })
      .catch((err: unknown) => err);
    expect(String(error)).toContain("Keenable rate limit reached (429).");
    expect(String(error)).not.toContain("KEENABLE_API_KEY");
  });
});
