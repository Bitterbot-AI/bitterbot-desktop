/**
 * Where a release-tarball update comes from and how it is verified
 * (PLAN-56 Phase 3b). Same rules as scripts/install.sh, minus its
 * "SHA-256 only" tier: Node always has Ed25519, so the updater ALWAYS checks
 * the minisign signature and fails closed.
 *
 *   1. Target: the newest COMPLETE release (tag vX.Y.Z, not draft, not
 *      prerelease, carrying this platform's tarball AND checksums.txt AND
 *      checksums.txt.minisig): pickLatestTarballRelease, the same rule as
 *      install.sh's bb_pick_latest. Or a pinned version (`--tag`).
 *   2. checksums.txt.minisig must exist and verify against the pinned key
 *      (RELEASE_MINISIGN_PUBKEY), and its trusted comment must be exactly
 *      `v<version> checksums` (no replay of another release's signature).
 *   3. The tarball's SHA-256 must equal the checksums.txt entry for its
 *      exact file name.
 *
 * Test mode (CI only) mirrors install.sh: BITTERBOT_INSTALL_BASE_URL and
 * BITTERBOT_INSTALL_TEST_PUBKEY are refused unless
 * BITTERBOT_INSTALL_TEST_MODE=1, the base URL must be loopback http or
 * file:///, may not carry `@`, and redirects are refused. Only the CLI asks
 * for test mode (`allowTestMode: true`); the gateway's update.run (and so
 * the Control UI) always passes false, which ignores these variables
 * entirely, so no RPC caller can swap the key or the download origin.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { tarballAssetName } from "./install-kind.js";
import {
  lookupSha256,
  MinisignError,
  RELEASE_MINISIGN_PUBKEY,
  releaseChecksumsComment,
  verifyMinisignSignature,
} from "./minisign.js";
import {
  GITHUB_RELEASES_URL,
  pickLatestTarballRelease,
  TARBALL_CHECKSUMS_ASSET,
  TARBALL_SIGNATURE_ASSET,
} from "./update-check.js";

export const INSTALL_TEST_MODE_ENV = "BITTERBOT_INSTALL_TEST_MODE";
export const INSTALL_BASE_URL_ENV = "BITTERBOT_INSTALL_BASE_URL";
export const INSTALL_TEST_PUBKEY_ENV = "BITTERBOT_INSTALL_TEST_PUBKEY";

export const PRODUCTION_RELEASES_BASE =
  "https://github.com/Bitterbot-AI/bitterbot-desktop/releases";

/** Size caps: checksums and signatures are tiny; the API listing is bounded. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export class ReleaseVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseVerificationError";
  }
}

export type ReleaseSource = {
  testMode: boolean;
  /** `<base>/download/v<version>/<asset>` is where assets come from. */
  baseUrl: string;
  /** The GitHub releases API listing (test mode: `<base>/api/releases.json`). */
  apiUrl: string;
  pubkeyB64: string;
};

function productionSource(): ReleaseSource {
  return {
    testMode: false,
    baseUrl: PRODUCTION_RELEASES_BASE,
    apiUrl: GITHUB_RELEASES_URL,
    pubkeyB64: RELEASE_MINISIGN_PUBKEY,
  };
}

const LOOPBACK_HTTP = /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+(\/|$)/;

/**
 * Production source, or (CLI only, with every install.sh condition met) the
 * test source. Throws a ReleaseVerificationError when the CLI sees test
 * overrides without test mode or with a non-loopback URL.
 */
