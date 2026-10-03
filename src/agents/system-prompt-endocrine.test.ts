import { describe, expect, it } from "vitest";
import { buildEndocrineStateSection } from "./system-prompt-endocrine.js";

// Soak finding (2026-10-02): with every hormone near its ceiling, Haiku answered
// "reply with only its output" turns with a mood paragraph on 6 of 86 runs, on
// both engines. The tone hints need an explicit precedence rule.
const maxed = {
  dopamine: 0.95,
  cortisol: 0.9,
  oxytocin: 0.95,
  briefing:
    "be enthusiastic and celebrate wins, be warm and personal, feel free to elaborate and be detailed, ask follow-up questions when curious",
};

describe("buildEndocrineStateSection", () => {
  it("renders the hormone lines and the briefing", () => {
    const lines = buildEndocrineStateSection({ endocrineState: maxed, isMinimal: false });
    expect(
      lines.some((l) => l.startsWith("- Dopamine: 0.9") || l.startsWith("- Dopamine: 1.0")),
    ).toBe(true);
    expect(lines.some((l) => l.includes(maxed.briefing))).toBe(true);
  });

  it("tells the model that an explicit output request beats the tone hints", () => {
    const lines = buildEndocrineStateSection({ endocrineState: maxed, isMinimal: false });
    const briefingAt = lines.findIndex((l) => l.includes("Modulate your tone naturally"));
    const ruleAt = lines.findIndex(
      (l) => l.includes("shape tone only") && l.includes("give exactly that and nothing else"),
    );
    expect(briefingAt).toBeGreaterThanOrEqual(0);
    expect(ruleAt).toBeGreaterThan(briefingAt);
  });

  it("omits the whole block when no hormone state is available", () => {
    const lines = buildEndocrineStateSection({ endocrineState: undefined, isMinimal: false });
    expect(lines.some((l) => l.includes("shape tone only"))).toBe(false);
    expect(lines.some((l) => l.startsWith("- Dopamine"))).toBe(false);
  });
});
