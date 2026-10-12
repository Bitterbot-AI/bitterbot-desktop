import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { findDeprecatedConfigKeys } from "../config/io.js";
import {
  configUsesInclude,
  json5HasComments,
  locateConfigKey,
  parseConfigPath,
  removeDeprecatedConfigKeys,
} from "./doctor-deprecated-config.js";

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
    // The input is not mutated.
    expect(raw).toEqual(original);
  });

  it("leaves a live compaction mode alone", () => {
    const out = fix({ agents: { defaults: { compaction: { mode: "default" } } } });
    expect(out.changes).toEqual([]);
    expect(out.config).toEqual({ agents: { defaults: { compaction: { mode: "default" } } } });
  });
});

describe("memory.curiosity.autoResearch.enabled is not deprecated (live key)", () => {
  it("is never reported or removed", () => {
    const raw = { memory: { curiosity: { autoResearch: { enabled: false } } } };
    expect(findDeprecatedConfigKeys(raw)).toEqual([]);
    expect(fix(raw).config).toEqual(raw);
  });
});

describe("include and comment detection (HIGH-1)", () => {
  it("finds $include anywhere and names the file a key lives in", () => {
    const parsed = { ui: {}, agents: { $include: "./agents.json5" } };
    expect(configUsesInclude(parsed)).toBe(true);
    expect(configUsesInclude({ agents: { list: [{ id: "a" }] } })).toBe(false);
    expect(locateConfigKey(parsed, "agents.defaults.contextPruning")).toBe("./agents.json5");
    expect(locateConfigKey(parsed, "memory.backend")).toBeNull();
  });

  it("detects JSON5 comments outside strings only", () => {
    expect(json5HasComments('// c\n{"a": 1}')).toBe(true);
    expect(json5HasComments('{"a": 1 /* c */}')).toBe(true);
    expect(json5HasComments('{"url": "https://x.example/a"}')).toBe(false);
    expect(json5HasComments('{"a": "it\'s // fine"}')).toBe(false);
    expect(json5HasComments(null)).toBe(false);
  });
});
