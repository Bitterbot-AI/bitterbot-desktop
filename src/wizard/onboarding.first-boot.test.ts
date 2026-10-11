import { describe, expect, it } from "vitest";
import { isFirstBootOnlyConfig } from "./onboarding.first-boot.js";

describe("isFirstBootOnlyConfig", () => {
  it("a container first-boot file (token + meta + commands) is not a setup", () => {
    expect(
      isFirstBootOnlyConfig({
        gateway: { auth: { mode: "token", token: "abc" } },
        meta: { lastTouchedVersion: "1.5.0" },
        commands: { native: "auto" },
      }),
    ).toBe(true);
    expect(isFirstBootOnlyConfig({})).toBe(true);
    expect(isFirstBootOnlyConfig(undefined)).toBe(true);
  });

  it("anything chosen by a person counts as an existing setup", () => {
    expect(isFirstBootOnlyConfig({ gateway: { mode: "local", auth: { token: "x" } } })).toBe(false);
    expect(isFirstBootOnlyConfig({ agents: { defaults: { model: "a/b" } } })).toBe(false);
    expect(isFirstBootOnlyConfig({ channels: { telegram: {} } })).toBe(false);
  });
});
