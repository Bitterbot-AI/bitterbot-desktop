import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_MINISIGN_PUBKEY,
  verifyMinisign as verifyMinisignJs,
} from "../../scripts/orchestrator-signature.mjs";
import {
  makeTestMinisignKey,
  ORCHESTRATOR_FIXTURE_DIR,
  signTestMinisign,
} from "../test-utils/minisign.js";
import {
  formatMinisignKeyId,
  lookupSha256,
  MinisignError,
  parseMinisignPublicKey,
  RELEASE_MINISIGN_PUBKEY,
  releaseChecksumsComment,
  verifyMinisignSignature,
} from "./minisign.js";

const INSTALL_SH = fileURLToPath(new URL("../../scripts/install.sh", import.meta.url));

function opensslCanVerify(): boolean {
  const res = spawnSync("openssl", ["version"], { encoding: "utf8" });
  return res.status === 0 && res.stdout.startsWith("OpenSSL 3.");
}

/**
 * install.sh's OpenSSL verifier, called directly: the script minus its last
 * line (`main "$@"`) written to a file and sourced (bash 3.2 on macOS cannot
 * `source <(...)`). Returns the trusted comment, null on a refusal, or
 * "unsupported" when this machine's OpenSSL cannot check minisign.
 */
function verifyWithInstallSh(file: string, sig: string, pubkey: string): string | null {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-minisign-sh-"));
  try {
    const lib = path.join(work, "install-lib.sh");
    const body = fs.readFileSync(INSTALL_SH, "utf8").trimEnd().split("\n").slice(0, -1).join("\n");
    fs.writeFileSync(lib, `${body}\n`);
    fs.mkdirSync(path.join(work, "w"));
    const script =
      'source "$1"; bb_openssl_can_verify || { echo unsupported; exit 0; }; bb_openssl_minisign_verify "$2" "$3" "$4" "$5"';
    const res = spawnSync(
      "bash",
      ["-c", script, "bash", lib, file, sig, pubkey, path.join(work, "w")],
      { encoding: "utf8" },
    );
    return res.status === 0 ? res.stdout.trim() : null;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

describe("pinned release key: one value everywhere", () => {
  it("equals the orchestrator key and the key install.sh embeds", () => {
    expect(RELEASE_MINISIGN_PUBKEY).toBe(ORCHESTRATOR_MINISIGN_PUBKEY);
    const sh = fs.readFileSync(INSTALL_SH, "utf8");
    const m = /local PINNED_PUBKEY="([^"]+)"/.exec(sh);
    expect(m?.[1]).toBe(RELEASE_MINISIGN_PUBKEY);
    expect(formatMinisignKeyId(parseMinisignPublicKey(RELEASE_MINISIGN_PUBKEY).keyId)).toMatch(
      /^0?310E141334FF6D4$/,
    );
  });
});

