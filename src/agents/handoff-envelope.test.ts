import { describe, expect, it } from "vitest";
import {
  __envelopeConsts,
  renderHandoffEnvelope,
  validateHandoffEnvelope,
} from "./handoff-envelope.js";

const { GOAL_MIN, GOAL_MAX, FIELD_ITEMS_MAX } = __envelopeConsts;

describe("validateHandoffEnvelope — happy path", () => {
  it("accepts a minimal goal-only envelope", () => {
    const r = validateHandoffEnvelope({ goal: "Update the wallet onboarding step." });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.goal).toBe("Update the wallet onboarding step.");
      expect(r.value.inputs).toBeUndefined();
    }
  });

  it("accepts a fully-populated envelope", () => {
    const input = {
      goal: "Identify why the wallet view stalls at 30s on a fresh install.",
      inputs: ["src/agents/usage.ts", "session-id 1234"],
      success_criteria: ["Root cause identified", "Reproducer documented"],
      out_of_scope: ["Don't change the Stripe integration"],
      parent_context: ["The user reported a 30s timeout last night."],
    };
    const r = validateHandoffEnvelope(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(input);
    }
  });

  it("trims and drops empty arrays", () => {
    const r = validateHandoffEnvelope({
      goal: "  Fix the failing build pipeline.  ",
      inputs: [],
      success_criteria: ["  CI is green  "],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.goal).toBe("Fix the failing build pipeline.");
      expect(r.value.inputs).toBeUndefined();
      expect(r.value.success_criteria).toEqual(["CI is green"]);
    }
  });
});

describe("validateHandoffEnvelope — rejects bad input", () => {
  it("rejects non-object", () => {
    expect(validateHandoffEnvelope(null).ok).toBe(false);
    expect(validateHandoffEnvelope("string").ok).toBe(false);
    expect(validateHandoffEnvelope([]).ok).toBe(false);
  });

  it("rejects missing goal", () => {
    const r = validateHandoffEnvelope({ inputs: ["a"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("goal");
  });

  it("rejects too-short goal", () => {
    const r = validateHandoffEnvelope({ goal: "do" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe("goal");
      expect(r.message).toContain(`${GOAL_MIN}`);
    }
  });

  it("rejects too-long goal", () => {
    const r = validateHandoffEnvelope({ goal: "a".repeat(GOAL_MAX + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(`${GOAL_MAX}`);
  });

  it("rejects trivial goals (long enough to pass length but semantically empty)", () => {
    for (const g of ["do the thing", "do the work", "figure it out"]) {
      const r = validateHandoffEnvelope({ goal: g });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("vague");
    }
  });

  it("rejects non-array list fields", () => {
    const r = validateHandoffEnvelope({
      goal: "Refactor the bash exec layer.",
      inputs: "not an array",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("inputs");
  });

  it("rejects non-string list entries", () => {
    const r = validateHandoffEnvelope({
      goal: "Refactor the bash exec layer.",
      inputs: ["ok", 42],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("inputs");
  });

  it("caps list length", () => {
    const big = Array.from({ length: FIELD_ITEMS_MAX + 1 }, (_, i) => `item ${i}`);
    const r = validateHandoffEnvelope({
      goal: "Refactor the bash exec layer.",
      success_criteria: big,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("success_criteria");
  });
});

describe("renderHandoffEnvelope", () => {
  it("renders only the goal when nothing else is provided", () => {
    const out = renderHandoffEnvelope({ goal: "Audit the payment flow." });
    expect(out).toBe("# Handoff\n\n**Goal:** Audit the payment flow.");
  });

  it("renders all sections when populated", () => {
    const out = renderHandoffEnvelope({
      goal: "Audit the payment flow.",
      inputs: ["src/wallet/onramp.ts", "session-key 4242"],
      success_criteria: ["No 401 in 50 trials", "Stripe webhook captured"],
      out_of_scope: ["Don't touch bank API"],
      parent_context: ["User saw 30s timeout last night."],
    });
    expect(out).toContain("# Handoff");
    expect(out).toContain("**Goal:** Audit the payment flow.");
    expect(out).toContain("**Inputs:**");
    expect(out).toContain("- src/wallet/onramp.ts");
    expect(out).toContain("**Success criteria:**");
    expect(out).toContain("- No 401 in 50 trials");
    expect(out).toContain("**Out of scope:**");
    expect(out).toContain("- Don't touch bank API");
    expect(out).toContain("**Parent context:**");
    expect(out).toContain("- User saw 30s timeout last night.");
  });

  it("omits empty sections", () => {
    const out = renderHandoffEnvelope({
      goal: "Audit the payment flow.",
      inputs: undefined,
      success_criteria: ["covered"],
    });
    expect(out).not.toContain("**Inputs:**");
    expect(out).toContain("**Success criteria:**");
  });
});
