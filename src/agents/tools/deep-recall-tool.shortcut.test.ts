/**
 * PLAN-58: the deep_recall "skip the REPL" shortcut must threshold a number
 * on the cosine scale. Under RRF the fused score is rank-only (max about
 * 3/61), so the old `score >= 0.8` test could never pass and every
 * deep_recall paid for the REPL.
 */
import { describe, expect, it } from "vitest";
import { DEEP_RECALL_SHORTCUT_THRESHOLD, isHighConfidenceHit } from "./deep-recall-tool.js";

describe("isHighConfidenceHit", () => {
  it("fires on vector cosine under RRF even though the fused score is tiny", () => {
    expect(
      isHighConfidenceHit({
        score: 3 / 61,
        fusion: "rrf",
        channels: { vector: { rank: 1, score: 0.9 }, keyword: { rank: 1, score: 1 } },
      }),
    ).toBe(true);
  });

  it("does not fire under RRF when the cosine is below threshold", () => {
    expect(
      isHighConfidenceHit({
        score: 3 / 61,
        fusion: "rrf",
        channels: { vector: { rank: 1, score: 0.5 }, keyword: { rank: 1, score: 1 } },
      }),
    ).toBe(false);
  });

  it("does not fire under RRF for a keyword-only hit (no cosine to trust)", () => {
    expect(
      isHighConfidenceHit({
        score: 1 / 61,
        fusion: "rrf",
        channels: { keyword: { rank: 1, score: 1 } },
      }),
    ).toBe(false);
  });

  it("never fires on the fused RRF score alone", () => {
    expect(isHighConfidenceHit({ score: 0.95, fusion: "rrf", channels: {} })).toBe(false);
    expect(isHighConfidenceHit({ score: 0.95, fusion: "rrf" })).toBe(false);
  });

  it("keeps the fused-score rule for weighted and vector-only fusion", () => {
    expect(isHighConfidenceHit({ score: 0.85, fusion: "weighted" })).toBe(true);
    expect(isHighConfidenceHit({ score: 0.6, fusion: "weighted" })).toBe(false);
    expect(isHighConfidenceHit({ score: 0.85, fusion: "vector-only" })).toBe(true);
  });

  it("falls back to the fused score when fusion is unknown (pre-PLAN-58 result shape)", () => {
    expect(isHighConfidenceHit({ score: 0.9 })).toBe(true);
    expect(isHighConfidenceHit({ score: 0.1 })).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(DEEP_RECALL_SHORTCUT_THRESHOLD).toBe(0.8);
    expect(
      isHighConfidenceHit(
        { score: 0, fusion: "rrf", channels: { vector: { rank: 1, score: 0.7 } } },
        0.65,
      ),
    ).toBe(true);
  });
});
