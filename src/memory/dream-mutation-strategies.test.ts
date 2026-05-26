/**
 * Tests for the PLAN-21 Phase C rejection-context block on
 * buildStrategyPrompt + renderRejectionsBlock.
 */
import { describe, it, expect } from "vitest";
import {
  buildStrategyPrompt,
  renderRejectionsBlock,
  type RecentRejection,
  selectStrategy,
  __testing,
} from "./dream-mutation-strategies.js";

const SKILL_TEXT = "When user asks to format code, use prettier with default settings.";

describe("renderRejectionsBlock", () => {
  it("returns the empty string when no rejections are supplied", () => {
    expect(renderRejectionsBlock(undefined)).toBe("");
    expect(renderRejectionsBlock([])).toBe("");
  });

  it("renders each rejection with its preview and reason", () => {
    const rejections: RecentRejection[] = [
      { preview: "Use eslint instead", reason: "lost faithfulness on prettier" },
      { preview: "Format only on save", reason: "performance ci95 includes zero" },
    ];
    const block = renderRejectionsBlock(rejections);
    expect(block).toContain("Previously rejected mutations");
    expect(block).toContain("Use eslint instead");
    expect(block).toContain("lost faithfulness on prettier");
    expect(block).toContain("Format only on save");
    expect(block).toContain("performance ci95 includes zero");
  });

  it("appends the delta drop when present", () => {
    const rejections: RecentRejection[] = [
      { preview: "alt phrasing", reason: "regressed", deltaDrop: -0.12 },
    ];
    const block = renderRejectionsBlock(rejections);
    expect(block).toContain("Δ=-0.12");
  });

  it("caps rendered rejections at MAX_REJECTIONS_IN_PROMPT", () => {
    const more: RecentRejection[] = Array.from({ length: 12 }, (_, i) => ({
      preview: `mutation-${i}`,
      reason: `reason-${i}`,
    }));
    const block = renderRejectionsBlock(more);
    expect(block).toContain("mutation-0");
    expect(block).toContain(`mutation-${__testing.MAX_REJECTIONS_IN_PROMPT - 1}`);
    expect(block).not.toContain(`mutation-${__testing.MAX_REJECTIONS_IN_PROMPT}`);
  });

  it("truncates preview to MAX_REJECTION_PREVIEW_CHARS", () => {
    const longPreview = "x".repeat(__testing.MAX_REJECTION_PREVIEW_CHARS + 50);
    const rejections: RecentRejection[] = [{ preview: longPreview, reason: "too long" }];
    const block = renderRejectionsBlock(rejections);
    const matches = block.match(/x+/);
    expect(matches?.[0].length).toBe(__testing.MAX_REJECTION_PREVIEW_CHARS);
  });
});

describe("buildStrategyPrompt with rejection context", () => {
  it("is unchanged when no rejections are supplied", () => {
    const withoutRej = buildStrategyPrompt("generic", SKILL_TEXT, {});
    const withEmpty = buildStrategyPrompt("generic", SKILL_TEXT, {}, []);
    expect(withEmpty).toBe(withoutRej);
  });

  it("prepends the rejections block before the strategy body", () => {
    const rejections: RecentRejection[] = [
      { preview: "Use yarn instead of pnpm", reason: "off-topic mutation" },
    ];
    const prompt = buildStrategyPrompt("generic", SKILL_TEXT, {}, rejections);
    const rejIdx = prompt.indexOf("Previously rejected mutations");
    const bodyIdx = prompt.indexOf("You are a Dream Engine generating skill mutations");
    expect(rejIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(rejIdx);
  });

  it("works across all five strategies", () => {
    const rejections: RecentRejection[] = [{ preview: "p", reason: "r" }];
    for (const strategy of [
      "generic",
      "error_driven",
      "adversarial",
      "compositional",
      "parametric",
    ] as const) {
      const prompt = buildStrategyPrompt(
        strategy,
        SKILL_TEXT,
        { metrics: { totalExecutions: 5, successRate: 0.5, errorBreakdown: {} } },
        rejections,
      );
      expect(prompt).toContain("Previously rejected mutations");
    }
  });
});

describe("selectStrategy unchanged surface", () => {
  it("returns a strategy without rejection input", () => {
    const strategy = selectStrategy({ text: SKILL_TEXT, skillCategory: "format" }, null, 0);
    expect(["generic", "error_driven", "adversarial", "compositional", "parametric"]).toContain(
      strategy,
    );
  });
});
