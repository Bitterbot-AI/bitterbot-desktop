/**
 * Review 3 (2026-10-02) of the tool result cache. Each test pins a defect the
 * review found, now fixed.
 */
import { describe, expect, it, vi } from "vitest";
import { wrapToolWithCache } from "./agent-tools.cache.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { ToolCache } from "./tool-cache.js";
import { jsonResult } from "./tools/common.js";

function tool(name: string, run: (params: unknown) => string) {
  const execute = vi.fn(async (_id: string, params: unknown) => ({
    content: [{ type: "text", text: run(params) }],
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

// What agent-tools.ts passes: agent, workspace, session, sandbox state.
const scope = (session: string, where: "host" | "sandbox") =>
  ["main", "/home/user/workspace", session, where].join("\u0000");

describe("tool result cache (review 3)", () => {
  it("nested argument objects distinguish keys", () => {
    const cache = new ToolCache({ cacheableTools: ["plugin_search"] });
    const a = cache.generateKey("plugin_search", { query: "x", filter: { owner: "alice" } });
    const b = cache.generateKey("plugin_search", { query: "x", filter: { owner: "bob" } });
    expect(a).not.toBe(b);
    // Key order still does not matter, at any depth.
    expect(cache.generateKey("t", { a: 1, b: { c: 2, d: 3 } })).toBe(
      cache.generateKey("t", { b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("a nested-argument tool answers each call for its own arguments", async () => {
    const cache = new ToolCache({ cacheableTools: ["plugin_search"] });
    const search = tool("plugin_search", (p) => JSON.stringify(p));
    const cached = wrapToolWithCache(search.tool, cache, scope("s1", "host"));
    const first = text(
      await cached.execute!("c1", { filter: { owner: "alice" } }, undefined, undefined),
    );
    const second = text(
      await cached.execute!("c2", { filter: { owner: "bob" } }, undefined, undefined),
    );
    expect(second).not.toBe(first);
    expect(search.execute).toHaveBeenCalledTimes(2);
  });

  it("a sandboxed session is not served what an unsandboxed session of the same agent computed", async () => {
    const cache = new ToolCache({ cacheableTools: ["image"] });
    const host = tool("image", () => "host: a photo");
    const sandboxed = tool("image", () => {
      throw new Error("Sandboxed image tool does not allow remote URLs.");
    });
    const ownerSession = wrapToolWithCache(host.tool, cache, scope("agent:main:main", "host"));
    const groupSession = wrapToolWithCache(
      sandboxed.tool,
      cache,
      scope("agent:main:group:g1", "sandbox"),
    );
    const args = { image: "https://example.com/private.png" };
    await ownerSession.execute!("c1", args, undefined, undefined);
    await expect(groupSession.execute!("c2", args, undefined, undefined)).rejects.toThrow(
      "Sandboxed image tool does not allow remote URLs.",
    );
  });

  it("a returned (not thrown) failure is not cached", async () => {
    // memory-tool.ts returns `{ results: [], disabled: true, error }` when the
    // embedding provider times out; it does not throw.
    const cache = new ToolCache({ cacheableTools: ["memory_search"] });
    let healthy = false;
    const execute = vi.fn(async () =>
      healthy
        ? jsonResult({ results: [{ snippet: "the decision" }] })
        : jsonResult({ results: [], disabled: true, error: "timeout" }),
    );
    const search = {
      name: "memory_search",
      label: "memory_search",
      description: "memory_search",
      parameters: {},
      execute,
    } as unknown as AnyAgentTool;
    const cached = wrapToolWithCache(search, cache, scope("s1", "host"));
    await cached.execute!("c1", { query: "what did we decide" }, undefined, undefined);
    healthy = true;
    const retry = text(
      await cached.execute!("c2", { query: "what did we decide" }, undefined, undefined),
    );
    expect(retry).toContain("the decision");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("image and memory_search are not cached by default: local state can change under them", () => {
    const cache = new ToolCache();
    expect(cache.isCacheable("image")).toBe(false);
    expect(cache.isCacheable("memory_search")).toBe(false);
    expect(cache.isCacheable("read")).toBe(false);
    expect(cache.isCacheable("web_search")).toBe(true);
    expect(cache.isCacheable("web_fetch")).toBe(true);
  });
});
