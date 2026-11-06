import { describe, expect, it } from "vitest";
import { SKILL_PRIOR_DEFAULTS, resolveSkillPriorMode } from "../agents/skills/skill-prior.js";
import { FIELD_DEFAULTS } from "./schema.defaults.js";
import { BitterbotSchema } from "./zod-schema.js";

describe("skills.prior evidence configuration", () => {
  it.each(["verbal", "counts", "verdict", "off"])("accepts %s", (evidence) => {
    expect(BitterbotSchema.safeParse({ skills: { prior: { evidence } } }).success).toBe(true);
  });
  it.each(["usage", "VERBAL", "", true, 1])("rejects invalid runtime style %j", (evidence) => {
    expect(BitterbotSchema.safeParse({ skills: { prior: { evidence } } }).success).toBe(false);
  });
  it("keeps legacy config valid with the prior on and wording verbal by default", () => {
    const result = BitterbotSchema.safeParse({ skills: { prior: { mode: "mean" } } });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("legacy prior config rejected");
    }
    expect(resolveSkillPriorMode(result.data.skills?.prior)).toBe("mean");
    expect(resolveSkillPriorMode({ enabled: false })).toBe("off");
    expect(resolveSkillPriorMode(undefined)).toBe("mean");
    expect(SKILL_PRIOR_DEFAULTS.evidence).toBe("verbal");
    expect(FIELD_DEFAULTS["skills.prior.evidence"]).toBe("verbal");
    expect(FIELD_DEFAULTS["skills.prior.enabled"]).toBe(true);
  });
});
