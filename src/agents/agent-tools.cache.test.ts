import { describe, expect, it, vi } from "vitest";
import { wrapToolWithCache } from "./agent-tools.cache.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { ToolCache } from "./tool-cache.js";

function tool(name: string, answer: () => string) {
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: answer() }],
    details: {},
  }));
  return {
    execute,
    tool: {
      name,
      label: name,
      description: name,
      parameters: {},
      execute,
    } as unknown as AnyAgentTool,
  };
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

describe("tool result cache", () => {
  it("does not cache file reads by default: a changed file is read again", async () => {
    const cache = new ToolCache();
    expect(cache.isCacheable("read")).toBe(false);
    let content = "first version";
    const { tool: read, execute } = tool("read", () => content);
    const cached = wrapToolWithCache(read, cache, "agent-a");
    expect(text(await cached.execute!("c1", { path: "notes.md" }, undefined, undefined))).toBe(
      "first version",
    );
    content = "second version";
    expect(text(await cached.execute!("c2", { path: "notes.md" }, undefined, undefined))).toBe(
      "second version",
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps two agents' results apart for the same arguments", async () => {
    const cache = new ToolCache({ cacheableTools: ["memory_search"] });
    const a = tool("memory_search", () => "agent A's memory");
    const b = tool("memory_search", () => "agent B's memory");
    const forA = wrapToolWithCache(a.tool, cache, "agent-a\u0000/ws/a");
    const forB = wrapToolWithCache(b.tool, cache, "agent-b\u0000/ws/b");
    const query = { query: "what did we decide" };
    expect(text(await forA.execute!("c1", query, undefined, undefined))).toBe("agent A's memory");
    expect(text(await forB.execute!("c2", query, undefined, undefined))).toBe("agent B's memory");
    // Within one agent the second identical call is still served from the cache.
    expect(text(await forA.execute!("c3", query, undefined, undefined))).toBe("agent A's memory");
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(b.execute).toHaveBeenCalledTimes(1);
  });

  it("does not pass the scope to the tool", async () => {
    const cache = new ToolCache();
    const { tool: search, execute } = tool("web_search", () => "results");
    await wrapToolWithCache(search, cache, "agent-a").execute!(
      "c1",
      { query: "x" },
      undefined,
      undefined,
    );
    expect(execute.mock.calls[0]).toEqual(["c1", { query: "x" }, undefined, undefined]);
  });
});