describe("verifyMinisignSignature", () => {
  it("verifies the real orchestrator-v0.2.3 release signature with the pinned key", () => {
    const checksums = fs.readFileSync(path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt"));
    const minisig = fs.readFileSync(
      path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt.minisig"),
      "utf8",
    );
    const res = verifyMinisignSignature({
      pubkeyB64: RELEASE_MINISIGN_PUBKEY,
      message: checksums,
      minisig,
    });
    expect(res.trustedComment).toBe("orchestrator-v0.2.3 checksums");
    expect(res.algorithm).toBe("ED");
    // And it is NOT a valid app-release signature for any version.
    expect(res.trustedComment).not.toBe(releaseChecksumsComment("0.2.3"));
  });

  it("refuses the real fixture when one byte of checksums.txt changes", () => {
    const checksums = fs.readFileSync(path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt"));
    const tampered = Buffer.from(checksums);
    tampered[0] = tampered[0] === 0x30 ? 0x31 : 0x30;
    const minisig = fs.readFileSync(
      path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt.minisig"),
      "utf8",
    );
    expect(() =>
      verifyMinisignSignature({ pubkeyB64: RELEASE_MINISIGN_PUBKEY, message: tampered, minisig }),
    ).toThrow(/INVALID/);
  });

  it("accepts prehashed ED and legacy Ed signatures from a throwaway key", () => {
    const key = makeTestMinisignKey();
    for (const legacy of [false, true]) {
      const sig = signTestMinisign(key, "abc  file\n", "v1.2.3 checksums", { legacy });
      const res = verifyMinisignSignature({
        pubkeyB64: key.pubkeyB64,
        message: "abc  file\n",
        minisig: sig,
      });
      expect(res.trustedComment).toBe("v1.2.3 checksums");
      expect(res.algorithm).toBe(legacy ? "Ed" : "ED");
    }
  });

  it("refuses a signature from another key (key id check)", () => {
    const signer = makeTestMinisignKey();
    const pinned = makeTestMinisignKey();
    const sig = signTestMinisign(signer, "x", "v1.0.0 checksums");
    expect(() =>
      verifyMinisignSignature({ pubkeyB64: pinned.pubkeyB64, message: "x", minisig: sig }),
    ).toThrow(/key id/);
  });

  it("refuses a signature whose key id was forged to match the pinned key", () => {
    const signer = makeTestMinisignKey();
    const pinned = makeTestMinisignKey();
    const sig = signTestMinisign({ ...signer, keyId: pinned.keyId }, "x", "v1.0.0 checksums");
    expect(() =>
      verifyMinisignSignature({ pubkeyB64: pinned.pubkeyB64, message: "x", minisig: sig }),
    ).toThrow(/INVALID/);
  });

  it("refuses an edited trusted comment (global signature)", () => {
    const key = makeTestMinisignKey();
    const sig = signTestMinisign(key, "x", "v1.0.0 checksums").replace(
      "trusted comment: v1.0.0 checksums",
      "trusted comment: v9.9.9 checksums",
    );
    expect(() =>
      verifyMinisignSignature({ pubkeyB64: key.pubkeyB64, message: "x", minisig: sig }),
    ).toThrow(/global/);
  });

  it("refuses malformed files and keys", () => {
    const key = makeTestMinisignKey();
    const sig = signTestMinisign(key, "x", "v1.0.0 checksums");
    const lines = sig.split("\n");
    const cases = [
      "",
      lines.slice(0, 3).join("\n"),
      [lines[0], "!!!", lines[2], lines[3]].join("\n"),
      [lines[0], lines[1], "comment: x", lines[3]].join("\n"),
      [lines[0], Buffer.from("XX" + "a".repeat(72)).toString("base64"), lines[2], lines[3]].join(
        "\n",
      ),
    ];
    for (const minisig of cases) {
      expect(() =>
        verifyMinisignSignature({ pubkeyB64: key.pubkeyB64, message: "x", minisig }),
      ).toThrow(MinisignError);
    }
    expect(() => parseMinisignPublicKey("not base64!")).toThrow(MinisignError);
    expect(() => parseMinisignPublicKey(Buffer.alloc(42).toString("base64"))).toThrow(
      MinisignError,
    );
  });

  it("tolerates CRLF line ends", () => {
    const key = makeTestMinisignKey();
    const sig = signTestMinisign(key, "x", "v1.0.0 checksums").replace(/\n/g, "\r\n");
    expect(
      verifyMinisignSignature({ pubkeyB64: key.pubkeyB64, message: "x", minisig: sig })
        .trustedComment,
    ).toBe("v1.0.0 checksums");
  });
});

describe("same vectors, every verifier", () => {
  it("the TypeScript, orchestrator (JS) and install.sh (OpenSSL) verifiers agree", () => {
    const key = makeTestMinisignKey();
    const body = "0".repeat(64) + "  bitterbot-1.2.3-linux-x64.tar.gz\n";
    const good = signTestMinisign(key, body, "v1.2.3 checksums");
    const bad = signTestMinisign(makeTestMinisignKey(), body, "v1.2.3 checksums");
    expect(
      verifyMinisignSignature({ pubkeyB64: key.pubkeyB64, message: body, minisig: good })
        .trustedComment,
    ).toBe("v1.2.3 checksums");
    expect(verifyMinisignJs({ pubkeyB64: key.pubkeyB64, message: body, minisig: good })).toEqual({
      trustedComment: "v1.2.3 checksums",
    });
    expect(() =>
      verifyMinisignJs({ pubkeyB64: key.pubkeyB64, message: body, minisig: bad }),
    ).toThrow();
    if (process.platform === "win32" || !opensslCanVerify()) {
      return;
    }
    if (
      verifyWithInstallSh(
        path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt"),
        path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt.minisig"),
        RELEASE_MINISIGN_PUBKEY,
      ) === "unsupported"
    ) {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-minisign-"));
    try {
      fs.writeFileSync(path.join(dir, "checksums.txt"), body);
      fs.writeFileSync(path.join(dir, "good.minisig"), good);
      fs.writeFileSync(path.join(dir, "bad.minisig"), bad);
      expect(
        verifyWithInstallSh(
          path.join(dir, "checksums.txt"),
          path.join(dir, "good.minisig"),
          key.pubkeyB64,
        ),
      ).toBe("v1.2.3 checksums");
      expect(
        verifyWithInstallSh(
          path.join(dir, "checksums.txt"),
          path.join(dir, "bad.minisig"),
          key.pubkeyB64,
        ),
      ).toBeNull();
      // The real pinned-key fixture through install.sh's verifier too.
      expect(
        verifyWithInstallSh(
          path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt"),
          path.join(ORCHESTRATOR_FIXTURE_DIR, "checksums.txt.minisig"),
          RELEASE_MINISIGN_PUBKEY,
        ),
      ).toBe("orchestrator-v0.2.3 checksums");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lookupSha256", () => {
  it("matches the exact file name only", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const text = `${a}  bitterbot-1.0.0-linux-x64.tar.gz\n${b} *bitterbot-1.0.0-linux-x64.tar.gz.bak\n`;
    expect(lookupSha256(text, "bitterbot-1.0.0-linux-x64.tar.gz")).toBe(a);
    expect(lookupSha256(text, "bitterbot-1.0.0-linux-x64.tar.gz.bak")).toBe(b.toLowerCase());
    expect(lookupSha256(text, "bitterbot-1.0.0-linux-x64.tar")).toBeNull();
  });
});
