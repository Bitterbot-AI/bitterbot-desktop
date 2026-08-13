import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { generateKeyPair } from "../commerce/envelope.js";
import { canonicalJson as nodeCanonicalJson, type JsonValue } from "../commerce/sku.js";
import { makeCircleEnvelope } from "./envelope.js";

// The guest-JOIN page (deploy/guest-page/index.html) verifies invite
// signatures in-browser with a hand-ported copy of the circle/v1 preimage
// construction. These tests extract that inline block (between the
// __VERIFY_LIB_START__ / __VERIFY_LIB_END__ markers) and cross-check it
// against the Node implementation — if the port drifts, every signature the
// page checks would "fail", and this suite catches it before deploy.

const PAGE_PATH = join(__dirname, "..", "..", "deploy", "guest-page", "index.html");

type VerifyLib = {
  canonicalJson: (v: unknown) => string;
  hexToBytes: (hex: string) => Uint8Array;
  verifyInviteSignature: (
    env: Record<string, unknown>,
    subtle: unknown,
  ) => Promise<"valid" | "invalid" | "unsupported">;
};

function loadVerifyLib(): VerifyLib {
  const html = readFileSync(PAGE_PATH, "utf8");
  const start = html.indexOf("__VERIFY_LIB_START__");
  const end = html.indexOf("__VERIFY_LIB_END__");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("guest page verify-lib markers missing");
  }
  // Slice from the end of the start-marker comment to the start of the
  // end-marker comment, then evaluate the browser code in a bare vm context
  // (TextEncoder injected — everything else in the block is dependency-free).
  const block = html.slice(html.indexOf("*/", start) + 2, html.lastIndexOf("/*", end));
  return runInNewContext(`${block}; ({ canonicalJson, hexToBytes, verifyInviteSignature })`, {
    TextEncoder,
  }) as VerifyLib;
}

describe("guest page in-browser signature verification", () => {
  const lib = loadVerifyLib();
  const key = generateKeyPair();
  const env = makeCircleEnvelope(
    "invite",
    "c".repeat(64),
    {
      inviter_name: "Ana — éè你好",
      circle_name: "Tahoe Crew",
      expires_at: 1_800_000_000_000,
      nested: { z: [1, 2.5, -3], a: { deep: true, nil: null } },
    },
    key,
    1_755_000_000,
  ) as unknown as Record<string, unknown>;

  it("canonicalJson byte-matches the Node signer's construction", () => {
    const fixtures: JsonValue[] = [
      null,
      true,
      0,
      -1.25,
      "plain",
      'quo"tes\nand\\slashes',
      "é你好😀",
      [1, "two", null, { b: 1, a: 2 }],
      { z: 1, a: { c: [true, false], b: "x" }, m: null },
    ];
    for (const f of fixtures) {
      expect(lib.canonicalJson(f)).toBe(nodeCanonicalJson(f));
    }
    const { signature: _omit, ...unsigned } = env as { signature?: string };
    expect(lib.canonicalJson(unsigned)).toBe(nodeCanonicalJson(unsigned as JsonValue));
  });

  it("verifies a genuinely signed invite envelope", async () => {
    await expect(lib.verifyInviteSignature(env, webcrypto.subtle)).resolves.toBe("valid");
  });

  it("hard-fails a tampered or malformed envelope", async () => {
    const tampered = {
      ...env,
      body: { ...(env.body as Record<string, unknown>), inviter_name: "Mallory" },
    };
    await expect(lib.verifyInviteSignature(tampered, webcrypto.subtle)).resolves.toBe("invalid");
    const badSig = { ...env, signature: "ab".repeat(64) };
    await expect(lib.verifyInviteSignature(badSig, webcrypto.subtle)).resolves.toBe("invalid");
    const noSig = { ...env, signature: undefined };
    await expect(lib.verifyInviteSignature(noSig, webcrypto.subtle)).resolves.toBe("invalid");
    const badKey = { ...env, author_pubkey: "ed25519:zz" };
    await expect(lib.verifyInviteSignature(badKey, webcrypto.subtle)).resolves.toBe("invalid");
  });

  it("degrades to 'unsupported' when the browser lacks Ed25519 WebCrypto", async () => {
    await expect(lib.verifyInviteSignature(env, {})).resolves.toBe("unsupported");
    const throwingSubtle = {
      importKey: () => {
        throw new Error("Ed25519 not supported");
      },
    };
    await expect(lib.verifyInviteSignature(env, throwingSubtle)).resolves.toBe("unsupported");
  });
});
