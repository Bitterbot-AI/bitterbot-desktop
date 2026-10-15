import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OPENAI_DEFAULT_MODEL } from "../../commands/openai-model-default.js";
import { setPricingSnapshotsForTest } from "../../infra/model-pricing-live.js";
import { resetModelPricingMemoForTest, resolveModelPricing } from "../../infra/model-pricing.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { borrowedPriceTemplate } from "../model-forward-compat.js";
import { resolveModel } from "./model.js";

// Unlike model.test.ts, nothing is mocked: this is the real model registry
// (pi-ai's static catalog, no models.json) the embedded runner builds, so a
// default that the catalog does not know and no forward-compat rule covers
// fails here with "Unknown model" instead of on a fresh install.

let agentDir = "";
const prevAgentDir = process.env.BITTERBOT_AGENT_DIR;

beforeAll(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-default-model-"));
  // resolveModelPricing resolves through the default agent dir.
  process.env.BITTERBOT_AGENT_DIR = agentDir;
});
afterAll(() => {
  if (prevAgentDir === undefined) {
    delete process.env.BITTERBOT_AGENT_DIR;
  } else {
    process.env.BITTERBOT_AGENT_DIR = prevAgentDir;
  }
  fs.rmSync(agentDir, { recursive: true, force: true });
});
beforeEach(() => {
  setPricingSnapshotsForTest([]);
  resetModelPricingMemoForTest();
});
afterEach(() => {
  setPricingSnapshotsForTest([]);
  resetModelPricingMemoForTest();
});

function splitRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

describe("runtime default models resolve against the real catalog", () => {
  it("the unconfigured runtime fallback is the Anthropic model setup recommends", () => {
    expect(`${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`).toBe("anthropic/claude-sonnet-5-5");
  });

  it("resolves the runtime fallback via the Claude family clone with a borrowed Sonnet price", () => {
    const { model, error } = resolveModel(DEFAULT_PROVIDER, DEFAULT_MODEL, agentDir);
    expect(error).toBeUndefined();
    expect(model).toMatchObject({
      id: DEFAULT_MODEL,
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    // Cloned from the newest undated Sonnet in the catalog, never an Opus or a dated id.
    expect(borrowedPriceTemplate(model)).toBe("claude-sonnet-4-6");
  });

  it("prices the runtime fallback as estimated until a live entry for the exact id exists", async () => {
    const estimated = await resolveModelPricing({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
    expect(estimated).toMatchObject({
      source: "estimated",
      borrowedFrom: "claude-sonnet-4-6",
      price: { input: 3, output: 15 },
    });

    resetModelPricingMemoForTest();
    setPricingSnapshotsForTest([
      {
        source: "openrouter",
        fetchedAt: Date.now() - 1000,
        entries: {
          "anthropic/claude-sonnet-5-5": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
        },
      },
    ]);
    const live = await resolveModelPricing({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
    expect(live).toMatchObject({
      source: "live",
      borrowedFrom: "claude-sonnet-4-6",
      price: { input: 4, output: 20 },
    });
  });

  it("resolves the OpenAI API-key setup default as a real catalog entry", async () => {
    const { provider, model: modelId } = splitRef(OPENAI_DEFAULT_MODEL);
    expect(`${provider}/${modelId}`).toBe("openai/gpt-5.5");
    const { model, error } = resolveModel(provider, modelId, agentDir);
    expect(error).toBeUndefined();
    expect(model).toMatchObject({ id: "gpt-5.5", provider: "openai", api: "openai-responses" });
    expect(model?.contextWindow).toBeGreaterThan(0);
    // A vendored entry, not a forward-compat clone: its own price, labelled catalog.
    expect(borrowedPriceTemplate(model)).toBeUndefined();
    const pricing = await resolveModelPricing({ provider, model: modelId });
    expect(pricing.source).toBe("catalog");
    expect(pricing.borrowedFrom).toBeUndefined();
    expect(pricing.price.input).toBeGreaterThan(0);
  });
});
