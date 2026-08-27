import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagementKeyPresent,
  defaultP2pKeyDir,
  migrateLegacyP2pKeys,
  resolveP2pKeyDir,
} from "./p2p-key-dir.js";

let tmp: string;
function mktmp(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-keydir-"));
  return tmp;
}
afterEach(() => {
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function seedKeys(dir: string, extras: string[] = []) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node.key"), "PRIVATE");
  fs.writeFileSync(path.join(dir, "node.pub"), "PUBLIC");
  for (const name of extras) {
    fs.writeFileSync(path.join(dir, name), name);
  }
}

describe("resolveP2pKeyDir (PLAN-41 p0-7)", () => {
  it("defaults to ~/.bitterbot/keys — the path the docs always claimed", () => {
    expect(resolveP2pKeyDir(undefined, "/home/u")).toBe(path.join("/home/u", ".bitterbot", "keys"));
    expect(defaultP2pKeyDir("/home/u")).toBe(path.join("/home/u", ".bitterbot", "keys"));
  });

  it("explicit p2p.keyDir wins", () => {
    // Platform-native absolute path: a POSIX literal like "/etc/bb-keys"
    // gets drive-absolutized on Windows (D:\etc\bb-keys) and reds the CI
    // matrix there.
    const explicit = path.join(os.tmpdir(), "bb-explicit-keys");
    expect(resolveP2pKeyDir(explicit, "/home/u")).toBe(explicit);
  });
});

describe("migrateLegacyP2pKeys", () => {
  it("copies the identity + co-located files from <repo>/keys and stamps the source", () => {
    const root = mktmp();
    const legacy = path.join(root, "repo", "keys");
    const target = path.join(root, "state", "keys");
    seedKeys(legacy, ["genesis_trust_list.txt"]);

    const res = migrateLegacyP2pKeys({
      targetDir: target,
      packageRoot: path.join(root, "repo"),
      homedir: path.join(root, "home"),
    });

    expect(res?.migratedFrom).toBe(legacy);
    expect(res?.files.toSorted()).toEqual(["genesis_trust_list.txt", "node.key", "node.pub"]);
    expect(fs.readFileSync(path.join(target, "node.key"), "utf8")).toBe("PRIVATE");
    // Non-destructive by design: a crash, test harness, or partial failure
    // must never be able to destroy the only copy of an identity key.
    expect(fs.existsSync(path.join(legacy, "node.key"))).toBe(true);
    expect(fs.existsSync(path.join(legacy, "MIGRATED.txt"))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(target, "node.key")).mode & 0o777).toBe(0o600);
    }
  });

  it("prefers <repo>/keys over <repo>/desktop/keys over ~/keys", () => {
    const root = mktmp();
    const target = path.join(root, "state", "keys");
    seedKeys(path.join(root, "repo", "desktop", "keys"));
    seedKeys(path.join(root, "home", "keys"));
    const res = migrateLegacyP2pKeys({
      targetDir: target,
      packageRoot: path.join(root, "repo"),
      homedir: path.join(root, "home"),
    });
    expect(res?.migratedFrom).toBe(path.join(root, "repo", "desktop", "keys"));
    // The lower-priority identity is left alone, not merged.
    expect(fs.existsSync(path.join(root, "home", "keys", "node.key"))).toBe(true);
  });

  it("no-ops when the target already holds an identity (existing wins)", () => {
    const root = mktmp();
    const target = path.join(root, "state", "keys");
    const legacy = path.join(root, "repo", "keys");
    seedKeys(target);
    seedKeys(legacy);
    expect(
      migrateLegacyP2pKeys({
        targetDir: target,
        packageRoot: path.join(root, "repo"),
        homedir: path.join(root, "home"),
      }),
    ).toBeNull();
    expect(fs.existsSync(path.join(legacy, "node.key"))).toBe(true);
  });

  it("no-ops on a fresh machine (orchestrator will generate)", () => {
    const root = mktmp();
    expect(
      migrateLegacyP2pKeys({
        targetDir: path.join(root, "state", "keys"),
        packageRoot: path.join(root, "repo"),
        homedir: path.join(root, "home"),
      }),
    ).toBeNull();
  });

  it("skips a legacy candidate that IS the target (explicit keyDir at a legacy path)", () => {
    const root = mktmp();
    const target = path.join(root, "home", "keys");
    seedKeys(target);
    // target == ~/keys candidate; must not "migrate" onto itself or stamp it.
    expect(
      migrateLegacyP2pKeys({
        targetDir: target,
        packageRoot: path.join(root, "repo"),
        homedir: path.join(root, "home"),
      }),
    ).toBeNull();
    expect(fs.existsSync(path.join(target, "MIGRATED.txt"))).toBe(false);
  });
});

describe("assertManagementKeyPresent", () => {
  it("throws for a management node with no keypair (never mint fresh authority)", () => {
    const root = mktmp();
    expect(() =>
      assertManagementKeyPresent({ targetDir: path.join(root, "none"), nodeTier: "management" }),
    ).toThrow(/management/i);
  });

  it("passes for edge nodes and keyed management nodes", () => {
    const root = mktmp();
    const keyed = path.join(root, "keys");
    seedKeys(keyed);
    expect(() =>
      assertManagementKeyPresent({ targetDir: path.join(root, "none"), nodeTier: "edge" }),
    ).not.toThrow();
    expect(() =>
      assertManagementKeyPresent({ targetDir: keyed, nodeTier: "management" }),
    ).not.toThrow();
  });
});
