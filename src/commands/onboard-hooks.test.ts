import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { applyQuickstartHookDefaults, QUICKSTART_DEFAULT_HOOKS } from "./onboard-hooks.js";

describe("applyQuickstartHookDefaults (PLAN-41 D-M)", () => {
  it("enables the hook system and the zero-config local built-ins", () => {
    const out = applyQuickstartHookDefaults({});
    expect(out.hooks?.internal?.enabled).toBe(true);
    for (const name of QUICKSTART_DEFAULT_HOOKS) {
      expect(out.hooks?.internal?.entries?.[name]).toMatchObject({ enabled: true });
    }
    expect(out.hooks?.internal?.entries?.["bootstrap-extra-files"]).toBeUndefined();
  });

  it("leaves a config with an explicit hooks.internal.enabled choice alone", () => {
    const enabledCfg: BitterbotConfig = {
      hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: false } } } },
    };
    expect(applyQuickstartHookDefaults(enabledCfg)).toBe(enabledCfg);

    const disabledCfg: BitterbotConfig = { hooks: { internal: { enabled: false } } };
    expect(applyQuickstartHookDefaults(disabledCfg)).toBe(disabledCfg);
  });
});
