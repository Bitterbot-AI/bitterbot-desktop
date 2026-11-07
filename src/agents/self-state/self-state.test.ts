import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { applyA2aDefaults, applyCirclesDefaults, applyP2pDefaults } from "../../config/defaults.js";
import { FIELD_DEFAULTS, UNSET_MEANS_FALSE } from "../../config/schema.defaults.js";
import { jsonSchemaNodeAtPath } from "../../config/schema.hints.js";
import { BitterbotSchema } from "../../config/zod-schema.js";
import { DEFAULT_MODE_CONFIGS, type DreamMode } from "../../memory/dream-types.js";
import { isWebSearchConfigured } from "../tools/web-search.js";
import { CAPABILITIES } from "./registry.js";
import { renderSelfStateBlock, resolveCapabilities, resolveCapability } from "./render.js";

const JSON_SCHEMA = BitterbotSchema.toJSONSchema({ target: "draft-07", unrepresentable: "any" });
const ENV = {} as NodeJS.ProcessEnv;
const REPO = path.resolve(import.meta.dirname, "../../..");
const GUIDE = fs.readFileSync(path.join(REPO, "skills/memory-architecture/SKILL.md"), "utf8");

/**
 * `memory` is passthrough in the zod schema, so these typed-only keys have no
 * JSON-schema node. Each must still be declared in its TypeScript type file.
 */
const TYPED_ONLY: Record<string, { file: string; field: string }> = {
  "memory.canonicalLedger.enabled": {
    file: "src/config/types.memory.ts",
    field: "canonicalLedger?:",
  },
  "memory.dreamBrief.enabled": { file: "src/config/types.memory.ts", field: "dreamBrief?:" },
  "memory.dream.enabled": { file: "src/memory/dream-types.ts", field: "enabled?: boolean" },
  "memory.dream.skillCurator.enabled": {
    file: "src/memory/dream-types.ts",
    field: "skillCurator?:",
  },
};

function keyExists(key: string): boolean {
  if (jsonSchemaNodeAtPath(JSON_SCHEMA, key) !== undefined) {
    return true;
  }
  const mode = /^memory\.dream\.modes\.([a-z_]+)\.enabled$/.exec(key)?.[1];
  if (mode) {
    return mode in DEFAULT_MODE_CONFIGS;
  }
  const typed = TYPED_ONLY[key];
  return Boolean(
    typed && fs.readFileSync(path.join(REPO, typed.file), "utf8").includes(typed.field),
  );
}

/** What loadConfig() applies before anything reads the config (io.ts). */
function loaded(config: BitterbotConfig): BitterbotConfig {
  return applyA2aDefaults(applyP2pDefaults(applyCirclesDefaults(config)));
}

/**
 * Where the settings form's single checkbox cannot say it: the architect
 * learns rules when unset and applies them only when set to true.
 */
const KNOWN_SPLIT_DEFAULTS = new Set(["memory.architectEvolution.enabled"]);

