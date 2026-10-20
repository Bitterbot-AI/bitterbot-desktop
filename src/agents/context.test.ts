import { describe, expect, it } from "vitest";
import { applyConfiguredContextWindows, applyDiscoveredContextWindows } from "./context.js";

describe("applyDiscoveredContextWindows", () => {
  it("keeps the smallest context window when duplicate model ids are discovered", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "claude-sonnet-4-5", contextWindow: 1_000_000 },
        { id: "claude-sonnet-4-5", contextWindow: 200_000 },
      ],
    });

    expect(cache.get("claude-sonnet-4-5")).toBe(200_000);
  });
});

describe("applyConfiguredContextWindows", () => {
  it("overrides discovered cache values with explicit models.providers contextWindow", () => {
    const cache = new Map<string, number>([["anthropic/claude-opus-4-6", 1_000_000]]);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "anthropic/claude-opus-4-6", contextWindow: 200_000 }],
          },
        },
      },
    });

    expect(cache.get("anthropic/claude-opus-4-6")).toBe(200_000);
  });

  it("adds config-only model context windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [
              { id: "custom/model", contextWindow: 150_000 },
              { id: "bad/model", contextWindow: 0 },
              { id: "", contextWindow: 300_000 },
            ],
          },
        },
      },
    });

    expect(cache.get("custom/model")).toBe(150_000);
    expect(cache.has("bad/model")).toBe(false);
  });
});
