import { describe, expect, it } from "vitest";
import { isFirstBootOnlyConfig, isSetUpSnapshot } from "./onboarding.first-boot.js";

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

  it("only a token (mode unset or token) counts as first-boot auth", () => {
    expect(isFirstBootOnlyConfig({ gateway: { auth: { token: "t" } } })).toBe(true);
    expect(isFirstBootOnlyConfig({ gateway: { auth: { mode: "password", password: "p" } } })).toBe(
      false,
    );
    expect(
      isFirstBootOnlyConfig({ gateway: { auth: { mode: "token", token: "t", extra: 1 } } }),
    ).toBe(false);
    expect(isFirstBootOnlyConfig({ gateway: { auth: { mode: "trusted-proxy" } } })).toBe(false);
  });
});

describe("isSetUpSnapshot", () => {
  const done = { setupInProgress: false };
  it("no config file is not set up", () => {
    expect(isSetUpSnapshot({ exists: false, resolved: {} }, done)).toBe(false);
  });

  it("a first-boot-only file is not set up", () => {
    expect(
      isSetUpSnapshot({ exists: true, resolved: { gateway: { auth: { token: "t" } } } }, done),
    ).toBe(false);
  });

  it("a config a person chose is set up", () => {
    expect(
      isSetUpSnapshot({ exists: true, resolved: { agents: { defaults: { model: "a/b" } } } }, done),
    ).toBe(true);
  });

  it("a browser setup left half done is not set up", () => {
    expect(
      isSetUpSnapshot(
        { exists: true, resolved: { agents: { defaults: { model: "a/b" } } } },
        { setupInProgress: true },
      ),
    ).toBe(false);
  });
});
