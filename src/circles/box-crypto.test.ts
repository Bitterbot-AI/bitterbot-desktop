import { describe, expect, it } from "vitest";
import { generateBoxKeyPair, openBox, sealToBox } from "./box-crypto.js";

// PLAN-31 C1 §3.2: sealed-box crypto for the mailbox. The property under
// test: only the recipient's box private key opens a blob; any tamper or
// wrong key fails closed (null), never throws.

describe("mailbox sealed boxes", () => {
  it("round-trips seal -> open with the recipient's key", () => {
    const bob = generateBoxKeyPair();
    const blob = sealToBox(bob.publicKeyB64, "the pizza is logged");
    expect(openBox(bob, blob)).toBe("the pizza is logged");
  });

  it("fails closed for the wrong recipient", () => {
    const bob = generateBoxKeyPair();
    const eve = generateBoxKeyPair();
    const blob = sealToBox(bob.publicKeyB64, "secret plan");
    expect(openBox(eve, blob)).toBeNull();
  });

  it("fails closed on any ciphertext/tag/epk tamper", () => {
    const bob = generateBoxKeyPair();
    const blob = sealToBox(bob.publicKeyB64, "secret plan");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(openBox(bob, { ...blob, ct: flip(blob.ct) })).toBeNull();
    expect(openBox(bob, { ...blob, tag: flip(blob.tag) })).toBeNull();
    expect(openBox(bob, { ...blob, epk: flip(blob.epk) })).toBeNull();
    expect(openBox(bob, { ...blob, iv: flip(blob.iv) })).toBeNull();
  });

  it("produces distinct ciphertexts per seal (ephemeral keys)", () => {
    const bob = generateBoxKeyPair();
    const a = sealToBox(bob.publicKeyB64, "same text");
    const b = sealToBox(bob.publicKeyB64, "same text");
    expect(a.ct).not.toBe(b.ct);
    expect(a.epk).not.toBe(b.epk);
    expect(openBox(bob, a)).toBe("same text");
    expect(openBox(bob, b)).toBe("same text");
  });

  it("rejects malformed pubkeys at seal time", () => {
    expect(() => sealToBox("dG9vLXNob3J0", "x")).toThrow(/32 raw bytes/);
  });
});
