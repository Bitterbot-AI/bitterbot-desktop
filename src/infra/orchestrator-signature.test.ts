import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkChecksumsSignature,
  MINISIGN_PUBKEY_ENV,
  ORCHESTRATOR_MINISIGN_PUBKEY,
  resolvePinnedMinisignPubkey,
  verifyMinisign,
} from "../../scripts/orchestrator-signature.mjs";

// PLAN-56 Phase 0: the postinstall fetcher must (a) say out loud when it
// cannot verify, (b) REFUSE when a key is pinned and the signature is missing
// or unfetchable (no downgrade to SHA-256 only), and
// (c) fail closed on a bad or cross-release signature. The keypair is a
// throwaway generated per test run; the on-disk formats are minisign's.

const TAG = "orchestrator-v0.2.3";
const CHECKSUMS = [
  "0".repeat(64) + "  bitterbot-orchestrator-linux-x64",
  "1".repeat(64) + "  bitterbot-orchestrator-darwin-arm64",
  "",
].join("\n");

type Keypair = { keyId: Buffer; privateKey: KeyObject; pubkeyB64: string };

function makeKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const keyId = randomBytes(8);
  const pubkeyB64 = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, rawPub]).toString("base64");
  return { keyId, privateKey, pubkeyB64 };
}

/** Produce a `.minisig` body the way `minisign -S -t <trusted>` does (alg "ED"). */
function signMinisig(kp: Keypair, message: string, trustedComment: string): string {
  const digest = createHash("blake2b512").update(message).digest();
  const signature = sign(null, digest, kp.privateKey);
  const sigBlob = Buffer.concat([Buffer.from("ED", "latin1"), kp.keyId, signature]);
  const globalSig = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
    kp.privateKey,
  );
  return [
    "untrusted comment: signature from test key",
    sigBlob.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSig.toString("base64"),
    "",
  ].join("\n");
}

function collect() {
  const logs: string[] = [];
  const warns: string[] = [];
  return { logs, warns, log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) };
}

describe("resolvePinnedMinisignPubkey", () => {
  it("falls back to the pinned constant (empty until Victor pins it)", () => {
    expect(resolvePinnedMinisignPubkey({})).toBe(ORCHESTRATOR_MINISIGN_PUBKEY);
  });

  it("lets the environment override the pinned key", () => {
    expect(resolvePinnedMinisignPubkey({ [MINISIGN_PUBKEY_ENV]: "  abc  " })).toBe("abc");
    expect(resolvePinnedMinisignPubkey({ [MINISIGN_PUBKEY_ENV]: "" })).toBe(
      ORCHESTRATOR_MINISIGN_PUBKEY,
    );
  });
});

