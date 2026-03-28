import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { applyExclusiveSlotSelection } from "./slots.js";

describe("applyExclusiveSlotSelection", () => {
  it("selects the slot and disables other entries for the same kind", () => {
    const config: BitterbotConfig = {
      plugins: {
        slots: { memory: "plugin-a" },
        entries: {
          "plugin-a": { enabled: true },
          "plugin-b": { enabled: true },
        },
      },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "plugin-b",
      selectedKind: "memory",
      registry: {
        plugins: [
          { id: "plugin-a", kind: "memory" },
          { id: "plugin-b", kind: "memory" },
        ],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("plugin-b");
    expect(result.config.plugins?.entries?.["plugin-a"]?.enabled).toBe(false);
  });

  it("does nothing when the slot already matches", () => {
    const config: BitterbotConfig = {
      plugins: {
        slots: { memory: "my-plugin" },
        entries: {
          "my-plugin": { enabled: true },
        },
      },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "my-plugin",
      selectedKind: "memory",
      registry: { plugins: [{ id: "my-plugin", kind: "memory" }] },
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
  });

  it("skips changes when no exclusive slot applies", () => {
    const config: BitterbotConfig = {};
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "custom",
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
  });
});
