import { describe, expect, it } from "vitest";
import { classifyFeatured, TIER_LABEL, TIER_ORDER } from "./model-featured.js";

describe("classifyFeatured", () => {
  it("tiers the current Anthropic frontier / mid / workhorse models", () => {
    expect(classifyFeatured("anthropic", "claude-opus-5").tier).toBe("frontier");
    expect(classifyFeatured("anthropic", "claude-opus-4-8").tier).toBe("frontier");
    expect(classifyFeatured("anthropic", "claude-fable-5").tier).toBe("frontier");
    expect(classifyFeatured("anthropic", "claude-haiku-4-5-20251001").tier).toBe("workhorse");
  });

  it("marks Claude Sonnet 5 as the single recommended default (mid)", () => {
    const info = classifyFeatured("anthropic", "claude-sonnet-5");
    expect(info.featured).toBe(true);
    expect(info.tier).toBe("mid");
    expect(info.isDefault).toBe(true);
  });

  it("does NOT feature retired / dated snapshots that discovery may still expose", () => {
    // These are real IDs the vendored catalog carries but that we don't promote.
    expect(classifyFeatured("anthropic", "claude-3-5-sonnet-20241022").featured).toBe(false);
    expect(classifyFeatured("anthropic", "claude-sonnet-4-20250514").featured).toBe(false);
    // A dated Sonnet 4.5 snapshot is not the featured Sonnet 5 slot.
    expect(classifyFeatured("anthropic", "claude-sonnet-4-5-20250929").featured).toBe(false);
  });

  it("is case-insensitive on provider and id", () => {
    expect(classifyFeatured("Anthropic", "Claude-Opus-5").tier).toBe("frontier");
  });

  it("features open-weight workhorses via OpenRouter's vendor-pathed ids", () => {
    expect(classifyFeatured("openrouter", "openai/gpt-oss-120b").tier).toBe("workhorse");
    expect(classifyFeatured("openrouter", "z-ai/glm-4.6").tier).toBe("mid");
    expect(classifyFeatured("openrouter", "deepseek/deepseek-v3.2").tier).toBe("mid");
  });

  it("returns not-featured for unconfigured/unknown providers and empties", () => {
    expect(classifyFeatured("some-random-provider", "whatever").featured).toBe(false);
    expect(classifyFeatured("", "claude-opus-5").featured).toBe(false);
    expect(classifyFeatured("anthropic", "").featured).toBe(false);
    expect(classifyFeatured(null, null).featured).toBe(false);
  });

  it("keeps exactly one default across the whole ruleset", () => {
    // Guard against accidentally marking two models as the recommended default.
    const candidates = [
      ["anthropic", "claude-sonnet-5"],
      ["anthropic", "claude-opus-5"],
      ["anthropic", "claude-haiku-4-5"],
      ["openai", "gpt-5-mini"],
      ["google", "gemini-3-flash"],
    ] as const;
    const defaults = candidates.filter(([p, id]) => classifyFeatured(p, id).isDefault);
    expect(defaults).toEqual([["anthropic", "claude-sonnet-5"]]);
  });

  it("exposes a stable tier order and labels", () => {
    expect(TIER_ORDER).toEqual(["frontier", "mid", "workhorse"]);
    expect(TIER_LABEL.frontier).toBe("Frontier");
    expect(TIER_LABEL.workhorse).toBe("Workhorse");
  });
});
