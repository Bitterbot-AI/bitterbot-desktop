/**
 * PLAN-34 Phase 2c/adversarial: URL-finder provider generalization.
 * Brave keeps its native path; any other configured provider routes
 * through the web_search tool's dispatch. Capability detection (enabled +
 * key) degrades to null exactly as before.
 */
import { describe, expect, it } from "vitest";
import { buildUrlFinder } from "./skill-seekers-url-finder.js";

describe("buildUrlFinder", () => {
  it("returns null when web search is disabled", () => {
    expect(buildUrlFinder({ tools: { web: { search: { enabled: false } } } } as never)).toBeNull();
  });

  it("returns null for Brave with no API key", () => {
    const saved = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      expect(
        buildUrlFinder({ tools: { web: { search: { provider: "brave" } } } } as never),
      ).toBeNull();
    } finally {
      if (saved !== undefined) {
        process.env.BRAVE_API_KEY = saved;
      }
    }
  });

  it("builds a finder for a non-Brave provider (generalized path), no Brave key required", () => {
    const finder = buildUrlFinder({
      tools: { web: { search: { provider: "tavily", apiKey: "tvly-x" } } },
    } as never);
    expect(finder).not.toBeNull();
    expect(typeof finder!.findAuthoritativeUrl).toBe("function");
  });

  it("the generalized finder returns null when the provider yields no results (capability degrade)", async () => {
    // No API key resolvable → runConfiguredWebSearch returns null → finder null result.
    const savedP = process.env.PERPLEXITY_API_KEY;
    const savedOr = process.env.OPENROUTER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const finder = buildUrlFinder({
        tools: { web: { search: { provider: "perplexity" } } },
      } as never);
      expect(finder).not.toBeNull();
      expect(await finder!.findAuthoritativeUrl("Next.js route handlers")).toBeNull();
    } finally {
      if (savedP !== undefined) {
        process.env.PERPLEXITY_API_KEY = savedP;
      }
      if (savedOr !== undefined) {
        process.env.OPENROUTER_API_KEY = savedOr;
      }
    }
  });
});
