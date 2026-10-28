import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeSkillContentHash,
  validateSkillEnvelope,
  verifySkillSignature,
} from "./envelope-validation.js";
import type { SkillEnvelope } from "./ingest.js";

function signed(body = "---\nname: x\ndescription: y\n---\nbody\n"): SkillEnvelope {
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(body, "utf-8");
  return {
    version: 1,
    name: "x",
    author_peer_id: "peer",
    timestamp: 1,
    skill_md: bytes.toString("base64"),
    content_hash: createHash("sha256").update(bytes).digest("hex"),
    author_pubkey: keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
    signature: sign(null, bytes, keys.privateKey).toString("base64"),
  };
}

describe("envelope-validation", () => {
  it("accepts an authentic envelope", () => {
    const e = signed();
    expect(verifySkillSignature(e)).toBe(true);
    expect(validateSkillEnvelope(e)).toBeNull();
    expect(computeSkillContentHash(e.skill_md)).toBe(e.content_hash);
  });

  it("rejects a signature over different bytes", () => {
    const e = signed();
    const other = Buffer.from("other", "utf-8");
    e.skill_md = other.toString("base64");
    e.content_hash = createHash("sha256").update(other).digest("hex");
    expect(validateSkillEnvelope(e)).toBe("invalid Ed25519 signature");
  });

  it("reports a hash mismatch only once the signature holds", () => {
    const e = signed();
    e.content_hash = "0".repeat(64);
    expect(validateSkillEnvelope(e)).toBe("content hash mismatch");
  });

  it.each([
    ["short key", (e: SkillEnvelope) => (e.author_pubkey = Buffer.alloc(16).toString("base64"))],
    ["short signature", (e: SkillEnvelope) => (e.signature = Buffer.alloc(63).toString("base64"))],
    ["garbage key", (e: SkillEnvelope) => (e.author_pubkey = "not base64 at all!!")],
    ["empty signature", (e: SkillEnvelope) => (e.signature = "")],
  ])("fails closed on %s without throwing", (_label, mutate) => {
    const e = signed();
    mutate(e);
    expect(verifySkillSignature(e)).toBe(false);
    expect(validateSkillEnvelope(e)).toBe("invalid Ed25519 signature");
  });
});
