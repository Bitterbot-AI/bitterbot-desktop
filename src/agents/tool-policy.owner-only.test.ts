import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { applyOwnerOnlyToolPolicy, isOwnerOnlyToolName } from "./tool-policy.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: {} }),
  } as unknown as AnyAgentTool;
}

describe("owner-only tools", () => {
  it("covers the tools that move money", () => {
    expect(isOwnerOnlyToolName("wallet")).toBe(true);
    expect(isOwnerOnlyToolName("a2a_client")).toBe(true);
    // Reading status and searching the web stay open.
    expect(isOwnerOnlyToolName("a2a_status")).toBe(false);
    expect(isOwnerOnlyToolName("web_fetch")).toBe(false);
  });

  it("removes them for a sender who is not an owner", () => {
    const tools = [tool("wallet"), tool("a2a_client"), tool("read"), tool("browser")];
    const names = applyOwnerOnlyToolPolicy(tools, false).map((entry) => entry.name);
    expect(names).toEqual(["read"]);
  });

  it("keeps them, runnable, for an owner", async () => {
    const tools = [tool("wallet"), tool("a2a_client"), tool("read")];
    const kept = applyOwnerOnlyToolPolicy(tools, true);
    expect(kept.map((entry) => entry.name)).toEqual(["wallet", "a2a_client", "read"]);
    const result = await kept[0]!.execute!("call-1", {}, undefined, undefined);
    expect(result.content).toEqual([{ type: "text", text: "wallet ran" }]);
  });
});
