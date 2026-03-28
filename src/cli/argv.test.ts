import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "bitterbot", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "bitterbot", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "bitterbot", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "bitterbot", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "bitterbot", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "bitterbot", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "bitterbot", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "bitterbot"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "bitterbot", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "bitterbot", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "bitterbot", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "bitterbot", "status", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "bitterbot", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "bitterbot", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "bitterbot", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "bitterbot", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "bitterbot", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "bitterbot", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "bitterbot", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "bitterbot", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "bitterbot", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "bitterbot", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["node", "bitterbot", "status"],
    });
    expect(nodeArgv).toEqual(["node", "bitterbot", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["node-22", "bitterbot", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "bitterbot", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["node-22.2.0.exe", "bitterbot", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "bitterbot", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["node-22.2", "bitterbot", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "bitterbot", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["node-22.2.exe", "bitterbot", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "bitterbot", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["/usr/bin/node-22.2.0", "bitterbot", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "bitterbot", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["nodejs", "bitterbot", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "bitterbot", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["node-dev", "bitterbot", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "bitterbot", "node-dev", "bitterbot", "status"]);

    const directArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["bitterbot", "status"],
    });
    expect(directArgv).toEqual(["node", "bitterbot", "status"]);

    const bunArgv = buildParseArgv({
      programName: "bitterbot",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "bitterbot",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "bitterbot", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "bitterbot", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "config", "get", "update"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "config", "unset", "update"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "models", "list"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "models", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "bitterbot", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "bitterbot", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["config", "get"])).toBe(false);
    expect(shouldMigrateStateFromPath(["models", "status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
