/**
 * Content hash of every input that can change the Control UI bundle, for the
 * `pnpm ui:build` skip gate (scripts/ui-build.mjs).
 *
 * Hashing only desktop/renderer missed build inputs that live elsewhere:
 * desktop/vite.config.ts and what it imports, desktop/package.json and
 * tsconfig, postcss config, `.env*` files (vite's envDir is desktop/), the
 * lockfile (a vite or plugin upgrade), the root package.json `version`
 * (baked in as VITE_APP_VERSION, shown in the sidebar and compared by the
 * stale-bundle banner), and the VITE_* environment the config reads. Any of
 * those changing left `update.run` / `pnpm build` shipping a stale UI.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Directories under desktop/ that are never build inputs (deps, output, Tauri, tooling). */
export const UI_HASH_SKIP_DIRS = new Set([
  "node_modules",
  "dist-renderer",
  "src-tauri",
  "scripts",
  "test",
  "keys",
]);

/** Repo-root files whose whole content is a build input. */
export const UI_HASH_ROOT_FILES = ["pnpm-lock.yaml", "pnpm-workspace.yaml"];

/** Environment variables desktop/vite.config.ts reads into the bundle. */
export const UI_HASH_ENV_KEYS = ["VITE_GATEWAY_URL", "VITE_GATEWAY_CLIENT_NAME"];

function isTestFile(name) {
  return /\.test\.[cm]?[jt]sx?$/.test(name) || name === "vitest.config.ts";
}

function isEnvFile(name) {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

/**
 * Feed every build-relevant file under `dir` into `hash` (sorted, with
 * desktop-relative paths). Dot entries are skipped except vite `.env*` files.
 */
function hashDir(hash, desktopDir, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    const atTop = dir === desktopDir;
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist-renderer") {
        continue;
      }
      if (atTop && UI_HASH_SKIP_DIRS.has(e.name)) {
        continue;
      }
      hashDir(hash, desktopDir, full);
    } else if (e.isFile()) {
      if (e.name.startsWith(".") && !(atTop && isEnvFile(e.name))) {
        continue;
      }
      if (isTestFile(e.name) || (atTop && e.name.endsWith(".md"))) {
        continue;
      }
      hash.update(`file:${path.relative(desktopDir, full).split(path.sep).join("/")}\0`);
      hash.update(fs.readFileSync(full));
      hash.update("\0");
    }
  }
}

function readRootVersion(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

/** Hash of every Control UI build input under `repoRoot`. */
export function computeUiInputHash(repoRoot, env = process.env) {
  const hash = createHash("sha256");
  const desktopDir = path.join(repoRoot, "desktop");
  hashDir(hash, desktopDir, desktopDir);
  for (const name of UI_HASH_ROOT_FILES) {
    hash.update(`root:${name}\0`);
    try {
      hash.update(fs.readFileSync(path.join(repoRoot, name)));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  hash.update(`version:${readRootVersion(repoRoot)}\0`);
  for (const key of UI_HASH_ENV_KEYS) {
    hash.update(`env:${key}=${env[key]?.trim() ?? ""}\0`);
  }
  return hash.digest("hex");
}
