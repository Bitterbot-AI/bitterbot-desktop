import { describe, it, expect } from "vitest";
import { AdaptiveIntervalController, type ActivityScorer } from "./dream-adaptive-interval.js";

function scorerOf(scores: number[]): ActivityScorer & { calls: number } {
  let i = 0;
  const s = {
    calls: 0,
    getSmoothedActivityScore: () => {
      s.calls += 1;
      return scores[Math.min(i++, scores.length - 1)]!;
    },
  };
  return s;
}

const MIN = 60_000; // one minute in ms

describe("AdaptiveIntervalController", () => {
  it("holds steady at base when activity is in the middle band", () => {
    const c = new AdaptiveIntervalController({ baseMinutes: 120 });
    const s = scorerOf([0.5, 0.5, 0.5, 0.5]);
    expect(c.evaluate(s, 0)).toBe(120);
    expect(c.evaluate(s, 10 * MIN)).toBe(120);
    expect(c.evaluate(s, 20 * MIN)).toBe(120);
    expect(c.evaluate(s, 30 * MIN)).toBe(120);
  });

  it("halves interval after two consecutive high-activity evaluations", () => {
    const c = new AdaptiveIntervalController({ baseMinutes: 120 });
    const s = scorerOf([0.8, 0.8]);
    // First high signal: consecutive counter goes to 1 — no change yet.
    expect(c.evaluate(s, 0)).toBe(120);
    // Second high signal: threshold met → halve (but held back by cooldown 0 → 0 is fine).
    // BUT cooldown is 60 min default and lastChangedAt starts at 0, so first change should fire.
    // Actually, lastChangedAt=0 means elapsed = now-0 = 0, which is < 60min → cooldown active!
    // Fix: advance clock beyond cooldown for the second call.
    expect(c.evaluate(s, 61 * MIN)).toBe(60);
  });

  it("respects cooldown — won't change again within the window", () => {
    const c = new AdaptiveIntervalController({ baseMinutes: 120, cooldownMinutes: 60 });
    const s = scorerOf([0.8, 0.8, 0.9, 0.9]);
    // Two high evaluations → halves to 60.
    c.evaluate(s, 61 * MIN);
    c.evaluate(s, 61 * MIN);
    const after = c.getCurrentMinutes();
    expect(after).toBe(60);

    // Two more immediate high — still in cooldown.
    c.evaluate(s, 62 * MIN);
    c.evaluate(s, 63 * MIN);
    expect(c.getCurrentMinutes()).toBe(60);

    // After cooldown expires and two more consecutive, halve again.
    c.evaluate(s, (61 + 65) * MIN);
    c.evaluate(s, (61 + 66) * MIN);
    expect(c.getCurrentMinutes()).toBe(30);
  });

  it("doubles interval after two consecutive low-activity evaluations", () => {
    const c = new AdaptiveIntervalController({ baseMinutes: 120 });
    const s = scorerOf([0.1, 0.1]);
    expect(c.evaluate(s, 0)).toBe(120);
    expect(c.evaluate(s, 61 * MIN)).toBe(240);
  });

  it("clamps at the ceiling", () => {
    const c = new AdaptiveIntervalController({
      baseMinutes: 200,
      maxMinutes: 240,
      cooldownMinutes: 10,
    });
    const s = scorerOf([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    c.evaluate(s, 0);
    c.evaluate(s, 11 * MIN);
    expect(c.getCurrentMinutes()).toBe(240);
    c.evaluate(s, 22 * MIN);
    c.evaluate(s, 33 * MIN);
    // Already at ceiling — no further doubling.
    expect(c.getCurrentMinutes()).toBe(240);
  });

  it("clamps at the floor", () => {
    const c = new AdaptiveIntervalController({
      baseMinutes: 60,
      minMinutes: 30,
      cooldownMinutes: 10,
    });
    const s = scorerOf([0.9, 0.9, 0.9, 0.9]);
    c.evaluate(s, 0);
    c.evaluate(s, 11 * MIN);
    expect(c.getCurrentMinutes()).toBe(30);
    c.evaluate(s, 22 * MIN);
    c.evaluate(s, 33 * MIN);
    expect(c.getCurrentMinutes()).toBe(30);
  });

  it("resets consecutive counters on middle-band readings (hysteresis)", () => {
    const c = new AdaptiveIntervalController({ baseMinutes: 120, cooldownMinutes: 0 });
    const s = scorerOf([0.8, 0.5, 0.8]);
    c.evaluate(s, 0);
    expect(c.getState().consecutiveAbove).toBe(1);
    c.evaluate(s, 1 * MIN);
    // Middle band resets both counters.
    expect(c.getState().consecutiveAbove).toBe(0);
    c.evaluate(s, 2 * MIN);
    // Back to 1 — doesn't cascade into a change from a single hit.
    expect(c.getState().consecutiveAbove).toBe(1);
    expect(c.getCurrentMinutes()).toBe(120);
  });

  it("honors the starting clamp — baseMinutes > max resolves to max", () => {
    const c = new AdaptiveIntervalController({ baseMinutes: 500, maxMinutes: 240 });
    expect(c.getCurrentMinutes()).toBe(240);
  });

  it("honors the starting clamp — baseMinutes < min resolves to min", () => {
    const c = new AdaptiveIntervalController({ baseMinutes: 10, minMinutes: 30 });
    expect(c.getCurrentMinutes()).toBe(30);
  });

  it("getSmoothedActivityScore is called with the configured window", () => {
    let capturedWindow = 0;
    const scorer: ActivityScorer = {
      getSmoothedActivityScore(windowHours) {
        capturedWindow = windowHours;
        return 0.4;
      },
    };
    const c = new AdaptiveIntervalController({ baseMinutes: 120, windowHours: 4 });
    c.evaluate(scorer, 0);
    expect(capturedWindow).toBe(4);
  });
});
