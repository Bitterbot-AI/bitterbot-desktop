import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";

const snapshot = vi.hoisted(() => ({
  current: {
    valid: true,
    resolved: { skills: { prior: { writer: "on" } } } as unknown,
    config: { skills: { prior: { writer: "on" } } } as unknown,
  },
}));
const paused = vi.hoisted(() => ({ value: false }));

vi.mock("../../config/io.js", () => ({
  readConfigFileSnapshot: async () => snapshot.current,
}));
vi.mock("../../memory/index.js", () => ({
  peekMemorySearchManager: async () => ({
    manager: { curiosityResearchPaused: async () => paused.value },
  }),
}));
vi.mock("../../compute/awareness/index.js", () => ({
  getComputeBackend: () => null,
  getComputeRuntime: () => null,
}));

const { createSelfStateTool } = await import("./self-state-tool.js");

async function parts(config: BitterbotConfig, area?: string) {
  const tool = createSelfStateTool({ config });
  const result = await tool!.execute("call-1", area ? { area } : {});
  const body = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as {
    parts: Array<Record<string, unknown>>;
  };
  return body.parts;
}

beforeEach(() => {
  paused.value = false;
  snapshot.current = {
    valid: true,
    resolved: { skills: { prior: { writer: "on" } } },
    config: { skills: { prior: { writer: "on" } } },
  };
});

describe("self_state tool", () => {
  it("is not offered to guests or without a config", () => {
    expect(createSelfStateTool({ config: {}, guest: true })).toBeNull();
    expect(createSelfStateTool({})).toBeNull();
  });

  it("reports state, mode, who set it and the settings, filtered by area", async () => {
    const skills = await parts({ skills: { prior: { writer: "on" } } }, "skills");
    expect(skills.every((p) => p.area === "skills")).toBe(true);
    expect(skills.find((p) => p.part === "verified-outcome recording")).toMatchObject({
      state: "on",
      setBy: "owner's config",
      settings: ["skills.prior.writer"],
    });
    expect(skills.find((p) => p.part === "experience-guided skill order")).toMatchObject({
      state: "on",
      mode: "mean",
      setBy: "default",
    });
    expect(skills[0]).not.toHaveProperty("nextTurn");
  });

  it("adds what it sees now: the owner's pause, no compute backend", async () => {
    paused.value = true;
    const config = { memory: { curiosity: { research: { enabled: true } } } } as BitterbotConfig;
    snapshot.current = { valid: true, resolved: config, config };
    const all = await parts(config);
    expect(all.find((p) => p.part === "curiosity research")).toMatchObject({
      state: "paused",
      setBy: "owner (live)",
    });
    expect(all.find((p) => p.part === "compute pools")).toMatchObject({ state: "blocked" });
  });

  it("says when the config file changed since the turn started", async () => {
    snapshot.current = {
      valid: true,
      resolved: { memory: { dream: { enabled: false } } },
      config: { memory: { dream: { enabled: false } } },
    };
    const dreams = await parts({}, "dreams");
    expect(dreams.find((p) => p.part === "dream engine")).toMatchObject({
      state: "on",
      nextTurn: "off",
    });
  });
});