export function resolveReleaseSource(params: {
  allowTestMode: boolean;
  env?: NodeJS.ProcessEnv;
  warn?: (msg: string) => void;
}): ReleaseSource {
  const env = params.env ?? process.env;
  const baseOverride = env[INSTALL_BASE_URL_ENV]?.trim() ?? "";
  const keyOverride = env[INSTALL_TEST_PUBKEY_ENV]?.trim() ?? "";
  if (!baseOverride && !keyOverride) {
    return productionSource();
  }
  if (!params.allowTestMode) {
    // The gateway (update.run, the Control UI) never honours these.
    params.warn?.(
      `${INSTALL_BASE_URL_ENV} / ${INSTALL_TEST_PUBKEY_ENV} are ignored here: test mode exists only for the CLI. Using GitHub Releases and the pinned key.`,
    );
    return productionSource();
  }
  if (env[INSTALL_TEST_MODE_ENV] !== "1") {
    throw new ReleaseVerificationError(
      `${INSTALL_BASE_URL_ENV} / ${INSTALL_TEST_PUBKEY_ENV} are test-only and need ${INSTALL_TEST_MODE_ENV}=1; refusing (production updates always use the pinned key and GitHub Releases)`,
    );
  }
  if (!baseOverride) {
    throw new ReleaseVerificationError(
      `${INSTALL_TEST_PUBKEY_ENV} cannot be combined with GitHub Releases; set a loopback ${INSTALL_BASE_URL_ENV} too`,
    );
  }
  if (baseOverride.includes("@")) {
    throw new ReleaseVerificationError(
      `test mode refuses a ${INSTALL_BASE_URL_ENV} with '@' (userinfo)`,
    );
  }
  if (!LOOPBACK_HTTP.test(baseOverride) && !baseOverride.startsWith("file:///")) {
    throw new ReleaseVerificationError(
      `test mode only accepts a loopback http://127.0.0.1:<port> / http://localhost:<port> or file:/// ${INSTALL_BASE_URL_ENV}`,
    );
  }
  const baseUrl = baseOverride.replace(/\/+$/, "");
  return {
    testMode: true,
    baseUrl,
    apiUrl: `${baseUrl}/api/releases.json`,
    pubkeyB64: keyOverride || RELEASE_MINISIGN_PUBKEY,
  };
}

