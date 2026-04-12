#!/usr/bin/env node
/**
 * Postinstall: download the prebuilt P2P orchestrator binary for the
 * current platform from GitHub Releases, verify its SHA-256, and drop
 * it at ~/.bitterbot/bin/bitterbot-orchestrator[.exe].
 *
 * Invoked by `pnpm install`. Non-fatal by design: any failure (offline,
 * release not yet published, flaky network, hash mismatch) logs a
 * clear message and exits 0 so `pnpm install` still succeeds. The
 * gateway will surface the missing-binary case loudly at runtime via
 * OrchestratorBridge.resolveBinary() if the user then tries to start
 * without cargo-building themselves.
 *
 * Skip triggers:
 *   - BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD=1 in env
 *   - Running inside the orchestrator-release CI workflow itself
 *   - Unsupported platform (logs, continues)
 *
 * Version source of truth: orchestrator/Cargo.toml. Bump there to
 * release a new artifact (and push a matching `orchestrator-v<version>`
 * git tag to trigger the CI workflow).
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const REPO = "Bitterbot-AI/bitterbot-desktop";
const INSTALL_DIR = join(homedir(), ".bitterbot", "bin");

// Resolve the Cargo.toml relative to this script, not cwd — pnpm
// postinstall can run from nested workspace packages.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CARGO_MANIFEST = join(REPO_ROOT, "orchestrator", "Cargo.toml");

const LOG_PREFIX = "[orchestrator-fetch]";
const log = (msg) => console.log(`${LOG_PREFIX} ${msg}`);
const warn = (msg) => console.warn(`${LOG_PREFIX} ${msg}`);

/** Map Node platform+arch to our release asset target string. */
function detectTarget() {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return { target: "linux-x64", ext: "" };
  if (platform === "linux" && arch === "arm64") return { target: "linux-arm64", ext: "" };
  if (platform === "darwin" && arch === "x64") return { target: "darwin-x64", ext: "" };
  if (platform === "darwin" && arch === "arm64") return { target: "darwin-arm64", ext: "" };
  if (platform === "win32" && arch === "x64") return { target: "win32-x64", ext: ".exe" };
  return null;
}

/** Read the version string from orchestrator/Cargo.toml (single source of truth). */
async function readOrchestratorVersion() {
  const content = await readFile(CARGO_MANIFEST, "utf-8");
  // Match the first top-level `version = "x.y.z"` line (in the [package] section).
  const match = content.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Could not parse version from ${CARGO_MANIFEST}`);
  }
  return match[1];
}

async function fetchJsonOrText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function fetchToFile(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("empty response body");
  }
  await pipeline(res.body, createWriteStream(destPath));
}

async function sha256File(path) {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Parse sha256sum-formatted output and return the hash for the given
 * filename, or null if not found. Handles both text mode (two spaces)
 * and binary mode (space-asterisk) output.
 */
function parseChecksums(content, filename) {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    if (match[2] === filename) return match[1].toLowerCase();
  }
  return null;
}

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function safeUnlink(path) {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

async function main() {
  if (process.env.BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD) {
    log("skipped: BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD is set");
    return;
  }

  // Skip inside the orchestrator release workflow itself — we'd be
  // trying to download the release we're currently building.
  if (process.env.GITHUB_WORKFLOW?.toLowerCase().includes("orchestrator")) {
    log("skipped: running inside orchestrator release workflow");
    return;
  }

  const target = detectTarget();
  if (!target) {
    warn(
      `no prebuilt binary for ${process.platform}/${process.arch}. ` +
        `Build from source: cargo build --release --manifest-path orchestrator/Cargo.toml`,
    );
    return;
  }

  let version;
  try {
    version = await readOrchestratorVersion();
  } catch (err) {
    warn(`could not read orchestrator version: ${err.message}`);
    return;
  }

  const assetName = `bitterbot-orchestrator-${target.target}${target.ext}`;
  const installedName = `bitterbot-orchestrator${target.ext}`;
  const releaseBase = `https://github.com/${REPO}/releases/download/orchestrator-v${version}`;
  const binaryUrl = `${releaseBase}/${assetName}`;
  const checksumUrl = `${releaseBase}/checksums.txt`;
  const destPath = join(INSTALL_DIR, installedName);

  // Fetch checksums first — small, fast, establishes that the release
  // actually exists and we're looking at the right asset.
  let expectedHash;
  try {
    const body = await fetchJsonOrText(checksumUrl);
    expectedHash = parseChecksums(body, assetName);
    if (!expectedHash) {
      warn(`${checksumUrl} does not contain an entry for ${assetName}`);
      return;
    }
  } catch (err) {
    warn(
      `could not fetch checksums (${err.message}). ` +
        `The orchestrator-v${version} release may not be published yet. ` +
        `Gateway will prompt for a local cargo build on first start if needed.`,
    );
    return;
  }

  // If we already have the exact binary, skip the download.
  if (await fileExists(destPath)) {
    try {
      const actual = await sha256File(destPath);
      if (actual === expectedHash) {
        log(`already up to date at ${destPath}`);
        return;
      }
      log("existing binary hash mismatch; re-downloading");
    } catch (err) {
      warn(`could not hash existing binary: ${err.message}`);
    }
  }

  await mkdir(INSTALL_DIR, { recursive: true });

  const tmpPath = `${destPath}.download`;
  try {
    log(`downloading ${assetName} v${version}`);
    await fetchToFile(binaryUrl, tmpPath);
  } catch (err) {
    warn(`download failed: ${err.message}`);
    await safeUnlink(tmpPath);
    return;
  }

  let actualHash;
  try {
    actualHash = await sha256File(tmpPath);
  } catch (err) {
    warn(`could not hash downloaded binary: ${err.message}`);
    await safeUnlink(tmpPath);
    return;
  }

  if (actualHash !== expectedHash) {
    warn(
      `hash mismatch for ${assetName}: expected ${expectedHash}, got ${actualHash}. ` +
        `Download has been discarded for safety.`,
    );
    await safeUnlink(tmpPath);
    return;
  }

  try {
    await rename(tmpPath, destPath);
    if (process.platform !== "win32") {
      await chmod(destPath, 0o755);
    }
  } catch (err) {
    warn(`could not install binary: ${err.message}`);
    await safeUnlink(tmpPath);
    return;
  }

  log(`installed ${destPath} (v${version}, sha256 ${expectedHash.slice(0, 12)}…)`);
}

main().catch((err) => {
  // Non-fatal: never break `pnpm install` with a thrown error.
  warn(`unexpected error: ${err?.stack || err?.message || String(err)}`);
  process.exit(0);
});
