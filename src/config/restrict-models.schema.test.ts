import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("agents.defaults.restrictModels", () => {
  it("is accepted by the config schema (documented opt-in allowlist)", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          restrictModels: true,
          models: { "anthropic/claude-sonnet-4-5": { alias: "Sonnet" } },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
