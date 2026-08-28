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

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = "Bitterbot-AI/bitterbot-desktop";
// Overridable for container builds: the Docker image fetches into the
// repo-relative path the resolver probes, because ~/.bitterbot inside a
// container is either the wrong HOME (root at build time) or shadowed by the
// compose volume mount at runtime.
const INSTALL_DIR =
  process.env.BITTERBOT_ORCHESTRATOR_INSTALL_DIR?.trim() || join(homedir(), ".bitterbot", "bin");

// Resolve the Cargo.toml relative to this script, not cwd — pnpm
// postinstall can run from nested workspace packages.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CARGO_MANIFEST = join(REPO_ROOT, "orchestrator", "Cargo.toml");

/**
 * Pinned minisign public key for orchestrator releases (PLAN-41 D-B).
 * The base64 payload from the SECOND line of the fleet's minisign .pub
 * file. EMPTY until Victor runs the signing runbook and mints the
 * keypair — while empty, signature verification is skipped with a note
 * (pre-signing era) and the SHA-256 check remains the only gate. Once
 * pinned, a release that carries a bad checksums.txt.minisig is REFUSED.
 */
const MINISIGN_PUBKEY_B64 = "";

const LOG_PREFIX = "[orchestrator-fetch]";
const log = (msg) => console.log(`${LOG_PREFIX} ${msg}`);
const warn = (msg) => console.warn(`${LOG_PREFIX} ${msg}`);

/** Map Node platform+arch to our release asset target string. */
function detectTarget() {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") {
    return { target: "linux-x64", ext: "" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { target: "linux-arm64", ext: "" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { target: "darwin-x64", ext: "" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { target: "darwin-arm64", ext: "" };
  }
  if (platform === "win32" && arch === "x64") {
    return { target: "win32-x64", ext: ".exe" };
  }
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

/**
 * Verify a minisign signature over `message` with a minisign public key.
 * Pure node:crypto — minisign is Ed25519 underneath:
 *   pubkey payload  = "Ed" | key_id(8) | ed25519_pub(32)
 *   .minisig        = untrusted-comment line
 *                     base64( alg(2) | key_id(8) | signature(64) )
 *                     trusted-comment line
 *                     base64( global_sig(64) )  — over sig || trusted_comment
 * alg "ED" (current default) signs Blake2b-512(message); legacy "Ed"
 * signs the raw message. Throws with a reason on any mismatch.
 */
function verifyMinisign({ pubkeyB64, message, minisig }) {
  const pub = Buffer.from(pubkeyB64, "base64");
  if (pub.length !== 42 || pub.toString("latin1", 0, 2) !== "Ed") {
    throw new Error("pinned public key is not a minisign Ed25519 key");
  }
  const keyId = pub.subarray(2, 10);
  const rawPub = pub.subarray(10, 42);
  // Raw Ed25519 key -> SPKI DER so node:crypto accepts it.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]);
  const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });

  const lines = minisig.split("\n").filter((l) => l.length > 0);
  const sigLine = lines.find(
    (l, i) => i > 0 && !l.startsWith("untrusted comment:") && !l.startsWith("trusted comment:"),
  );
  const trustedIdx = lines.findIndex((l) => l.startsWith("trusted comment:"));
  if (!sigLine || trustedIdx < 0 || !lines[trustedIdx + 1]) {
    throw new Error("malformed .minisig file");
  }
  const trustedComment = lines[trustedIdx].slice("trusted comment:".length).trim();
  const sigBlob = Buffer.from(sigLine, "base64");
  const globalSig = Buffer.from(lines[trustedIdx + 1], "base64");
  if (sigBlob.length !== 74 || globalSig.length !== 64) {
    throw new Error("malformed minisign signature payload");
  }
  const alg = sigBlob.toString("latin1", 0, 2);
  if (!sigBlob.subarray(2, 10).equals(keyId)) {
    throw new Error("signature key id does not match the pinned public key");
  }
  const signature = sigBlob.subarray(10, 74);

  const signed =
    alg === "ED"
      ? createHash("blake2b512").update(message).digest()
      : alg === "Ed"
        ? Buffer.from(message)
        : null;
  if (!signed) {
    throw new Error(`unknown minisign signature algorithm "${alg}"`);
  }
  if (!cryptoVerify(null, signed, publicKey, signature)) {
    throw new Error("checksums signature is INVALID");
  }
  // Global signature binds the trusted comment (release tag) to the sig.
  const globalMsg = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  if (!cryptoVerify(null, globalMsg, publicKey, globalSig)) {
    throw new Error("trusted-comment (global) signature is INVALID");
  }
  return { trustedComment };
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
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (!match) {
      continue;
    }
    if (match[2] === filename) {
      return match[1].toLowerCase();
    }
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
  let checksumsBody;
  try {
    checksumsBody = await fetchJsonOrText(checksumUrl);
    expectedHash = parseChecksums(checksumsBody, assetName);
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

  // Signature gate BEFORE trusting checksums (PLAN-41 D-B). Three regimes:
  // no pinned key yet -> note and continue; key pinned but release unsigned
  // -> warn and continue (pre-signing releases stay installable); key
  // pinned + signature present -> verify or REFUSE.
  if (!MINISIGN_PUBKEY_B64) {
    log("checksums signature not verified (no minisign pubkey pinned yet — D-B runbook pending)");
  } else {
    let minisig = null;
    try {
      minisig = await fetchJsonOrText(`${checksumUrl}.minisig`);
    } catch {
      warn(
        `orchestrator-v${version} has no checksums.txt.minisig (pre-signing release); ` +
          "proceeding on SHA-256 only",
      );
    }
    if (minisig) {
      try {
        const { trustedComment } = verifyMinisign({
          pubkeyB64: MINISIGN_PUBKEY_B64,
          message: checksumsBody,
          minisig,
        });
        if (!trustedComment.includes(`orchestrator-v${version}`)) {
          warn(
            `checksums signature is for "${trustedComment}", not orchestrator-v${version} ` +
              "(cross-release replay?) — refusing to install",
          );
          return;
        }
        log("checksums signature verified (minisign)");
      } catch (err) {
        warn(`checksums signature verification FAILED: ${err.message} — refusing to install`);
        return;
      }
    }
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
