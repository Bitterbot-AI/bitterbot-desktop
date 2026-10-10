/**
 * Orchestrator release signature policy (PLAN-41 D-B, PLAN-56 Phase 0).
 *
 * Shared by scripts/fetch-orchestrator.mjs (postinstall) and its unit test.
 * Pure node:crypto, no minisign binary needed at install time.
 *
 * Two regimes, decided by checkChecksumsSignature():
 *   - no pinned key  -> one clear warning, SHA-256 remains the only gate
 *   - key pinned     -> the .minisig MUST be fetched and MUST verify for this
 *                       exact release; a missing or unfetchable signature is
 *                       a refusal, not a downgrade (an attacker who can forge
 *                       checksums.txt can also serve a 404 for its signature).
 *                       Tags older than FIRST_SIGNED_VERSION never had one and
 *                       are not fetched by this script (Cargo.toml pins 0.2.3+).
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Pinned minisign public key for orchestrator releases: the base64 payload
 * from the SECOND line of the fleet's minisign .pub file (the one that
 * matches the `MINISIGN_PUBLIC_KEY` repo secret used by
 * .github/workflows/orchestrator-release.yml).
 *
 * TODO(victor): pin, see PLAN-56 Phase 0. Releases since orchestrator-v0.2.3
 * ship `checksums.txt.minisig`; verification turns on the moment this is set.
 */
export const ORCHESTRATOR_MINISIGN_PUBKEY = "";

/** First orchestrator release that shipped checksums.txt.minisig. */
export const FIRST_SIGNED_VERSION = "0.2.3";

/**
 * Environment override for operators who pin AHEAD of the repo. It is
 * honoured only while the constant above is empty: once the repo pins a key,
 * the environment cannot swap it for another (that would let whoever controls
 * the install environment sign their own release).
 */
export const MINISIGN_PUBKEY_ENV = "BITTERBOT_ORCHESTRATOR_MINISIGN_PUBKEY";

/**
 * The key to verify with: the pinned constant when set, else the env
 * override, else "" (no verification possible).
 */
export function resolvePinnedMinisignPubkey(env = process.env, warn = () => {}) {
  const fromEnv = env[MINISIGN_PUBKEY_ENV]?.trim() || "";
  if (ORCHESTRATOR_MINISIGN_PUBKEY) {
    if (fromEnv && fromEnv !== ORCHESTRATOR_MINISIGN_PUBKEY) {
      warn(`${MINISIGN_PUBKEY_ENV} ignored: the repo pins the orchestrator signing key`);
    }
    return ORCHESTRATOR_MINISIGN_PUBKEY;
  }
  return fromEnv;
}

/**
 * Verify a minisign signature over `message` with a minisign public key.
 * minisign is Ed25519 underneath:
 *   pubkey payload  = "Ed" | key_id(8) | ed25519_pub(32)
 *   .minisig        = untrusted-comment line
 *                     base64( alg(2) | key_id(8) | signature(64) )
 *                     trusted-comment line
 *                     base64( global_sig(64) )  — over sig || trusted_comment
 * alg "ED" (current default) signs Blake2b-512(message); legacy "Ed"
 * signs the raw message. Throws with a reason on any mismatch.
 */
export function verifyMinisign({ pubkeyB64, message, minisig }) {
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

/**
 * Decide whether `checksumsBody` for `orchestrator-v<version>` may be
 * trusted. `fetchMinisig()` resolves to the .minisig text or rejects when
 * the tag has none.
 *
 * @returns {{ ok: boolean, verified: boolean, reason?: string }}
 *   ok=false means REFUSE the install (fail closed).
 */
export async function checkChecksumsSignature({
  pubkeyB64,
  version,
  checksumsBody,
  fetchMinisig,
  log = () => {},
  warn = () => {},
}) {
  if (!pubkeyB64) {
    warn(
      "checksums signature not verified (no pinned key): SHA-256 is the only gate. " +
        `Pin ORCHESTRATOR_MINISIGN_PUBKEY in scripts/orchestrator-signature.mjs or set ${MINISIGN_PUBKEY_ENV}.`,
    );
    return { ok: true, verified: false };
  }

  let minisig = null;
  try {
    minisig = await fetchMinisig();
  } catch (err) {
    // Fail closed: with a pinned key, "no signature" is indistinguishable
    // from "signature withheld". Never downgrade to SHA-256 only here.
    const reason =
      `checksums.txt.minisig for orchestrator-v${version} could not be fetched ` +
      `(${err?.message ?? err}); releases since ${FIRST_SIGNED_VERSION} are signed`;
    warn(`${reason} — refusing to install`);
    return { ok: false, verified: false, reason };
  }

  let trustedComment;
  try {
    ({ trustedComment } = verifyMinisign({ pubkeyB64, message: checksumsBody, minisig }));
  } catch (err) {
    const reason = `checksums signature verification FAILED: ${err.message}`;
    warn(`${reason} — refusing to install`);
    return { ok: false, verified: false, reason };
  }
  // Exact match: a substring test would accept orchestrator-v0.2.30 (or
  // 0.2.3-rc1) for 0.2.3, which is the replay this check exists to stop. The
  // release workflow signs with `-t "orchestrator-v<tag> checksums"`.
  if (trustedComment.trim() !== `orchestrator-v${version} checksums`) {
    const reason =
      `checksums signature is for "${trustedComment}", not orchestrator-v${version} ` +
      "(cross-release replay?)";
    warn(`${reason} — refusing to install`);
    return { ok: false, verified: false, reason };
  }
  log(`checksums signature verified (minisign, ${trustedComment})`);
  return { ok: true, verified: true };
}
