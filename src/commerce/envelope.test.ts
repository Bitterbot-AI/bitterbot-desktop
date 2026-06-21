import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Envelope,
  generateKeyPair,
  makeEnvelope,
  signEnvelope,
  signingPreimage,
  validateEnvelope,
  verifyEnvelope,
} from "./envelope.js";

const vectorsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/protocol/aubaine-v1/test-vectors",
);
const loadVector = (name: string) =>
  JSON.parse(readFileSync(join(vectorsDir, name), "utf8")) as { envelope: Envelope } & {
    preimage_utf8?: string;
  };

// Reconstruct the generator's deterministic Ed25519 key from a seed label, to
// prove the SIGN path (not just verify) reproduces the published signature.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function keyFromSeedLabel(label: string) {
  const seed = crypto.createHash("sha256").update(`aubaine/v1 test seed: ${label}`).digest();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  return { privateKey, publicKeyHex: spki.subarray(spki.length - 32).toString("hex") };
}

describe("aubaine envelope signing", () => {
  it("verifies the published intent conformance vector", () => {
    expect(verifyEnvelope(loadVector("envelope-signing.json").envelope)).toBe(true);
  });

  it("verifies the published settlement-receipt vector", () => {
    expect(verifyEnvelope(loadVector("settlement-receipt.json").envelope)).toBe(true);
  });

  it("the documented preimage matches signingPreimage()", () => {
    const v = loadVector("envelope-signing.json");
    expect(signingPreimage(v.envelope).toString("utf8")).toBe(v.preimage_utf8);
  });

  it("re-signing with the seed key reproduces the published signature (deterministic)", () => {
    const v = loadVector("envelope-signing.json");
    const key = keyFromSeedLabel("buyer-A");
    expect(`ed25519:${key.publicKeyHex}`).toBe(v.envelope.author_pubkey);
    const { signature, ...unsigned } = v.envelope;
    const resigned = signEnvelope(unsigned, key);
    expect(resigned.signature).toBe(signature);
  });

  it("round-trips sign -> verify with a fresh key", () => {
    const key = generateKeyPair();
    const env = makeEnvelope("intent", { sku_canonical: "sha256:" + "a".repeat(64), qty: 1 }, key);
    expect(verifyEnvelope(env)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const key = generateKeyPair();
    const env = makeEnvelope("intent", { qty: 1 }, key);
    env.body.qty = 999;
    expect(verifyEnvelope(env)).toBe(false);
  });

  it("validateEnvelope enforces protocol, type, skew, and signature", () => {
    const key = generateKeyPair();
    const now = 1_000_000;
    const env = makeEnvelope("offer", { moq: 50 }, key, now);
    expect(validateEnvelope(env, { now, expectedType: "offer" }).ok).toBe(true);
    expect(validateEnvelope(env, { now, expectedType: "intent" }).ok).toBe(false);
    expect(validateEnvelope(env, { now: now + 10_000 }).ok).toBe(false); // stale
    expect(validateEnvelope({ ...env, protocol: "x/v1" }, { now }).ok).toBe(false);
  });
});
