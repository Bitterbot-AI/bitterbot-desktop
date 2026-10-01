/**
 * PLAN-52A decision 5: under the `offload` compaction policy, `recall_range`
 * is always hot (static per agent, no per-session promotion).
 */
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { HOT_SET_DEFAULT_ALWAYS, resolveHotSetConfig } from "./tool-registry-hot-set.js";

describe("hot set under the offload policy", () => {
  it("leaves the default always-set alone under the summary policy", () => {
    const resolved = resolveHotSetConfig({ config: {} as BitterbotConfig });
    expect(resolved.always).toEqual([...HOT_SET_DEFAULT_ALWAYS]);
    expect(resolved.always).not.toContain("recall_range");
  });

  it("adds recall_range once under offload, also on top of an explicit list", () => {
    const offload = resolveHotSetConfig({
      config: { agents: { defaults: { compaction: { policy: "offload" } } } } as BitterbotConfig,
    });
    expect(offload.always).toEqual([...HOT_SET_DEFAULT_ALWAYS, "recall_range"]);
    const explicit = resolveHotSetConfig({
      config: {
        agents: { defaults: { compaction: { policy: "offload" } } },
        tools: { hotSet: { always: ["read", "recall_range"] } },
      } as BitterbotConfig,
    });
    expect(explicit.always.filter((n) => n === "recall_range")).toHaveLength(1);
  });
});
