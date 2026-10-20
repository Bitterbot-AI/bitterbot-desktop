import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { defaultHarnessPolicy, resolveHarnessPolicy } from "./harness-policy.js";

describe("HarnessPolicy (PLAN-25 Phase 0)", () => {
  it("defaultHarnessPolicy is the behavior-neutral baseline", () => {
    const p = defaultHarnessPolicy();
    expect(p.version).toBe(0);
    expect(p.provenance).toBe("default");
    expect(p.compaction.mode).toBe("default");
    expect(p.compaction.maxHistoryShare).toBeUndefined();
  });

  it("resolving an empty/undefined config equals the default for every wired surface", () => {
    const fromUndefined = resolveHarnessPolicy(undefined);
    const fromEmpty = resolveHarnessPolicy({} as BitterbotConfig);
    expect(fromUndefined.compaction).toEqual(defaultHarnessPolicy().compaction);
    expect(fromEmpty.compaction).toEqual(defaultHarnessPolicy().compaction);
  });

  it("reflects compaction.mode === safeguard from config", () => {
    const cfg = {
      agents: { defaults: { compaction: { mode: "safeguard" } } },
    } as unknown as BitterbotConfig;
    expect(resolveHarnessPolicy(cfg).compaction.mode).toBe("safeguard");
  });

  it("passes maxHistoryShare through verbatim and leaves it undefined when unset", () => {
    const withShare = {
      agents: { defaults: { compaction: { mode: "safeguard", maxHistoryShare: 0.7 } } },
    } as unknown as BitterbotConfig;
    expect(resolveHarnessPolicy(withShare).compaction.maxHistoryShare).toBe(0.7);

    const withoutShare = {
      agents: { defaults: { compaction: { mode: "safeguard" } } },
    } as unknown as BitterbotConfig;
    expect(resolveHarnessPolicy(withoutShare).compaction.maxHistoryShare).toBeUndefined();
  });

  it("treats any non-safeguard mode (including unset) as default", () => {
    const unset = { agents: { defaults: { compaction: {} } } } as unknown as BitterbotConfig;
    expect(resolveHarnessPolicy(unset).compaction.mode).toBe("default");
  });
});