describe("checkChecksumsSignature", () => {
  it("no pinned key: continues on SHA-256 with one explicit warning", async () => {
    const out = collect();
    const result = await checkChecksumsSignature({
      pubkeyB64: "",
      version: "0.2.3",
      checksumsBody: CHECKSUMS,
      fetchMinisig: async () => {
        throw new Error("must not be called without a key");
      },
      ...out,
    });
    expect(result).toEqual({ ok: true, verified: false });
    expect(out.warns).toHaveLength(1);
    expect(out.warns[0]).toContain("signature not verified (no pinned key)");
  });

  it("key pinned, signature missing or unfetchable: refuses (no downgrade to SHA-256)", async () => {
    const kp = makeKeypair();
    for (const message of ["HTTP 404 Not Found", "fetch failed: ECONNRESET"]) {
      const out = collect();
      const result = await checkChecksumsSignature({
        pubkeyB64: kp.pubkeyB64,
        version: "0.2.3",
        checksumsBody: CHECKSUMS,
        fetchMinisig: async () => {
          throw new Error(message);
        },
        ...out,
      });
      expect(result.ok, message).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("could not be fetched");
      expect(result.reason).toContain(message);
      expect(out.warns[0]).toContain("refusing to install");
    }
  });

  it("key pinned, valid signature for the tag: verified", async () => {
    const kp = makeKeypair();
    const out = collect();
    const minisig = signMinisig(kp, CHECKSUMS, `${TAG} checksums`);
    const result = await checkChecksumsSignature({
      pubkeyB64: kp.pubkeyB64,
      version: "0.2.3",
      checksumsBody: CHECKSUMS,
      fetchMinisig: async () => minisig,
      ...out,
    });
    expect(result).toEqual({ ok: true, verified: true });
    expect(out.warns).toHaveLength(0);
    expect(out.logs[0]).toContain("checksums signature verified");
  });

  it("key pinned, tampered checksums: fails closed", async () => {
    const kp = makeKeypair();
    const out = collect();
    const minisig = signMinisig(kp, CHECKSUMS, `${TAG} checksums`);
    const result = await checkChecksumsSignature({
      pubkeyB64: kp.pubkeyB64,
      version: "0.2.3",
      checksumsBody: CHECKSUMS.replace("0".repeat(64), "f".repeat(64)),
      fetchMinisig: async () => minisig,
      ...out,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("INVALID");
    expect(out.warns[0]).toContain("refusing to install");
  });

  it("key pinned, signature from another key: fails closed", async () => {
    const kp = makeKeypair();
    const other = makeKeypair();
    const minisig = signMinisig(other, CHECKSUMS, `${TAG} checksums`);
    const result = await checkChecksumsSignature({
      pubkeyB64: kp.pubkeyB64,
      version: "0.2.3",
      checksumsBody: CHECKSUMS,
      fetchMinisig: async () => minisig,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("key id does not match");
  });

  it("key pinned, signature replayed from another release: fails closed", async () => {
    const kp = makeKeypair();
    // 0.2.30 and 0.2.3-rc1 both CONTAIN "orchestrator-v0.2.3": the match must be exact.
    for (const other of ["0.2.2", "0.2.30", "0.2.3-rc1"]) {
      const minisig = signMinisig(kp, CHECKSUMS, `orchestrator-v${other} checksums`);
      const result = await checkChecksumsSignature({
        pubkeyB64: kp.pubkeyB64,
        version: "0.2.3",
        checksumsBody: CHECKSUMS,
        fetchMinisig: async () => minisig,
      });
      expect(result.ok, other).toBe(false);
      expect(result.reason).toContain("cross-release replay");
    }
  });

  it("the environment override is honoured only while no key is pinned in the repo", () => {
    expect(resolvePinnedMinisignPubkey({})).toBe("");
    expect(resolvePinnedMinisignPubkey({ [MINISIGN_PUBKEY_ENV]: "  RWabc  " })).toBe("RWabc");
  });
});

describe("verifyMinisign", () => {
  it("rejects a key that is not a minisign Ed25519 key", () => {
    expect(() =>
      verifyMinisign({
        pubkeyB64: Buffer.from("nope").toString("base64"),
        message: "",
        minisig: "",
      }),
    ).toThrow("not a minisign Ed25519 key");
  });

  it("rejects a malformed .minisig file", () => {
    const kp = makeKeypair();
    expect(() =>
      verifyMinisign({ pubkeyB64: kp.pubkeyB64, message: CHECKSUMS, minisig: "garbage\n" }),
    ).toThrow("malformed .minisig");
  });
});

// Cross-check against the real tool when it is installed (it is on the dev
// box; CI runners may not have it, so this skips rather than fails there).
const minisignBin = spawnSync("minisign", ["-v"], { encoding: "utf8" }).status === 0;

describe.skipIf(!minisignBin)("verifyMinisign against a real minisign signature", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("accepts what `minisign -S -t <tag>` produced and rejects a tampered message", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-minisign-"));
    const pubPath = path.join(dir, "test.pub");
    const secPath = path.join(dir, "test.key");
    const msgPath = path.join(dir, "checksums.txt");
    fs.writeFileSync(msgPath, CHECKSUMS);
    const gen = spawnSync("minisign", ["-G", "-W", "-f", "-p", pubPath, "-s", secPath], {
      encoding: "utf8",
    });
    expect(gen.status, gen.stderr).toBe(0);
    const sig = spawnSync(
      "minisign",
      ["-S", "-s", secPath, "-m", msgPath, "-t", `${TAG} checksums`, "-c", "test release"],
      { encoding: "utf8" },
    );
    expect(sig.status, sig.stderr).toBe(0);

    const pubkeyB64 = fs.readFileSync(pubPath, "utf8").split("\n")[1].trim();
    const minisig = fs.readFileSync(`${msgPath}.minisig`, "utf8");
    expect(verifyMinisign({ pubkeyB64, message: CHECKSUMS, minisig })).toEqual({
      trustedComment: `${TAG} checksums`,
    });
    expect(() => verifyMinisign({ pubkeyB64, message: `${CHECKSUMS}x`, minisig })).toThrow(
      "INVALID",
    );
  });
});
