import { describe, expect, it } from "vitest";
import {
  OPENROUTER_ATTRIBUTION_HEADERS,
  isOpenRouterTarget,
  withOpenRouterAttribution,
} from "./openrouter-attribution.js";

describe("OpenRouter app attribution", () => {
  it("sends the documented headers with a stable app identity", () => {
    expect(OPENROUTER_ATTRIBUTION_HEADERS).toEqual({
      "HTTP-Referer": "https://bitterbot.ai",
      "X-OpenRouter-Title": "Bitterbot",
      "X-Title": "Bitterbot",
      "X-OpenRouter-Categories": "personal-agent,general-chat",
    });
  });

  it("uses at most two recognized, well-formed categories", () => {
    const categories = OPENROUTER_ATTRIBUTION_HEADERS["X-OpenRouter-Categories"].split(",");
    expect(categories.length).toBeLessThanOrEqual(2);
    for (const c of categories) {
      expect(c).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.length).toBeLessThanOrEqual(30);
    }
  });

  it("recognizes OpenRouter by provider id or base URL", () => {
    expect(isOpenRouterTarget({ provider: "openrouter" })).toBe(true);
    expect(
      isOpenRouterTarget({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" }),
    ).toBe(true);
    expect(isOpenRouterTarget({ baseUrl: "https://eu.openrouter.ai/api/v1" })).toBe(true);
    expect(isOpenRouterTarget({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).toBe(
      false,
    );
    expect(isOpenRouterTarget({ baseUrl: "https://openrouter.ai.evil.example/v1" })).toBe(false);
    expect(isOpenRouterTarget({ baseUrl: "not a url" })).toBe(false);
  });

  it("adds headers only for OpenRouter and lets callers override", () => {
    expect(withOpenRouterAttribution({ provider: "anthropic" }, { A: "1" })).toEqual({ A: "1" });
    expect(withOpenRouterAttribution({ provider: "anthropic" })).toBeUndefined();
    expect(
      withOpenRouterAttribution({ provider: "openrouter" }, { "X-OpenRouter-Title": "Custom" }),
    ).toMatchObject({ "HTTP-Referer": "https://bitterbot.ai", "X-OpenRouter-Title": "Custom" });
  });
});
