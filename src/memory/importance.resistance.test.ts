import { describe, expect, it } from "vitest";
import { calculateImportance, resolveEmotionDecayResistance } from "./importance.js";

describe("emotional decay resistance", () => {
  it("adds the hormones to the configured baseline instead of replacing it", () => {
    // Resting hormones give about 0.076; the baseline must survive.
    expect(resolveEmotionDecayResistance({ hormonal: 0.076 })).toBeCloseTo(0.576);
    expect(resolveEmotionDecayResistance({ configured: 0.3, hormonal: 0.1 })).toBeCloseTo(0.4);
    expect(resolveEmotionDecayResistance({})).toBe(0.5);
  });

  it("caps resistance so charged memories still fade, and can be turned off", () => {
    expect(resolveEmotionDecayResistance({ configured: 0.5, hormonal: 0.5 })).toBe(0.8);
    expect(resolveEmotionDecayResistance({ enabled: false, hormonal: 0.4 })).toBe(0);
  });

  it("keeps a charged memory noticeably longer than a neutral one", () => {
    const month = 30 * 24 * 60 * 60 * 1000;
    const base = {
      semanticRelevance: 1,
      accessCount: 2,
      createdAt: 0,
      lastAccessedAt: Date.now() - month,
    };
    const resistance = resolveEmotionDecayResistance({ hormonal: 0.076 });
    const neutral = calculateImportance({ ...base, emotionalValence: 0 }, undefined, resistance);
    const charged = calculateImportance({ ...base, emotionalValence: 0.9 }, undefined, resistance);
    // About twice the importance after a month without use.
    expect(charged).toBeGreaterThan(neutral * 1.5);
  });
});
