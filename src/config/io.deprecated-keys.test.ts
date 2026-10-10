import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDeprecatedConfigWarningsForTests, warnOnDeprecatedConfigKeys } from "./io.js";

describe("warnOnDeprecatedConfigKeys (PLAN-56 Phase 1)", () => {
  beforeEach(() => {
    resetDeprecatedConfigWarningsForTests();
  });

  it("warns nothing for a config without deprecated keys", () => {
    const warn = vi.fn();
    const warned = warnOnDeprecatedConfigKeys(
      { memory: { citations: "auto" }, agents: { defaults: { compaction: { mode: "default" } } } },
      { warn },
    );
    expect(warned).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per present key, with the registry reason", () => {
    const warn = vi.fn();
    const warned = warnOnDeprecatedConfigKeys(
      {
        memory: { backend: "builtin", curiosity: { autoResearch: { enabled: false } } },
        agents: {
          defaults: { runtime: { engine: "pi" }, contextPruning: { mode: "cache-ttl" } },
          list: [{ id: "a" }, { id: "b", runtime: { engine: "pi" } }],
        },
      },
      { warn },
    );
    expect(warned).toEqual([
      "memory.backend",
      "memory.curiosity.autoResearch.enabled",
      "agents.defaults.runtime.engine",
      "agents.list[1].runtime.engine",
      "agents.defaults.contextPruning",
    ]);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls[0][0]).toContain('Config key "memory.backend" is deprecated: ');
    expect(warn.mock.calls[0][0]).toContain("removed next release");
  });

  it("warns for compaction.mode only when the value is safeguard", () => {
    const warn = vi.fn();
    expect(
      warnOnDeprecatedConfigKeys(
        { agents: { defaults: { compaction: { mode: "default" } } } },
        { warn },
      ),
    ).toEqual([]);
    expect(
      warnOnDeprecatedConfigKeys(
        { agents: { defaults: { compaction: { mode: "safeguard" } } } },
        { warn },
      ),
    ).toEqual(["agents.defaults.compaction.mode"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("dedupes across repeated loads in one process", () => {
    const warn = vi.fn();
    const raw = { memory: { backend: "builtin" } };
    expect(warnOnDeprecatedConfigKeys(raw, { warn })).toEqual(["memory.backend"]);
    expect(warnOnDeprecatedConfigKeys(raw, { warn })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnOnDeprecatedConfigKeys(raw, { warn }, { once: false })).toEqual(["memory.backend"]);
  });

  it("ignores non-object input", () => {
    const warn = vi.fn();
    expect(warnOnDeprecatedConfigKeys(null, { warn })).toEqual([]);
    expect(warnOnDeprecatedConfigKeys("x", { warn })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
