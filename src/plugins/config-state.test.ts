import { describe, expect, it } from "vitest";
import { normalizePluginsConfig, resolveEnableState } from "./config-state.js";

describe("normalizePluginsConfig", () => {
  it("returns null memory slot when not specified", () => {
    const result = normalizePluginsConfig({});
    expect(result.slots.memory).toBeNull();
  });

  it("respects explicit memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "custom-memory" },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("disables memory slot when set to 'none'", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "none" },
    });
    expect(result.slots.memory).toBeNull();
  });
});

describe("resolveEnableState (bundled channel preload)", () => {
  it("registers bundled channel extensions by default so a fresh node can set them up from the UI", () => {
    const normalized = normalizePluginsConfig({});
    for (const id of ["telegram", "whatsapp", "discord", "slack", "signal", "twitch"]) {
      expect(resolveEnableState(id, "bundled", normalized).enabled).toBe(true);
    }
  });

  it("still honors an explicit enabled:false for a bundled channel", () => {
    const normalized = normalizePluginsConfig({ entries: { telegram: { enabled: false } } });
    const state = resolveEnableState("telegram", "bundled", normalized);
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe("disabled in config");
  });

  it("keeps other bundled plugins disabled by default", () => {
    const normalized = normalizePluginsConfig({});
    expect(resolveEnableState("google-gemini-cli-auth", "bundled", normalized).enabled).toBe(false);
  });
});
