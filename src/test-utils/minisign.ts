/**
 * Shared minisign test vectors (PLAN-56 Phase 3b): a throwaway Ed25519 key in
 * minisign's public-key format and signatures in minisign's .minisig format.
 * Used by the install.sh tests, the TypeScript verifier tests
 * (src/infra/minisign.test.ts) and the tarball updater tests, so the shell
 * and TypeScript verifiers are checked against the same bytes. The real
 * signed fixture (orchestrator-v0.2.3, pinned key) lives under
 * src/infra/__fixtures__/.
 */
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export type TestMinisignKey = {
  pubkeyB64: string;
  privateKey: crypto.KeyObject;
  keyId: Buffer;
};

export function makeTestMinisignKey(): TestMinisignKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = crypto.randomBytes(8);
  const pubkeyB64 = Buffer.concat([Buffer.from("Ed"), keyId, rawPub]).toString("base64");
  return { pubkeyB64, privateKey, keyId };
}

/**
 * A .minisig body exactly as `minisign -S -t <comment>` writes it. `legacy`
 * produces the pre-0.8 "Ed" algorithm (signature over the raw message).
 */
export function signTestMinisign(
  key: TestMinisignKey,
  message: Buffer | string,
  trustedComment: string,
  opts: { legacy?: boolean } = {},
): string {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
  const signed = opts.legacy ? body : crypto.createHash("blake2b512").update(body).digest();
  const sig = crypto.sign(null, signed, key.privateKey);
  const blob = Buffer.concat([Buffer.from(opts.legacy ? "Ed" : "ED"), key.keyId, sig]);
  const global = crypto.sign(
    null,
    Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]),
    key.privateKey,
  );
  return [
    "untrusted comment: signature from a throwaway test key",
    blob.toString("base64"),
    `trusted comment: ${trustedComment}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

/** The real orchestrator-v0.2.3 release signature, made with the pinned key. */
export const ORCHESTRATOR_FIXTURE_DIR = fileURLToPath(
  new URL("../infra/__fixtures__/orchestrator-v0.2.3/", import.meta.url),
);
