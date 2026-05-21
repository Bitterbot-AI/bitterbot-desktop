import { describe, expect, it } from "vitest";
import {
  buildNearAiModelDefinition,
  discoverNearAiModels,
  NEARAI_DEFAULT_MODEL_ID,
  NEARAI_MODEL_CATALOG,
} from "./nearai-models.js";

describe("nearai-models", () => {
  it("buildNearAiModelDefinition adds NEAR AI compatibility flags", () => {
    const entry = NEARAI_MODEL_CATALOG.find((model) => model.id === NEARAI_DEFAULT_MODEL_ID);
    expect(entry).toBeDefined();

    const def = buildNearAiModelDefinition(entry!);
    expect(def.id).toBe(NEARAI_DEFAULT_MODEL_ID);
    expect(def.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    });
  });

  it("discoverNearAiModels returns the static catalog in test env", async () => {
    const models = await discoverNearAiModels();
    expect(models.length).toBe(NEARAI_MODEL_CATALOG.length);
    expect(models.map((model) => model.id)).toContain(NEARAI_DEFAULT_MODEL_ID);
  });
});