function withKey(dotted: string, value: unknown): BitterbotConfig {
  const root: Record<string, unknown> = {};
  let node = root;
  const parts = dotted.split(".");
  for (const part of parts.slice(0, -1)) {
    node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
  return root as BitterbotConfig;
}

function stateOf(id: string, config: BitterbotConfig, env = ENV) {
  const capability = CAPABILITIES.find((c) => c.id === id);
  if (!capability) {
    throw new Error(`no capability ${id}`);
  }
  return resolveCapability(capability, config, { env });
}

describe("self-state registry", () => {
  it("names only settings that exist in the config schema", () => {
    const stale = CAPABILITIES.flatMap((c) => c.keys).filter((key) => !keyExists(key));
    expect(stale).toEqual([]);
  });

  it("has unique ids and covers every dream mode", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mode of Object.keys(DEFAULT_MODE_CONFIGS)) {
      expect(ids).toContain(`dream.${mode}`);
    }
  });

  it("reads each part's own switch: turning its first key off turns it off", () => {
    for (const capability of CAPABILITIES) {
      const key = capability.keys[0];
      if (!key.endsWith(".enabled")) {
        continue;
      }
      expect(resolveCapability(capability, withKey(key, false), { env: ENV }).state, key).toBe(
        "off",
      );
    }
  });

  it("agrees with the settings-truth registry on every default it shares", () => {
    const disagreements: string[] = [];
    for (const capability of CAPABILITIES) {
      const key = capability.keys[0];
      if (KNOWN_SPLIT_DEFAULTS.has(key)) {
        continue;
      }
      const unset = resolveCapability(capability, loaded({}), { env: ENV }).state;
      if (key in UNSET_MEANS_FALSE && unset !== "off") {
        disagreements.push(`${key}: registry says off when unset, self-state says ${unset}`);
      }
      if (FIELD_DEFAULTS[key] === true && unset === "off") {
        disagreements.push(`${key}: registry says on when unset, self-state says off`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("reports the shipped defaults", () => {
    const byId = Object.fromEntries(
      resolveCapabilities(loaded({}), { env: ENV, fileConfig: {} }).map((c) => [c.id, c]),
    );
    expect(byId["dream.engine"]?.state).toBe("on");
    expect(byId["curiosity.engine"]?.state).toBe("on");
    expect(byId["skills.prior"]).toMatchObject({ state: "on", mode: "mean" });
    expect(byId["skills.priorEvidence"]).toMatchObject({ state: "on", mode: "verbal" });
    expect(byId["skills.priorWriter"]).toMatchObject({ state: "recording", mode: "shadow" });
    expect(byId["curiosity.evidence"]).toMatchObject({ state: "recording", mode: "shadow" });
    expect(byId["skills.harnessEvolve"]?.state).toBe("off");
    expect(byId["network.wallet"]?.state).toBe("off");
    expect(byId["network.p2p"]?.state).toBe("on");
    expect(byId["memory.architect"]?.state).toBe("recording");
    for (const [mode, cfg] of Object.entries(DEFAULT_MODE_CONFIGS)) {
      const expected = cfg.enabled && mode !== "harness_evolve" ? "on" : "off";
      expect(byId[`dream.${mode}`]?.state, mode).toBe(expected);
    }
    // Every part's source is "default" for an empty config.
    expect(Object.values(byId).every((c) => c.source === "default")).toBe(true);
  });

  it("follows what the part depends on", () => {
    const noDreams = withKey("memory.dream.enabled", false);
    expect(stateOf("dream.replay", noDreams).state).toBe("off");
    expect(stateOf("skills.evolution", noDreams).state).toBe("off");
    expect(stateOf("skills.priorWriter", withKey("skills.prior.enabled", false)).state).toBe("off");
    expect(stateOf("network.wallet", withKey("tools.wallet.enabled", true)).state).toBe("blocked");
    expect(
      stateOf("network.wallet", withKey("tools.wallet.enabled", true), {
        CDP_API_KEY_ID: "id",
        CDP_API_KEY_SECRET: "s",
        CDP_WALLET_SECRET: "w",
      } as NodeJS.ProcessEnv).state,
    ).toBe("on");
    const x402 = withKey("tools.wallet.x402.enabled", true);
    (x402.tools!.wallet as { enabled?: boolean }).enabled = true;
    expect(stateOf("network.x402", x402).state).toBe("blocked");
    // Search keys come from the process env; match whatever this machine has.
    expect(stateOf("tools.webSearch", {}).state).toBe(isWebSearchConfigured({}) ? "on" : "blocked");
    expect(stateOf("tools.webSearch", withKey("tools.web.search.enabled", false)).state).toBe(
      "off",
    );
  });

  it("says when the owner set it", () => {
    const file = withKey("skills.prior.writer", "on");
    const resolved = resolveCapability(
      CAPABILITIES.find((c) => c.id === "skills.priorWriter")!,
      file,
      { env: ENV, fileConfig: file },
    );
    expect(resolved).toMatchObject({ state: "on", source: "config" });
  });

  it("renders names grouped by state", () => {
    const block = renderSelfStateBlock(resolveCapabilities(loaded({}), { env: ENV }));
    expect(block).toMatch(/^## Your Current State\nOn: /);
    expect(block).toContain("Recording only (changes nothing yet): ");
    expect(block).toContain("verified-outcome recording (shadow)");
    expect(block).toMatch(/\nOff: .*harness evolution/);
  });
});

describe("the how-you-work guide stays true", () => {
  const toolNames = new Set<string>();
  const toolsDir = path.join(REPO, "src/agents/tools");
  for (const file of fs.readdirSync(toolsDir)) {
    if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
      for (const m of fs
        .readFileSync(path.join(toolsDir, file), "utf8")
        .matchAll(/name: "([a-z_]+)"/g)) {
        toolNames.add(m[1]);
      }
    }
  }

  it("names only tools that exist", () => {
    const named = [...GUIDE.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((n) => !toolNames.has(n))).toEqual([]);
  });

  it("names only settings that exist", () => {
    const keys = [...GUIDE.matchAll(/`([a-z][A-Za-z]*(?:\.[a-zA-Z]+)+)`/g)]
      .map((m) => m[1])
      .filter((k) => !/\.(md|ts|json)$/.test(k));
    expect(keys.filter((k) => jsonSchemaNodeAtPath(JSON_SCHEMA, k) === undefined)).toEqual([]);
  });

  it("mentions every dream mode", () => {
    const words: Partial<Record<DreamMode, string>> = { harness_evolve: "harness evolution" };
    const missing = (Object.keys(DEFAULT_MODE_CONFIGS) as DreamMode[]).filter(
      (mode) => !GUIDE.includes(words[mode] ?? mode.replace(/_/g, " ")),
    );
    expect(missing).toEqual([]);
  });

  it("never states what is on or off: that lives in the state block", () => {
    expect(GUIDE).not.toMatch(
      /\b(on|off|enabled|disabled) by default\b|\bdefaults? (to )?(on|off|true|false)\b|\bopt-in\b/i,
    );
  });
});
