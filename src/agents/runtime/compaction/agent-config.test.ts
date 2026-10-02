import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../../config/config.js";
import { BitterbotSchema } from "../../../config/zod-schema.js";
import { resolveAgentCompaction } from "./agent-config.js";

const cfg = {
  agents: {
    defaults: {
      compaction: { policy: "summary", offload: { toolOutputStubs: true, minKeepUserTurns: 3 } },
    },
    list: [
      { id: "main" },
      { id: "drill", compaction: { policy: "offload", offload: { minKeepUserTurns: 1 } } },
      { id: "quiet", compaction: { offload: { toolOutputStubs: false } } },
    ],
  },
} as unknown as BitterbotConfig;

describe("resolveAgentCompaction", () => {
  it("falls back to the defaults, and to `summary` with no config at all", () => {
    expect(resolveAgentCompaction(undefined, "main")).toEqual({ policy: "summary", offload: {} });
    expect(resolveAgentCompaction(cfg, "main")).toEqual({
      policy: "summary",
      offload: { toolOutputStubs: true, minKeepUserTurns: 3 },
    });
    expect(resolveAgentCompaction(cfg).policy).toBe("summary");
  });

  it("layers an agent's settings over the defaults, field by field", () => {
    expect(resolveAgentCompaction(cfg, "drill")).toEqual({
      policy: "offload",
      offload: { toolOutputStubs: true, minKeepUserTurns: 1 },
    });
    expect(resolveAgentCompaction(cfg, "quiet")).toEqual({
      policy: "summary",
      offload: { toolOutputStubs: false, minKeepUserTurns: 3 },
    });
  });

  it("matches agent ids the way the rest of the config does", () => {
    expect(resolveAgentCompaction(cfg, "DRILL").policy).toBe("offload");
    expect(resolveAgentCompaction(cfg, "nobody").policy).toBe("summary");
  });

  it("is accepted by the config schema on an agent entry", () => {
    const parsed = BitterbotSchema.safeParse({
      agents: {
        list: [{ id: "drill", compaction: { policy: "offload", offload: { summary: "idle" } } }],
      },
    });
    expect(parsed.success).toBe(true);
    const rejected = BitterbotSchema.safeParse({
      agents: { list: [{ id: "drill", compaction: { mode: "safeguard" } }] },
    });
    expect(rejected.success).toBe(false);
  });
});
