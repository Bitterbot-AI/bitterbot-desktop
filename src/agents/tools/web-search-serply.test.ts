import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../version.js";
import { __testing, createWebSearchTool, runConfiguredWebSearch } from "./web-search.js";

const config = {
  tools: {
    web: { search: { provider: "serply" as const, cacheTtlMinutes: 0, serply: { apiKey: "k" } } },
  },
};
const body = {
  results: [
    {
      title: "Node.js Releases",
      link: "https://nodejs.org/en/about/previous-releases",
      description: "Node.js 22 is named Jod.",
    },
    { title: "Token", link: "CAESJxoH", description: "not a URL" },
    { title: "Invalid", link: "javascript:alert(1)", description: "unsafe" },
    { title: "Second", link: "http://example.com/", description: "plain http" },
  ],
};
const requests: Array<{ url: URL; headers: Headers }> = [];
let response: () => Response;

beforeEach(() => {
  requests.length = 0;
  response = () => Response.json(body);
  vi.stubEnv("SERPLY_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init: RequestInit = {}) => {
      requests.push({ url: new URL(String(url)), headers: new Headers(init.headers) });
      return response();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("keyed Serply web search", () => {
  it("sends the key in a header, maps filters, and wraps http(s) results only", async () => {
    const result = await createWebSearchTool({ config })!.execute("serply", {
      query: "Node.js 22 codename",
      count: 10,
      country: "DE",
      freshness: "pw",
    });
    expect(requests).toHaveLength(1);
    const { url, headers } = requests[0];
    expect(`${url.origin}${url.pathname}`).toBe("https://api.serply.io/v1/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "Node.js 22 codename",
      num: "10",
      gl: "de",
      tbs: "qdr:w",
    });
    expect(headers.get("X-Api-Key")).toBe("k");
    expect(headers.get("User-Agent")).toBe(`Bitterbot/${VERSION}`);
    const details = result.details as {
      provider: string;
      count: number;
      externalContent: { untrusted: boolean };
      results: Array<{ url: string; description: string; siteName?: string }>;
    };
    expect(details).toMatchObject({ provider: "serply", count: 2 });
    expect(details.externalContent.untrusted).toBe(true);
    expect(details.results.map((entry) => entry.url)).toEqual([
      "https://nodejs.org/en/about/previous-releases",
      "http://example.com/",
    ]);
    expect(details.results[0].description).toContain("Node.js 22 is named Jod.");
    expect(details.results[0].description).not.toBe("Node.js 22 is named Jod.");
    expect(details.results[0].siteName).toBe("nodejs.org");
  });

  it("omits gl for ALL and trims results to the requested count", async () => {
    const result = await createWebSearchTool({ config })!.execute("all", {
      query: "hello",
      count: 1,
      country: "ALL",
    });
    expect(requests[0].url.searchParams.has("gl")).toBe(false);
    expect(requests[0].url.searchParams.get("num")).toBe("1");
    expect(result.details).toMatchObject({ count: 1 });
  });

  it("reads SERPLY_API_KEY for configured non-tool callers", async () => {
    vi.stubEnv("SERPLY_API_KEY", "env-key");
    const cfg = { tools: { web: { search: { provider: "serply" as const, cacheTtlMinutes: 0 } } } };
    expect(__testing.resolveSerplyApiKey({})).toBe("env-key");
    expect(await runConfiguredWebSearch(cfg, "Node.js releases", 1)).toEqual([
      expect.objectContaining({ url: body.results[0].link }),
    ]);
    expect(requests[0].headers.get("X-Api-Key")).toBe("env-key");
  });

  it("reports a missing key without a request", async () => {
    const cfg = { tools: { web: { search: { provider: "serply" as const } } } };
    expect(
      (await createWebSearchTool({ config: cfg })!.execute("nokey", { query: "hello" })).details,
    ).toMatchObject({ error: "missing_serply_api_key" });
    expect(await runConfiguredWebSearch(cfg, "hello")).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it.each([
    [{ search_lang: "de" }, "unsupported_search_filter"],
    [{ ui_lang: "de" }, "unsupported_search_filter"],
    [{ freshness: "2026-01-01to2026-02-01" }, "unsupported_freshness"],
    [{ freshness: "yesterday" }, "invalid_freshness"],
  ])("rejects %o without a request", async (filter, error) => {
    const result = await createWebSearchTool({ config })!.execute("filter", {
      query: "hello",
      ...filter,
    });
    expect(result.details).toMatchObject({ error });
    expect(requests).toHaveLength(0);
  });

  it("surfaces API errors with the response detail", async () => {
    response = () => Response.json({ detail: "Invalid API key" }, { status: 401 });
    await expect(
      createWebSearchTool({ config })!.execute("error", { query: "hello" }),
    ).rejects.toThrow('Serply API error (401): {"detail":"Invalid API key"}');
  });

  it("honors cancellation before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWebSearchTool({ config })!.execute("cancel", { query: "hello" }, controller.signal),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("caches successful results", async () => {
    const cfg = {
      tools: {
        web: {
          search: { provider: "serply" as const, cacheTtlMinutes: 1, serply: { apiKey: "k" } },
        },
      },
    };
    const tool = createWebSearchTool({ config: cfg })!;
    await tool.execute("first", { query: "unique serply cached query" });
    expect(
      (await tool.execute("second", { query: "unique serply cached query" })).details,
    ).toMatchObject({ cached: true });
    expect(requests).toHaveLength(1);
  });
});
