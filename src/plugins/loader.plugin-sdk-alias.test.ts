import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./loader.js";

const { resolvePluginSdkAliasFile } = __testing;

const tmpDirs: string[] = [];

/**
 * Build a fixture root containing any of src/plugin-sdk/index.ts and
 * dist/plugin-sdk/index.js, with explicit mtimes so the ordering rule is
 * exercised deterministically rather than depending on write order.
 */
const makeRoot = (opts: { srcMtimeMs?: number; distMtimeMs?: number }): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sdk-alias-"));
  tmpDirs.push(root);
  if (opts.srcMtimeMs !== undefined) {
    const dir = path.join(root, "src", "plugin-sdk");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.ts");
    fs.writeFileSync(file, "export const x = 1;\n");
    fs.utimesSync(file, opts.srcMtimeMs / 1000, opts.srcMtimeMs / 1000);
  }
  if (opts.distMtimeMs !== undefined) {
    const dir = path.join(root, "dist", "plugin-sdk");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.js");
    fs.writeFileSync(file, "export const x = 1;\n");
    fs.utimesSync(file, opts.distMtimeMs / 1000, opts.distMtimeMs / 1000);
  }
  return root;
};

const resolve = (root: string, forceTestMode: boolean) =>
  resolvePluginSdkAliasFile({
    srcFile: "index.ts",
    distFile: "index.js",
    fromDir: root,
    forceTestMode,
  });

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("plugin-sdk alias resolution", () => {
  const OLD = Date.now() - 60_000;
  const NEW = Date.now();

  it("prefers the prebuilt dist bundle when it is newer than the source", () => {
    // The boot-critical case: `pnpm build` has run, so jiti must not walk the
    // SDK's ~1400-module TypeScript graph (measured 2026-08-24: >591s vs 144s).
    const root = makeRoot({ srcMtimeMs: OLD, distMtimeMs: NEW });
    expect(resolve(root, false)).toBe(path.join(root, "dist", "plugin-sdk", "index.js"));
  });

  it("prefers dist when both have the same mtime", () => {
    const root = makeRoot({ srcMtimeMs: NEW, distMtimeMs: NEW });
    expect(resolve(root, false)).toBe(path.join(root, "dist", "plugin-sdk", "index.js"));
  });

  it("prefers freshly edited source over a stale build", () => {
    // Keeps SDK development working without forcing a rebuild first.
    const root = makeRoot({ srcMtimeMs: NEW, distMtimeMs: OLD });
    expect(resolve(root, false)).toBe(path.join(root, "src", "plugin-sdk", "index.ts"));
  });

  it("falls back to source when no build output exists", () => {
    // A plain source checkout that has never run `pnpm build` must still load
    // plugins; the previous production branch returned dist-only and could
    // resolve to nothing.
    const root = makeRoot({ srcMtimeMs: NEW });
    expect(resolve(root, false)).toBe(path.join(root, "src", "plugin-sdk", "index.ts"));
  });

  it("falls back to dist when the source is absent (packaged install)", () => {
    const root = makeRoot({ distMtimeMs: NEW });
    expect(resolve(root, false)).toBe(path.join(root, "dist", "plugin-sdk", "index.js"));
  });

  it("stays source-first under test mode even when dist is newer", () => {
    const root = makeRoot({ srcMtimeMs: OLD, distMtimeMs: NEW });
    expect(resolve(root, true)).toBe(path.join(root, "src", "plugin-sdk", "index.ts"));
  });

  it("returns null when neither candidate exists", () => {
    const root = makeRoot({});
    expect(resolve(root, false)).toBeNull();
  });

  it("walks up parent directories to find the sdk", () => {
    const root = makeRoot({ distMtimeMs: NEW });
    const nested = path.join(root, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    expect(resolve(nested, false)).toBe(path.join(root, "dist", "plugin-sdk", "index.js"));
  });
});
