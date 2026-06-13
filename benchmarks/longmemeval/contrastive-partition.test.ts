import { describe, expect, it } from "vitest";
import {
  type ContrastiveRecord,
  bucketOf,
  constructionFeedback,
  summarize,
} from "./contrastive-partition.js";

function rec(
  p: Partial<ContrastiveRecord> & { hRight: boolean; hpRight: boolean },
): ContrastiveRecord {
  return {
    questionId: p.questionId ?? "q",
    questionType: p.questionType ?? "multi-session",
    hRight: p.hRight,
    hpRight: p.hpRight,
    hTokens: p.hTokens ?? 1000,
    hpTokens: p.hpTokens ?? 100,
    question: p.question,
    expected: p.expected,
    hypH: p.hypH,
    hypHp: p.hypHp,
  };
}

describe("bucketOf", () => {
  it("classifies the four contrastive outcomes", () => {
    expect(bucketOf({ hRight: true, hpRight: false })).toBe("d_exo");
    expect(bucketOf({ hRight: false, hpRight: true })).toBe("d_end");
    expect(bucketOf({ hRight: true, hpRight: true })).toBe("both_right");
    expect(bucketOf({ hRight: false, hpRight: false })).toBe("both_wrong");
  });
});

describe("summarize", () => {
  it("computes accuracies, buckets, per-type and token efficiency", () => {
    const records = [
      rec({
        questionType: "temporal-reasoning",
        hRight: true,
        hpRight: false,
        hTokens: 2000,
        hpTokens: 200,
      }),
      rec({
        questionType: "temporal-reasoning",
        hRight: false,
        hpRight: true,
        hTokens: 2000,
        hpTokens: 100,
      }),
      rec({
        questionType: "multi-session",
        hRight: true,
        hpRight: true,
        hTokens: 1000,
        hpTokens: 100,
      }),
      rec({
        questionType: "multi-session",
        hRight: false,
        hpRight: false,
        hTokens: 1000,
        hpTokens: 100,
      }),
    ];
    const s = summarize(records);
    expect(s.n).toBe(4);
    expect(s.hAccuracy).toBe(0.5);
    expect(s.hpAccuracy).toBe(0.5);
    expect(s.buckets).toEqual({ d_exo: 1, d_end: 1, both_right: 1, both_wrong: 1 });
    expect(s.byType["temporal-reasoning"]).toEqual({
      n: 2,
      hAcc: 0.5,
      hpAcc: 0.5,
      dExo: 1,
      dEnd: 1,
    });
    // token efficiency: hp mean 125 / h mean 1500
    expect(s.tokens.hMean).toBe(1500);
    expect(s.tokens.hpMean).toBe(125);
    expect(s.tokens.hpFractionOfH).toBeCloseTo(125 / 1500, 5);
  });

  it("handles an empty set without dividing by zero", () => {
    const s = summarize([]);
    expect(s).toMatchObject({ n: 0, hAccuracy: 0, hpAccuracy: 0 });
    expect(s.tokens.hpFractionOfH).toBe(0);
  });
});

describe("constructionFeedback", () => {
  it("emits one exogenous record per D_exo case only", () => {
    const records = [
      rec({
        questionId: "a",
        hRight: true,
        hpRight: false,
        question: "Q",
        expected: "X",
        hypH: "X",
        hypHp: "Y",
      }),
      rec({ questionId: "b", hRight: false, hpRight: true }),
      rec({ questionId: "c", hRight: true, hpRight: true }),
    ];
    const fb = constructionFeedback(records);
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({
      task_id: "a",
      comparison_type: "exogenous",
      winning_method: "baseline_full_raw_history",
      question: "Q",
      expected: "X",
      baseline_answer: "X",
      memory_answer: "Y",
    });
  });
});
