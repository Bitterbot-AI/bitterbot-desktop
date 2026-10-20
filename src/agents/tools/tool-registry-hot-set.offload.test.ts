/**
 * PLAN-52A: `recall_range` is hot by default in the chat and cron lanes,
 * because tool-output stubs (default on) and offload notes point at it.
 * Static per agent, no per-session promotion.
 */
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import {
  HOT_SET_DEFAULT_ALWAYS,
  HOT_SET_DEFAULT_MAX,
  HOT_SET_DEFAULT_PER_LANE,
  resolveHotSetConfig,
} from "./tool-registry-hot-set.js";

describe("hot set and the transcript reader", () => {
  it("default: recall_range in chat and cron with its own slot; heartbeat stays lean", () => {
    const r = resolveHotSetConfig({ config: {} as BitterbotConfig });
    expect(r.always).toEqual([...HOT_SET_DEFAULT_ALWAYS]);
    expect(r.perLane.chat).toEqual([...HOT_SET_DEFAULT_PER_LANE.chat, "recall_range"]);
    expect(r.perLane.cron).toContain("recall_range");
    expect(r.perLane.heartbeat).toEqual([...HOT_SET_DEFAULT_PER_LANE.heartbeat]);
    expect(r.perLane.subagent).not.toContain("recall_range");
    expect(r.max).toBe(HOT_SET_DEFAULT_MAX + 1);
  });

  it("stubs off and policy summary: the defaults are untouched", () => {
    const r = resolveHotSetConfig({
      config: {
        agents: { defaults: { compaction: { offload: { toolOutputStubs: false } } } },
      } as BitterbotConfig,
    });
    expect(r.perLane.chat).toEqual([...HOT_SET_DEFAULT_PER_LANE.chat]);
    expect(r.max).toBe(HOT_SET_DEFAULT_MAX);
  });

  it("stubs off but policy offload: still hot", () => {
    const r = resolveHotSetConfig({
      config: {
        agents: {
          defaults: { compaction: { policy: "offload", offload: { toolOutputStubs: false } } },
        },
      } as BitterbotConfig,
    });
    expect(r.perLane.chat).toContain("recall_range");
  });

  it("an operator's explicit lane list and max are respected as written", () => {
    const r = resolveHotSetConfig({
      config: { tools: { hotSet: { max: 4, perLane: { chat: ["exec"] } } } } as BitterbotConfig,
    });
    expect(r.perLane.chat).toEqual(["exec"]);
    expect(r.max).toBe(4);
    // Lanes the operator did not list keep the default with recall_range.
    expect(r.perLane.cron).toContain("recall_range");
  });
});
