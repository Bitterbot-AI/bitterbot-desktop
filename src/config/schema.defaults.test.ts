/**
 * PLAN-56 Phase 1: the settings-truth test. It walks the registries in
 * schema.defaults.ts against the generated JSON schema so a stale entry, or a
 * new hinted boolean that the form would render dishonestly, fails CI.
 */
import { describe, expect, it } from "vitest";
import {
  ADVANCED_EXCEPTIONS,
  ADVANCED_PATHS,
  DEPRECATED_ONLY_WHEN,
  DEPRECATED_PATHS,
  FIELD_DEFAULTS,
  isAdvancedPath,
  READ_ONLY_PATHS,
  TRI_STATE_PATHS,
  UNSET_MEANS_FALSE,
} from "./schema.defaults.js";
import { FIELD_HELP } from "./schema.help.js";
import { buildBaseHints, jsonSchemaNodeAtPath } from "./schema.hints.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { BitterbotSchema } from "./zod-schema.js";

const JSON_SCHEMA = BitterbotSchema.toJSONSchema({ target: "draft-07", unrepresentable: "any" });
const HINTS = buildBaseHints({ jsonSchema: JSON_SCHEMA });

function nodeAt(path: string): Record<string, unknown> | undefined {
  return jsonSchemaNodeAtPath(JSON_SCHEMA, path);
}

function isBooleanLeaf(node: Record<string, unknown>): boolean {
  if (node.type === "boolean") {
    return true;
  }
  const alts = (node.anyOf ?? node.oneOf) as Array<Record<string, unknown>> | undefined;
  return (
    Array.isArray(alts) &&
    alts.length > 0 &&
    alts.every((a) => a.type === "boolean" || a.type === "null")
  );
}

describe("schema.defaults registries", () => {
  it("every registry path resolves to a real node in the generated JSON schema", () => {
    const paths = [
      ...Object.keys(FIELD_DEFAULTS),
      ...Object.keys(UNSET_MEANS_FALSE),
      ...Object.keys(TRI_STATE_PATHS),
      ...READ_ONLY_PATHS,
      ...Object.keys(DEPRECATED_PATHS),
      ...Object.keys(DEPRECATED_ONLY_WHEN),
      ...ADVANCED_PATHS,
      ...ADVANCED_EXCEPTIONS,
    ];
    const stale = paths.filter((path) => nodeAt(path) === undefined);
    expect(stale).toEqual([]);
  });

  it("every labelled or documented path resolves in the generated JSON schema (no stale hints)", () => {
    const paths = [...Object.keys(FIELD_LABELS), ...Object.keys(FIELD_HELP)].filter((p) =>
      p.includes("."),
    );
    const stale = [...new Set(paths)].filter((path) => nodeAt(path) === undefined);
    expect(stale).toEqual([]);
  });

  it("a path lives in exactly one of the boolean registries", () => {
    const registries = [FIELD_DEFAULTS, UNSET_MEANS_FALSE, TRI_STATE_PATHS];
    const seen = new Map<string, number>();
    for (const reg of registries) {
      for (const path of Object.keys(reg)) {
        seen.set(path, (seen.get(path) ?? 0) + 1);
      }
    }
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p)).toEqual([]);
  });

  it("every hinted boolean leaf without a zod default is catalogued (no silent OFF rendering)", () => {
    // Iterates the HINTS, not just FIELD_LABELS: a help-only key is shown and
    // addable too (with the raw path as its label), so it must be catalogued.
    const uncatalogued: string[] = [];
    for (const path of Object.keys(HINTS)) {
      if (!path.includes(".") || path.includes("*") || path.includes("[]")) {
        continue;
      }
      const node = nodeAt(path);
      if (!node || !isBooleanLeaf(node) || node.default !== undefined) {
        continue;
      }
      if (
        path in FIELD_DEFAULTS ||
        path in UNSET_MEANS_FALSE ||
        path in TRI_STATE_PATHS ||
        path in DEPRECATED_PATHS
      ) {
        continue;
      }
      uncatalogued.push(path);
    }
    expect(uncatalogued).toEqual([]);
  });

  it("boolean defaults in FIELD_DEFAULTS are booleans and match the schema type", () => {
    for (const [path, value] of Object.entries(FIELD_DEFAULTS)) {
      const node = nodeAt(path);
      expect(node, path).toBeDefined();
      if (node && isBooleanLeaf(node)) {
        expect(typeof value, path).toBe("boolean");
      }
    }
  });

  it("pins the six toggles the plan found rendering OFF while actually ON", () => {
    // src/infra/update-startup.ts:86 — only `=== false` skips the check.
    expect(FIELD_DEFAULTS["update.checkOnStart"]).toBe(true);
    // src/monitors/runtime.ts:60 — only `=== false` skips the engine.
    expect(FIELD_DEFAULTS["monitors.enabled"]).toBe(true);
    // src/agents/tools/browser-tool.ts:251 — `!== false`.
    expect(FIELD_DEFAULTS["browser.replay.enabled"]).toBe(true);
    // src/agents/tools/browser-tool.ts:429 — `=== false` turns it off.
    expect(FIELD_DEFAULTS["browser.liveView.enabled"]).toBe(true);
    // src/agents/tools/tool-registry-hot-set.ts:180 — `?? true`.
    expect(FIELD_DEFAULTS["tools.hotSet.enabled"]).toBe(true);
    // src/memory/curiosity-researcher.ts:67 — DEFAULT_CURIOSITY_RESEARCH.enabled.
    expect(FIELD_DEFAULTS["memory.curiosity.research.enabled"]).toBe(true);
  });

  it("pins review-round corrections", () => {
    // src/memory/manager.ts:3639 — `enabled !== true` returns null: opt-in.
    expect(UNSET_MEANS_FALSE["skills.marketability.predictor.enabled"]).toContain("3639");
    expect(FIELD_DEFAULTS["skills.marketability.predictor.enabled"]).toBeUndefined();
    // src/channels/plugins/config-writes.ts:39 — `value !== false`.
    for (const ch of ["telegram", "slack", "discord", "whatsapp", "signal", "imessage"]) {
      expect(FIELD_DEFAULTS[`channels.${ch}.configWrites`]).toBe(true);
    }
    expect(TRI_STATE_PATHS["channels.telegram.network.autoSelectFamily"]).toBeTruthy();
    expect(UNSET_MEANS_FALSE["channels.discord.intents.guildMembers"]).toContain(
      "gateway-plugin.ts:21",
    );
    expect(UNSET_MEANS_FALSE["tools.wallet.enabled"]).toContain("isEarningCapable");
  });

  it("deprecated paths carry no label, so the form never offers them", () => {
    for (const path of Object.keys(DEPRECATED_PATHS)) {
      expect(FIELD_LABELS[path], path).toBeUndefined();
    }
  });

  it("isAdvancedPath honours prefixes and exceptions", () => {
    expect(isAdvancedPath("gateway.controlUi.basePath")).toBe(true);
    expect(isAdvancedPath("skills.evolution.trialsPerTask")).toBe(true);
    expect(isAdvancedPath("skills.evolution.enabled")).toBe(false);
    expect(isAdvancedPath("update.checkOnStart")).toBe(false);
    expect(isAdvancedPath("loggingx.level")).toBe(false);
  });
});

