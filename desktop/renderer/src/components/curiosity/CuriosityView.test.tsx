import { describe, expect, it } from "vitest";
import { describeNextPass, describeQuestionSource } from "./CuriosityView";

describe("Curiosity page words", () => {
  it("says where a question came from and whether it will retry", () => {
    expect(
      describeQuestionSource({ source: "working_memory", attempts: 0, lastOutcome: null }),
    ).toBe("from its own reflections");
    expect(
      describeQuestionSource({ source: "owner", attempts: 1, lastOutcome: "inconclusive" }),
    ).toBe("you asked it to find out; First attempt inconclusive, will try again");
    expect(describeQuestionSource({ source: null, attempts: 0, lastOutcome: null })).toBe(
      "noticed while thinking",
    );
  });

  it("describes the next pass in the future tense", () => {
    const now = 1_800_000_000_000;
    expect(describeNextPass(null, now)).toBe("soon");
    expect(describeNextPass(now - 1, now)).toBe("soon");
    expect(describeNextPass(now + 15 * 60_000, now)).toBe("in 15m");
    expect(describeNextPass(now + 3 * 3_600_000, now)).toBe("in 3h");
  });
});
