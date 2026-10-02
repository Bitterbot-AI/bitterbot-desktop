import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../../config/config.js";
import { VERSION } from "../../version.js";
import { Agent } from "../runtime/loop/agent.js";
import { createWebSearchTool, runConfiguredWebSearch } from "./web-search.js";

const config = {
  tools: { web: { search: { provider: "parallel" as const, cacheTtlMinutes: 0 } } },
};
const result = {
  results: [
    {
      title: "Node.js Releases",
      url: "https://nodejs.org/en/about/previous-releases",
      excerpts: ["Node.js 22 is named Jod."],
    },
    { title: "Invalid", url: "javascript:alert(1)", excerpts: ["unsafe"] },
  ],
};
const requests: Array<{
  url: string;
  method?: string;
  headers: Headers;
  body?: Record<string, unknown>;
}> = [];
let toolResult: Record<string, unknown>;
function installServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init: RequestInit = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({
        url: String(url),
        method: init.method,
        headers: new Headers(init.headers),
        body,
      });
      if (init.method === "GET") return new Response(null, { status: 405 });
      if (!body?.id && body?.id !== 0) return new Response(null, { status: 202 });
      const payload =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : body.method === "tools/list"
            ? { tools: [{ name: "web_search", inputSchema: { type: "object" } }] }
            : toolResult;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: payload });
    }),
  );
}

beforeEach(() => {
  requests.length = 0;
  toolResult = { content: [{ type: "text", text: JSON.stringify(result) }] };
  for (const key of [
    "PARALLEL_API_KEY",
    "BRAVE_API_KEY",
    "TAVILY_API_KEY",
    "PERPLEXITY_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "GROK_API_KEY",
  ])
    vi.stubEnv(key, "");
  installServer();
});
afterEach(() => vi.unstubAllGlobals());

describe("keyless Parallel native web search", () => {
  it("loads selected configuration, executes MCP in the owned agent loop, and delivers a cited final answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-search-"));
    try {
      const file = path.join(dir, "bitterbot.json");
      fs.writeFileSync(file, JSON.stringify(config));
      const loaded = createConfigIO({ configPath: file, homedir: () => dir, env: {} }).loadConfig();
      expect(loaded.tools?.web?.search?.provider).toBe("parallel");
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
                  const response = context.messages.find(
                    (message) => message.role === "toolResult",
                  );
                  expect(response?.content).toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({
                        text: expect.stringContaining("Node.js 22 is named Jod."),
                      }),
                    ]),
                  );
                  const text = response?.content.find((block) => block.type === "text");
                  const data = JSON.parse(text && "text" in text ? text.text : "{}");
                  return [
                    {
                      type: "text" as const,
                      text: `${data.results[0].description}\nSource: ${data.results[0].url}`,
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
      const methods = requests.map((request) => request.body?.method);
      expect(methods).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
      const call = requests.find((request) => request.body?.method === "tools/call")!;
      expect(call.body?.params).toEqual({
        name: "web_search",
        arguments: { objective: "Node.js 22 codename", search_queries: ["Node.js 22 codename"] },
      });
      for (const request of requests) {
        expect(request.url).toBe("https://search.parallel.ai/mcp");
        expect(request.headers.get("User-Agent")).toBe(`Bitterbot/${VERSION}`);
        expect(request.headers.has("Authorization")).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports structured MCP responses and configured non-tool callers", async () => {
    toolResult = { structuredContent: result, content: [] };
    expect(await runConfiguredWebSearch(config, "Node.js releases", 1)).toEqual([
      expect.objectContaining({ url: result.results[0].url }),
    ]);
  });
  it("keeps the default and disabled providers unchanged", async () => {
    expect(
      (await createWebSearchTool({ config: {} })!.execute("default", { query: "hello" })).details,
    ).toMatchObject({ error: "missing_brave_api_key" });
    expect(
      createWebSearchTool({
        config: { tools: { web: { search: { provider: "parallel", enabled: false } } } },
      }),
    ).toBeNull();
    expect(requests).toHaveLength(0);
  });
  it.each(["country", "search_lang", "ui_lang", "freshness"])(
    "rejects unsupported %s without a request",
    async (filter) => {
      const response = await createWebSearchTool({ config })!.execute("filter", {
        query: "hello",
        [filter]: "US",
      });
      expect(response.details).toMatchObject({
        error: filter === "freshness" ? "unsupported_freshness" : "unsupported_search_filter",
      });
      expect(requests).toHaveLength(0);
    },
  );
  it("propagates MCP tool errors", async () => {
    toolResult = { isError: true, content: [{ type: "text", text: "rate limit" }] };
    await expect(
      createWebSearchTool({ config })!.execute("error", { query: "hello" }),
    ).rejects.toThrow("search error");
  });
  it("honors cancellation before connecting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWebSearchTool({ config })!.execute("cancel", { query: "hello" }, controller.signal),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("bounds a stalled handshake by the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    const cfg = {
      tools: { web: { search: { provider: "parallel" as const, timeoutSeconds: 1 } } },
    };
    await expect(
      createWebSearchTool({ config: cfg })!.execute("timeout", { query: "hello" }),
    ).rejects.toThrow();
  });
  it("caches successful results without another MCP session", async () => {
    const cfg = {
      tools: { web: { search: { provider: "parallel" as const, cacheTtlMinutes: 1 } } },
    };
    const tool = createWebSearchTool({ config: cfg })!;
    await tool.execute("first", { query: "unique cached query" });
    const count = requests.length;
    expect((await tool.execute("second", { query: "unique cached query" })).details).toMatchObject({
      cached: true,
    });
    expect(requests).toHaveLength(count);
  });
});
