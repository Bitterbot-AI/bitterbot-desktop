import { describe, expect, it } from "vitest";
import { applyOwnerOnlyToolPolicy, isOwnerOnlyToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * The wallet moves real money with dollar caps as its only limit. A person who
 * is not the owner (a group member, a stranger in a DM) must not be able to
 * get the agent to pay them, so their turns do not get the tool at all.
 */

const tool = (name: string): AnyAgentTool =>
  ({
    name,
    label: name,
    description: "",
    parameters: {},
    execute: async () => ({}),
  }) as unknown as AnyAgentTool;

describe("wallet is owner-only", () => {
  it("is in the owner-only set", () => {
    expect(isOwnerOnlyToolName("wallet")).toBe(true);
  });

  it("is not offered on a turn started by someone other than the owner", () => {
    const offered = applyOwnerOnlyToolPolicy([tool("wallet"), tool("web_search")], false).map(
      (t) => t.name,
    );

    expect(offered).toEqual(["web_search"]);
  });

  it("is offered on the owner's own turn", () => {
    const offered = applyOwnerOnlyToolPolicy([tool("wallet"), tool("web_search")], true).map(
      (t) => t.name,
    );

    expect(offered).toEqual(["wallet", "web_search"]);
  });
});
