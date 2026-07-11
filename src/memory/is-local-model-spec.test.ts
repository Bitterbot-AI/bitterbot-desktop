/**
 * PLAN-34 Phase 2 adversarial fix: the local-model gate that decides
 * whether autonomous-research depersonalization may egress. A cloud model
 * named as modelTiers.localModel must NOT be treated as local — otherwise
 * the verbatim private note would reach a cloud API.
 */
import { describe, expect, it } from "vitest";
import { isLocalModelSpec } from "./manager.js";

describe("isLocalModelSpec", () => {
  it("accepts known local providers", () => {
    for (const spec of [
      "ollama/llama3.1",
      "lmstudio/qwen2.5",
      "llamacpp/mistral",
      "local/whatever",
      "localai/x",
      "jan/y",
    ]) {
      expect(isLocalModelSpec(spec), spec).toBe(true);
    }
  });

  it("rejects cloud providers and empty/garbage specs (fail closed)", () => {
    for (const spec of [
      "openai/gpt-4o",
      "anthropic/claude-sonnet-5",
      "google/gemini-2.0",
      "openrouter/meta-llama",
      "gpt-4o",
      "",
      undefined,
    ]) {
      expect(isLocalModelSpec(spec), String(spec)).toBe(false);
    }
  });
});
