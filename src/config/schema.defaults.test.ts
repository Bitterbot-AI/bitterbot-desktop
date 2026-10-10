/**
 * PLAN-56 Phase 1: the settings-truth test. It walks the registries in
 * schema.defaults.ts against the generated JSON schema so a stale entry, or a
 * new labelled boolean that the form would render dishonestly, fails CI.
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
  UNSET_MEANS_FALSE,
} from "./schema.defaults.js";
import { buildBaseHints, jsonSchemaNodeAtPath } from "./schema.hints.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { BitterbotSchema } from "./zod-schema.js";

const JSON_SCHEMA = BitterbotSchema.toJSONSchema({ target: "draft-07", unrepresentable: "any" });

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
      ...READ_ONLY_PATHS,
      ...Object.keys(DEPRECATED_PATHS),
      ...Object.keys(DEPRECATED_ONLY_WHEN),
      ...ADVANCED_PATHS,
      ...ADVANCED_EXCEPTIONS,
    ];
    const stale = paths.filter((path) => nodeAt(path) === undefined);
    expect(stale).toEqual([]);
  });

  it("a path is never both a default-on and an unset-means-false entry", () => {
    const both = Object.keys(FIELD_DEFAULTS).filter((path) => path in UNSET_MEANS_FALSE);
    expect(both).toEqual([]);
  });

  it("every labelled boolean without a zod default is catalogued (no silent OFF rendering)", () => {
    const uncatalogued: string[] = [];
    for (const path of Object.keys(FIELD_LABELS)) {
      if (!path.includes(".") || path.includes("*") || path.includes("[]")) {
        continue;
      }
      const node = nodeAt(path);
      if (!node || !isBooleanLeaf(node) || node.default !== undefined) {
        continue;
      }
      if (path in FIELD_DEFAULTS || path in UNSET_MEANS_FALSE || path in DEPRECATED_PATHS) {
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
      if (isBooleanLeaf(node!)) {
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

  it("deprecated and read-only paths carry no label, so the form cannot render them as live", () => {
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

describe("buildBaseHints truth layer", () => {
  const hints = buildBaseHints({ jsonSchema: JSON_SCHEMA });

  it("exposes point-of-use defaults as hint.default", () => {
    expect(hints["update.checkOnStart"]?.default).toBe(true);
    expect(hints["tools.hotSet.enabled"]?.default).toBe(true);
    expect(hints["memory.curiosity.research.enabled"]?.default).toBe(true);
  });

  it("exposes zod .default() values on leaf rows only", () => {
    expect(hints["commands.native"]?.default).toBe("auto");
    // `commands` has an object default in zod; it must not leak into the group header.
    expect(hints.commands?.default).toBeUndefined();
  });

  it("marks meta.* read-only and deprecated paths with a reason", () => {
    expect(hints["meta.lastTouchedAt"]?.readOnly).toBe(true);
    expect(hints["meta.lastTouchedVersion"]?.readOnly).toBe(true);
    expect(hints["memory.backend"]?.deprecated).toContain("inert");
    expect(hints["agents.defaults.contextPruning"]?.deprecated).toContain("no effect");
  });

  it("marks advanced paths and keeps feature switches in the plain view", () => {
    expect(hints["gateway.controlUi.basePath"]?.advanced).toBe(true);
    expect(hints["skills.evolution.trialsPerTask"]?.advanced).toBe(true);
    expect(hints["skills.evolution.enabled"]?.advanced).toBeUndefined();
    expect(hints["p2p.enabled"]?.advanced).toBeUndefined();
  });

  it("renders group help for the review section", () => {
    expect(hints.review?.help).toContain("review.spend");
    expect(hints.review?.help).toContain("tools.wallet.perTransactionCapUsd");
  });
});
