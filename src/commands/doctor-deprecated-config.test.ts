import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { findDeprecatedConfigKeys } from "../config/io.js";
import { parseConfigPath, removeDeprecatedConfigKeys } from "./doctor-deprecated-config.js";

function fix(raw: Record<string, unknown>) {
  return removeDeprecatedConfigKeys(raw as BitterbotConfig, findDeprecatedConfigKeys(raw));
}

describe("parseConfigPath", () => {
  it("splits dotted paths with array indexes", () => {
    expect(parseConfigPath("agents.list[1].runtime.engine")).toEqual([
      "agents",
      "list",
      1,
      "runtime",
      "engine",
    ]);
    expect(parseConfigPath("memory.backend")).toEqual(["memory", "backend"]);
  });
});

describe("removeDeprecatedConfigKeys (doctor --fix)", () => {
  it("removes every inert deprecated key by exact path and leaves live siblings", () => {
    const raw = {
      memory: { backend: "builtin", citations: "auto" },
      agents: {
        defaults: {
          runtime: { engine: "pi" },
          compaction: { mode: "safeguard", reserveTokensFloor: 1000 },
          contextPruning: { mode: "cache-ttl" },
        },
        list: [{ id: "a" }, { id: "b", runtime: { engine: "pi" } }],
      },
      update: { uiRestart: { enabled: true }, channel: "stable" },
    };
    const original = structuredClone(raw);
    const out = fix(raw);
    const cfg = out.config as Record<string, never>;
    expect(cfg).toEqual({
      memory: { citations: "auto" },
      agents: {
        defaults: { compaction: { reserveTokensFloor: 1000 } },
        list: [{ id: "a" }, { id: "b" }],
      },
      update: { channel: "stable" },
    });
    expect(out.changes).toHaveLength(6);
    expect(out.kept).toEqual([]);
    // The input is not mutated.
    expect(raw).toEqual(original);
  });

  it("leaves a live compaction mode alone", () => {
    const out = fix({ agents: { defaults: { compaction: { mode: "default" } } } });
    expect(out.changes).toEqual([]);
    expect(out.config).toEqual({ agents: { defaults: { compaction: { mode: "default" } } } });
  });

  it("moves autoResearch.enabled=false to research.enabled=false (same effect)", () => {
    const out = fix({
      memory: { curiosity: { autoResearch: { enabled: false, maxPerDay: 3 } } },
    });
    expect(out.config).toEqual({
      memory: { curiosity: { autoResearch: { maxPerDay: 3 }, research: { enabled: false } } },
    });
  });

  it("drops autoResearch.enabled=false when research.enabled is already set", () => {
    const out = fix({
      memory: { curiosity: { autoResearch: { enabled: false }, research: { enabled: true } } },
    });
    expect(out.config).toEqual({ memory: { curiosity: { research: { enabled: true } } } });
  });

  it("keeps autoResearch.enabled=true: the dream engine still reads it", () => {
    const raw = { memory: { curiosity: { autoResearch: { enabled: true } } } };
    const out = fix(raw);
    expect(out.config).toEqual(raw);
    expect(out.kept[0]).toContain("memory.curiosity.autoResearch.enabled");
  });
});
