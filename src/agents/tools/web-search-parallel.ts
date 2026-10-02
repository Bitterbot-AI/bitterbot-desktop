import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../../version.js";

const SEARCH_MCP_URL = "https://search.parallel.ai/mcp";

export type ParallelSearchResult = {
  title: string;
  url: string;
  description: string;
};

/** Free, anonymous Search MCP. Never reads API keys or saved MCP credentials. */
export async function runParallelSearch(params: {
  query: string;
  count: number;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<ParallelSearchResult[]> {
  const deadline = AbortSignal.timeout(params.timeoutSeconds * 1000);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const client = new Client({ name: "bitterbot", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(SEARCH_MCP_URL), {
    // The same deadline covers initialization, discovery, search and cleanup.
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }),
    requestInit: { headers: { "User-Agent": `Bitterbot/${VERSION}` } },
  });
  try {
    await client.connect(transport, { signal });
    const tools = await client.listTools({}, { signal });
    if (!tools.tools.some((tool) => tool.name === "web_search")) {
      throw new Error("Parallel Search MCP does not expose web_search.");
    }
    const response = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: "web_search",
          arguments: { objective: params.query, search_queries: [params.query] },
        },
        CallToolResultSchema,
        { signal },
      ),
    );
    if (response.isError) {
      throw new Error("Parallel Search MCP returned a search error.");
    }
    const text = response.content.find((block) => block.type === "text");
    const data: unknown =
      response.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text) : undefined);
    if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) {
      throw new Error("Parallel Search MCP returned an invalid search response.");
    }
    return data.results
      .flatMap((entry: unknown) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("url" in entry) ||
          typeof entry.url !== "string"
        ) {
          return [];
        }
        try {
          const url = new URL(entry.url);
          if (url.protocol !== "https:" && url.protocol !== "http:") return [];
        } catch {
          return [];
        }
        return [
          {
            url: entry.url,
            title: "title" in entry && typeof entry.title === "string" ? entry.title : "",
            description:
              "excerpts" in entry && Array.isArray(entry.excerpts)
                ? entry.excerpts
                    .filter((excerpt: unknown) => typeof excerpt === "string")
                    .join("\n\n")
                : "",
          },
        ];
      })
      .slice(0, params.count);
  } finally {
    await client.close().catch(() => {});
  }
}
