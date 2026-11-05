import { beforeEach, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { resolveLearningConfig } from "./procedural-learning-contract.js";
import { getProceduralLearning } from "./procedural-learning-host.js";

const mocks = vi.hoisted(() => ({ getManager: vi.fn(), learning: vi.fn() }));
vi.mock("./search-manager.js", () => ({ getMemorySearchManager: mocks.getManager }));

beforeEach(() => {
  mocks.getManager
    .mockReset()
    .mockResolvedValue({ manager: { proceduralLearning: mocks.learning } });
  mocks.learning.mockReset().mockReturnValue(null);
});

it.each<BitterbotConfig>([{}, { memory: {} }, { memory: { proceduralLearning: {} } }])(
  "opens the host service when settings are omitted: %j",
  async (cfg) => {
    await getProceduralLearning({ cfg, agentId: "main" });
    expect(mocks.getManager).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(mocks.learning).toHaveBeenCalledOnce();
  },
);

it("honors explicit off without opening the memory manager", async () => {
  expect(
    await getProceduralLearning({
      cfg: { memory: { proceduralLearning: { mode: "off" } } },
      agentId: "main",
    }),
  ).toBeNull();
  expect(mocks.getManager).not.toHaveBeenCalled();
});

it.each([null, false, "active", { mode: "typo" }, { experienceMemory: { enabled: "false" } }])(
  "rejects malformed settings before opening storage: %j",
  async (value) => {
    const cfg = { memory: { proceduralLearning: value } } as unknown as BitterbotConfig;
    await expect(getProceduralLearning({ cfg, agentId: "main" })).rejects.toThrow();
    expect(mocks.getManager).not.toHaveBeenCalled();
  },
);

it("defaults to shadow capture and honors nested opt-out without requiring unrelated settings", () => {
  expect(resolveLearningConfig(undefined)).toMatchObject({
    mode: "shadow",
    experienceMemory: { enabled: true },
    executionBudget: { providerUsd: 0 },
  });
  expect(resolveLearningConfig({ experienceMemory: { enabled: false } })).toMatchObject({
    mode: "shadow",
    experienceMemory: { enabled: false, minSupport: 2, maxPromptChars: 6000 },
  });
  expect(resolveLearningConfig({ mode: "active" }).mode).toBe("active");
});
