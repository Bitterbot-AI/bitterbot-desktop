import { describe, expect, it } from "vitest";
import { normalizePluginsConfig } from "./config-state.js";

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