describe("jsonSchemaNodeAtPath", () => {
  it("searches union branches so array|object shapes resolve", () => {
    expect(nodeAt("channels.telegram.capabilities.inlineButtons")?.enum).toContain("dm");
  });

  it("resolves the typed branch of the typed-or-unknown memory unions", () => {
    expect(nodeAt("memory.curiosity.research.enabled")).toEqual({ type: "boolean" });
    expect(nodeAt("memory.architectEvolution.enabled")).toEqual({ type: "boolean" });
  });

  it("resolves [] and * segments", () => {
    expect(nodeAt("agents.list[].runtime.engine")).toBeDefined();
    expect(nodeAt("plugins.entries.*.enabled")).toBeDefined();
  });
});

describe("buildBaseHints truth layer", () => {
  it("exposes point-of-use defaults as hint.default", () => {
    expect(HINTS["update.checkOnStart"]?.default).toBe(true);
    expect(HINTS["tools.hotSet.enabled"]?.default).toBe(true);
    expect(HINTS["memory.curiosity.research.enabled"]?.default).toBe(true);
    expect(HINTS["channels.discord.configWrites"]?.default).toBe(true);
  });

  it("exposes zod .default() values on leaf rows only", () => {
    expect(HINTS["commands.native"]?.default).toBe("auto");
    // `commands` has an object default in zod; it must not leak into the group header.
    expect(HINTS.commands?.default).toBeUndefined();
  });

  it("marks meta.* read-only, tri-state booleans, and deprecated paths with a reason", () => {
    expect(HINTS["meta.lastTouchedAt"]?.readOnly).toBe(true);
    expect(HINTS["meta.lastTouchedVersion"]?.readOnly).toBe(true);
    expect(HINTS["channels.telegram.network.autoSelectFamily"]?.triState).toBe(true);
    expect(HINTS["memory.backend"]?.deprecated).toContain("inert");
    expect(HINTS["agents.defaults.contextPruning"]?.deprecated).toContain("no effect");
    expect(HINTS["agents.defaults.runtime.engine"]?.deprecated).toContain("no longer needed");
  });

  it("marks advanced paths and keeps feature switches in the plain view", () => {
    expect(HINTS["gateway.controlUi.basePath"]?.advanced).toBe(true);
    expect(HINTS["skills.evolution.trialsPerTask"]?.advanced).toBe(true);
    expect(HINTS["skills.evolution.enabled"]?.advanced).toBeUndefined();
    expect(HINTS["p2p.enabled"]?.advanced).toBeUndefined();
  });

  it("labels the sandbox and wallet-cap keys so they are addable", () => {
    expect(HINTS["agents.defaults.sandbox.mode"]?.label).toBeTruthy();
    expect(HINTS["agents.defaults.sandbox.workspaceAccess"]?.label).toBeTruthy();
    expect(HINTS["tools.wallet.perTransactionCapUsd"]?.label).toBeTruthy();
  });

  it("renders group help for the review section", () => {
    expect(HINTS.review?.help).toContain("review.spend");
    expect(HINTS.review?.help).toContain("tools.wallet.perTransactionCapUsd");
  });
});
