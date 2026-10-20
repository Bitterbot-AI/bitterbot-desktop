import { describe, expect, it } from "vitest";
import { refuseForGuest } from "./bitterbot-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

const tool = (name: string): AnyAgentTool =>
  ({
    name,
    label: name,
    description: "",
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "private" }], details: "private" }),
  }) as unknown as AnyAgentTool;

describe("refuseForGuest (PLAN-53 G2)", () => {
  it("refuses the tools that expose the owner's dreams, anchors and curiosity", async () => {
    for (const name of [
      "dream_search",
      "create_emotional_anchor",
      "recall_emotional_anchor",
      "curiosity_state",
      "curiosity_resolve",
    ]) {
      const res = await refuseForGuest(tool(name)).execute("c", {});
      expect(JSON.stringify(res.details)).toMatch(/not the owner/);
    }
  });

  it("leaves every other tool as it is", () => {
    const status = tool("dream_status");
    expect(refuseForGuest(status)).toBe(status);
  });
});
