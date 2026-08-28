#!/usr/bin/env node
/**
 * Version sync (PLAN-41 D-A). release-please bumps the ROOT package.json;
 * this script fans the version out to every other surface that carries
 * one, so nothing drifts:
 *
 *   - desktop/package.json
 *   - extensions/<*>/package.json (every extension that declares a version)
 *   - desktop/src-tauri/tauri.conf.json
 *   - README.md version badge
 *   - .release-please-manifest.json (kept in step when run manually)
 *
 * Usage:
 *   node scripts/bump-version.mjs           # sync everything to root version
 *   node scripts/bump-version.mjs 1.0.0     # set root + sync everything
 *
 * The Control UI sidebar reads the version at build time (vite define),
 * so it needs no rewriting here.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

const rootPkgPath = path.join(ROOT, "package.json");
const rootPkg = readJson(rootPkgPath);

const requested = process.argv[2]?.trim();
if (requested && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(requested)) {
  console.error(`bump-version: "${requested}" is not a valid version`);
  process.exit(1);
}
const version = requested || rootPkg.version;

const changed = [];

if (rootPkg.version !== version) {
  rootPkg.version = version;
  writeJson(rootPkgPath, rootPkg);
  changed.push("package.json");
}

// desktop
const desktopPkgPath = path.join(ROOT, "desktop", "package.json");
if (fs.existsSync(desktopPkgPath)) {
  const pkg = readJson(desktopPkgPath);
  if (pkg.version !== version) {
    pkg.version = version;
    writeJson(desktopPkgPath, pkg);
    changed.push("desktop/package.json");
  }
}

// extensions
const extRoot = path.join(ROOT, "extensions");
for (const entry of fs.readdirSync(extRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join(extRoot, entry.name, "package.json");
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = readJson(pkgPath);
  if (pkg.version !== undefined && pkg.version !== version) {
    pkg.version = version;
    writeJson(pkgPath, pkg);
    changed.push(`extensions/${entry.name}/package.json`);
  }
}

// tauri
const tauriConfPath = path.join(ROOT, "desktop", "src-tauri", "tauri.conf.json");
if (fs.existsSync(tauriConfPath)) {
  const conf = readJson(tauriConfPath);
  if (conf.version !== undefined && conf.version !== version) {
    conf.version = version;
    writeJson(tauriConfPath, conf);
    changed.push("desktop/src-tauri/tauri.conf.json");
  }
}

// README badge: version-<anything>-7c3aed
const readmePath = path.join(ROOT, "README.md");
const readme = fs.readFileSync(readmePath, "utf8");
const badgeRe = /badge\/version-[^-]+(?:--[\w.]+)?-7c3aed/;
if (badgeRe.test(readme)) {
  const encoded = version.replace(/-/g, "--");
  const next = readme.replace(badgeRe, `badge/version-${encoded}-7c3aed`);
  if (next !== readme) {
    fs.writeFileSync(readmePath, next);
    changed.push("README.md (badge)");
  }
}

// release-please manifest (manual runs; the action maintains it on its own)
const manifestPath = path.join(ROOT, ".release-please-manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = readJson(manifestPath);
  if (manifest["."] !== version) {
    manifest["."] = version;
    writeJson(manifestPath, manifest);
    changed.push(".release-please-manifest.json");
  }
}

if (changed.length === 0) {
  console.log(`bump-version: everything already at ${version}`);
} else {
  console.log(`bump-version: ${version} →\n  ${changed.join("\n  ")}`);
}