function assertUrlAllowed(source: ReleaseSource, url: string): void {
  if (source.testMode) {
    if (url.includes("@") || !(LOOPBACK_HTTP.test(url) || url.startsWith("file:///"))) {
      throw new ReleaseVerificationError(`test mode refuses ${url}`);
    }
    return;
  }
  if (!url.startsWith("https://")) {
    throw new ReleaseVerificationError(`refusing a non-HTTPS download: ${url}`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * One GET with node:http(s). (Not fetch: undici asserts and crashes the
 * process when a paused response body meets a closing socket, which a large
 * streamed download into a slower disk triggers.) The timeout is a socket
 * idle timeout, so a long download that keeps moving is never cut off.
 */
function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<http.IncomingMessage> {
  const get = url.startsWith("https:") ? https.get : http.get;
  return new Promise((resolve, reject) => {
    const req = get(url, { headers }, resolve);
    req.on("error", reject);
    req.setTimeout(Math.max(1000, Math.min(timeoutMs, 120_000)), () => {
      req.destroy(new ReleaseVerificationError(`no data from ${url} for too long`));
    });
  });
}

async function openUrl(
  source: ReleaseSource,
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Readable | null; url: string }> {
  assertUrlAllowed(source, url);
  if (url.startsWith("file:///")) {
    const file = fileURLToPath(url);
    if (!fs.existsSync(file)) {
      return { status: 404, body: null, url };
    }
    return { status: 200, body: fs.createReadStream(file), url };
  }
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const res = await httpGet(
      current,
      { "User-Agent": "bitterbot-updater", ...headers },
      timeoutMs,
    );
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (!REDIRECT_STATUSES.has(status) || !location) {
      return { status, body: res, url: current };
    }
    res.resume();
    // Test mode: no redirects at all (install.sh: --max-redirs 0). Production
    // follows GitHub's asset redirect, which must stay on HTTPS.
    if (source.testMode) {
      throw new ReleaseVerificationError(`test mode refuses a redirect from ${current}`);
    }
    if (hop >= MAX_REDIRECTS) {
      throw new ReleaseVerificationError(`too many redirects from ${url}`);
    }
    const next = new URL(location, current).toString();
    if (!next.startsWith("https://")) {
      throw new ReleaseVerificationError(`download was redirected off HTTPS: ${next}`);
    }
    current = next;
  }
}

async function readAll(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > max) {
      stream.destroy();
      throw new ReleaseVerificationError(`response larger than ${max} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** GET a small text resource; null on 404. */
export async function fetchReleaseText(
  source: ReleaseSource,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<string | null> {
  const res = await openUrl(source, url, timeoutMs, headers);
  if (res.status === 404) {
    res.body?.destroy();
    return null;
  }
  if (res.status !== 200 || !res.body) {
    res.body?.destroy();
    if (res.status === 403 || res.status === 429) {
      throw new ReleaseVerificationError(
        `${url} answered HTTP ${res.status} (unauthenticated GitHub API requests are limited to 60 per hour per IP); try again later or pin a version with --tag`,
      );
    }
    throw new ReleaseVerificationError(`${url} answered HTTP ${res.status}`);
  }
  return (await readAll(res.body, MAX_TEXT_BYTES)).toString("utf8");
}

/** Stream a release asset to `dest` and return its SHA-256. */
export async function downloadReleaseAsset(
  source: ReleaseSource,
  url: string,
  dest: string,
  timeoutMs: number,
): Promise<string> {
  const res = await openUrl(source, url, timeoutMs);
  if (res.status !== 200 || !res.body) {
    res.body?.destroy();
    throw new ReleaseVerificationError(`could not download ${url} (HTTP ${res.status})`);
  }
  const hash = createHash("sha256");
  await pipeline(
    res.body,
    async function* (chunks: AsyncIterable<Buffer | Uint8Array>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(dest, { mode: 0o600 }),
  );
  return hash.digest("hex");
}

export function releaseAssetUrl(source: ReleaseSource, version: string, asset: string): string {
  return `${source.baseUrl}/download/v${version}/${asset}`;
}

/** The newest complete release for `platformId`, or null when none is published. */
export async function resolveLatestTarballVersion(
  source: ReleaseSource,
  platformId: string,
  timeoutMs: number,
): Promise<string | null> {
  const body = await fetchReleaseText(source, source.apiUrl, timeoutMs, {
    Accept: "application/vnd.github+json",
  });
  if (body === null) {
    throw new ReleaseVerificationError(`${source.apiUrl} answered HTTP 404`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ReleaseVerificationError("the releases API answered with malformed JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new ReleaseVerificationError(
      "the releases API answered with something other than a list",
    );
  }
  return pickLatestTarballRelease(parsed, platformId);
}

export type VerifiedChecksums = {
  version: string;
  checksums: string;
  /** Expected SHA-256 of this platform's tarball. */
  tarballSha256: string;
  asset: string;
  trustedComment: string;
};

/**
 * Download and verify `checksums.txt` for release `version`: signature with
 * the source's key, exact trusted comment, and an entry for this platform's
 * tarball. Throws a ReleaseVerificationError on any failure.
 */
export async function fetchVerifiedChecksums(
  source: ReleaseSource,
  version: string,
  platformId: string,
  timeoutMs: number,
): Promise<VerifiedChecksums> {
  const checksums = await fetchReleaseText(
    source,
    releaseAssetUrl(source, version, TARBALL_CHECKSUMS_ASSET),
    timeoutMs,
  );
  if (checksums === null) {
    throw new ReleaseVerificationError(
      `release v${version} has no ${TARBALL_CHECKSUMS_ASSET} (not a tarball release, or its signing step has not run yet)`,
    );
  }
  const minisig = await fetchReleaseText(
    source,
    releaseAssetUrl(source, version, TARBALL_SIGNATURE_ASSET),
    timeoutMs,
  );
  if (minisig === null) {
    throw new ReleaseVerificationError(
      `release v${version} has no ${TARBALL_SIGNATURE_ASSET}: every release is signed, so a missing signature is treated as tampering. Refusing.`,
    );
  }
  let trustedComment: string;
  try {
    ({ trustedComment } = verifyMinisignSignature({
      pubkeyB64: source.pubkeyB64,
      message: Buffer.from(checksums, "utf8"),
      minisig,
    }));
  } catch (err) {
    const reason = err instanceof MinisignError ? err.message : String(err);
    throw new ReleaseVerificationError(
      `${TARBALL_CHECKSUMS_ASSET} signature check FAILED for v${version} (${reason}). Refusing.`,
    );
  }
  const expected = releaseChecksumsComment(version);
  if (trustedComment !== expected) {
    throw new ReleaseVerificationError(
      `signature is for '${trustedComment}', not '${expected}' (a signature replayed from another release?). Refusing.`,
    );
  }
  const asset = tarballAssetName(version, platformId);
  const tarballSha256 = lookupSha256(checksums, asset);
  if (!tarballSha256) {
    throw new ReleaseVerificationError(`${TARBALL_CHECKSUMS_ASSET} has no entry for ${asset}`);
  }
  return { version, checksums, tarballSha256, asset, trustedComment };
}

/** Download the platform tarball into `dir` and check it against `verified`. */
export async function downloadVerifiedTarball(
  source: ReleaseSource,
  verified: VerifiedChecksums,
  dir: string,
  timeoutMs: number,
): Promise<string> {
  const dest = path.join(dir, verified.asset);
  const actual = await downloadReleaseAsset(
    source,
    releaseAssetUrl(source, verified.version, verified.asset),
    dest,
    timeoutMs,
  );
  if (actual !== verified.tarballSha256) {
    await fsp.rm(dest, { force: true });
    throw new ReleaseVerificationError(
      `${verified.asset} SHA-256 mismatch (expected ${verified.tarballSha256}, got ${actual}). Refusing.`,
    );
  }
  return dest;
}
