import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/io.js", () => ({
  readConfigFileSnapshot: async () => ({ resolved: { skills: { prior: { writer: "on" } } } }),
}));

const { createSelfStateTool } = await import("./self-state-tool.js");

describe("self_state tool", () => {
  it("is not offered to guests or without a config", () => {
    expect(createSelfStateTool({ config: {}, guest: true })).toBeNull();
    expect(createSelfStateTool({})).toBeNull();
  });

  it("reports state, mode, who set it and the setting, filtered by area", async () => {
    const config = { skills: { prior: { writer: "on" as const } } };
    const tool = createSelfStateTool({ config });
    const result = await tool!.execute("call-1", { area: "skills" });
    const body = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as {
      parts: Array<Record<string, unknown>>;
    };
    expect(body.parts.every((p) => p.area === "skills")).toBe(true);
    expect(body.parts.find((p) => p.part === "verified-outcome recording")).toMatchObject({
      state: "on",
      setBy: "owner's config",
      setting: "skills.prior.writer",
    });
    expect(body.parts.find((p) => p.part === "experience-guided skill order")).toMatchObject({
      state: "on",
      mode: "mean",
      setBy: "default",
    });
  });
});
