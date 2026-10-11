/**
 * scripts/install.sh (PLAN-56 Phase 3a) against fake releases on disk:
 * every verification tier, upgrade-in-place with the previous version kept,
 * and every refusal (tampering, replayed or foreign signatures, test-only
 * overrides outside test mode). The real tarball is exercised end to end by
 * the `installer` job in .github/workflows/ci.yml.
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_MINISIGN_PUBKEY,
  verifyMinisign,
} from "../../scripts/orchestrator-signature.mjs";
import { tarballPlatformId } from "./install-kind.js";

const INSTALL_SH = fileURLToPath(new URL("../../scripts/install.sh", import.meta.url));
const platformId = tarballPlatformId();

type TestKey = { pubkeyB64: string; privateKey: crypto.KeyObject; keyId: Buffer };

function makeKey(): TestKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = crypto.randomBytes(8);
  const pubkeyB64 = Buffer.concat([Buffer.from("Ed"), keyId, rawPub]).toString("base64");
  return { pubkeyB64, privateKey, keyId };
}

/** A minisign-format (prehashed "ED") signature, as `minisign -S -t <comment>` writes it. */
function minisign(key: TestKey, message: Buffer, trustedComment: string): string {
  const digest = crypto.createHash("blake2b512").update(message).digest();
  const sig = crypto.sign(null, digest, key.privateKey);
  const blob = Buffer.concat([Buffer.from("ED"), key.keyId, sig]);
  const global = crypto.sign(
    null,
    Buffer.concat([sig, Buffer.from(trustedComment)]),
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

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function opensslCanVerify(): boolean {
  const res = spawnSync("openssl", ["version"], { encoding: "utf8" });
  return res.status === 0 && res.stdout.startsWith("OpenSSL 3.");
}

function hasCommand(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

const describeInstaller = process.platform !== "win32" && platformId ? describe : describe.skip;

describeInstaller("scripts/install.sh", () => {
  let work: string;
  let key: TestKey;
  let releases: string;

  /** Build a fake signed release `version` under releases/download/v<version>. */
  function publish(
    version: string,
    opts: { tamper?: boolean; comment?: string; signer?: TestKey; noSig?: boolean } = {},
  ) {
    const top = `bitterbot-${version}-${platformId}`;
    const src = path.join(work, "src", version);
    fs.mkdirSync(path.join(src, top, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(src, top, "bin", "bitterbot"),
      `#!/bin/sh\necho "fake bitterbot ${version} $*"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(src, top, "manifest.json"),
      `${JSON.stringify({ version, platform: platformId }, null, 1)}\n`,
    );
    const dir = path.join(releases, "download", `v${version}`);
    fs.mkdirSync(dir, { recursive: true });
    const asset = `${top}.tar.gz`;
    execFileSync("tar", ["-czf", path.join(dir, asset), "-C", src, top]);
    const tarball = fs.readFileSync(path.join(dir, asset));
    const checksums = `${sha256(tarball)}  ${asset}\n${"0".repeat(64)}  install.sh\n`;
    fs.writeFileSync(path.join(dir, "checksums.txt"), checksums);
    fs.rmSync(path.join(dir, "checksums.txt.minisig"), { force: true });
    if (!opts.noSig) {
      fs.writeFileSync(
        path.join(dir, "checksums.txt.minisig"),
        minisign(
          opts.signer ?? key,
          Buffer.from(checksums),
          opts.comment ?? `v${version} checksums`,
        ),
      );
    }
    if (opts.tamper) {
      fs.appendFileSync(path.join(dir, asset), "tampered");
    }
    // releases/latest/download mirrors the newest publish.
    fs.rmSync(path.join(releases, "latest"), { recursive: true, force: true });
    fs.mkdirSync(path.join(releases, "latest"), { recursive: true });
    fs.cpSync(dir, path.join(releases, "latest", "download"), { recursive: true });
  }

  function runInstaller(
    args: string[],
    env: Record<string, string | undefined> = {},
    home = path.join(work, "home"),
  ) {
    fs.mkdirSync(home, { recursive: true });
    const res = spawnSync("bash", [INSTALL_SH, "--yes", "--no-onboard", ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: work,
        BITTERBOT_INSTALL_TEST_MODE: "1",
        BITTERBOT_INSTALL_BASE_URL: pathToFileURL(releases).href,
        BITTERBOT_INSTALL_TEST_PUBKEY: key.pubkeyB64,
        ...env,
      },
    });
    return { status: res.status, out: `${res.stdout}${res.stderr}`, home };
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-install-sh-"));
    releases = path.join(work, "releases");
    key = makeKey();
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("pins the same minisign key as the orchestrator signature policy", () => {
    const script = fs.readFileSync(INSTALL_SH, "utf8");
    expect(script).toContain(`local PINNED_PUBKEY="${ORCHESTRATOR_MINISIGN_PUBKEY}"`);
    // The body runs only from the last line (safe under a partial download).
    expect(script.trimEnd().split("\n").at(-1)).toBe('main "$@"');
  });

  it("the test signer produces signatures the production verifier accepts", () => {
    const msg = Buffer.from("hello\n");
    const sig = minisign(key, msg, "v9.9.9 checksums");
    expect(verifyMinisign({ pubkeyB64: key.pubkeyB64, message: msg, minisig: sig })).toEqual({
      trustedComment: "v9.9.9 checksums",
    });
  });

  it("refuses the test-only overrides unless test mode is explicitly on", () => {
    publish("1.4.0");
    const res = runInstaller([], { BITTERBOT_INSTALL_TEST_MODE: undefined });
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("test-only and need BITTERBOT_INSTALL_TEST_MODE=1");
    const keyOnly = runInstaller([], {
      BITTERBOT_INSTALL_TEST_MODE: undefined,
      BITTERBOT_INSTALL_BASE_URL: undefined,
    });
    expect(keyOnly.status).not.toBe(0);
    expect(keyOnly.out).toContain("refusing");
  });

  it("even in test mode, refuses a non-loopback base URL", () => {
    const res = runInstaller([], { BITTERBOT_INSTALL_BASE_URL: "https://example.com/releases" });
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("loopback");
  });

  it("SHA-256-only fallback says so, and --require-signature refuses it", () => {
    publish("1.4.0");
    const home = path.join(work, "home-none");
    const res = runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "none" }, home);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("signature NOT verified");
    const strict = runInstaller(
      ["--require-signature"],
      { BITTERBOT_INSTALL_TEST_VERIFIER: "none" },
      path.join(work, "home-strict"),
    );
    expect(strict.status).not.toBe(0);
  });

  it.runIf(opensslCanVerify())(
    "verifies with OpenSSL, installs, links, then upgrades keeping the previous version",
    () => {
      publish("1.4.0");
      const first = runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "openssl" });
      expect(first.status, first.out).toBe(0);
      expect(first.out).toContain("minisign signature checked with OpenSSL (pinned key)");
      const app = path.join(first.home, ".bitterbot", "app");
      expect(fs.readlinkSync(path.join(app, "current"))).toBe("1.4.0");
      const link = path.join(first.home, ".local", "bin", "bitterbot");
      expect(fs.readlinkSync(link)).toBe(path.join(app, "current", "bin", "bitterbot"));
      expect(execFileSync(link, ["--version"], { encoding: "utf8" })).toContain(
        "fake bitterbot 1.4.0",
      );

      publish("1.4.1");
      const second = runInstaller(["--version", "1.4.1"], {
        BITTERBOT_INSTALL_TEST_VERIFIER: "openssl",
      });
      expect(second.status, second.out).toBe(0);
      expect(fs.readlinkSync(path.join(app, "current"))).toBe("1.4.1");
      expect(fs.readlinkSync(path.join(app, "previous"))).toBe("1.4.0");
      expect(fs.existsSync(path.join(app, "1.4.0", "bin", "bitterbot"))).toBe(true);
      expect(execFileSync(link, [], { encoding: "utf8" })).toContain("fake bitterbot 1.4.1");

      // Re-running the same build keeps its directory in place (a gateway may
      // be running from it) and keeps the previous version.
      const marker = path.join(app, "1.4.1", "still-here");
      fs.writeFileSync(marker, "");
      const again = runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "openssl" });
      expect(again.status, again.out).toBe(0);
      expect(again.out).toContain("already installed; keeping it in place");
      expect(fs.existsSync(marker)).toBe(true);
      expect(
        fs.readdirSync(app).some((n) => n.startsWith(".staging") || n.startsWith(".replaced")),
      ).toBe(false);
      expect(fs.readlinkSync(path.join(app, "current"))).toBe("1.4.1");
      expect(fs.existsSync(path.join(app, "1.4.0"))).toBe(true);
    },
  );

  it.runIf(hasCommand("minisign"))("verifies with the minisign binary", () => {
    publish("1.4.2");
    const res = runInstaller(
      [],
      { BITTERBOT_INSTALL_TEST_VERIFIER: "minisign" },
      path.join(work, "home-minisign"),
    );
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("Verified: minisign signature (pinned key)");
  });

  describe.each(
    [opensslCanVerify() ? "openssl" : null, hasCommand("minisign") ? "minisign" : null].filter(
      (v): v is string => v !== null,
    ),
  )("refusals with the %s verifier", (verifier) => {
    const env = { BITTERBOT_INSTALL_TEST_VERIFIER: verifier };

    it("refuses a signature from another key", () => {
      publish("1.5.0", { signer: makeKey() });
      const res = runInstaller([], env, path.join(work, `home-foreign-${verifier}`));
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("INVALID");
      expect(
        fs.existsSync(path.join(work, `home-foreign-${verifier}`, ".bitterbot", "app", "1.5.0")),
      ).toBe(false);
    });

    it("refuses a signature replayed from another release", () => {
      publish("1.5.0", { comment: "v1.4.0 checksums" });
      const res = runInstaller([], env, path.join(work, `home-replay-${verifier}`));
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("replayed");
    });

    it("refuses an orchestrator release signature (same key, other trusted comment)", () => {
      publish("1.5.0", { comment: "orchestrator-v0.2.3 checksums" });
      const res = runInstaller([], env, path.join(work, `home-orch-${verifier}`));
      expect(res.status).not.toBe(0);
    });

    it("refuses a tarball whose SHA-256 does not match the signed checksums", () => {
      publish("1.5.0", { tamper: true });
      const res = runInstaller([], env, path.join(work, `home-tamper-${verifier}`));
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("SHA-256 mismatch");
    });

    it("refuses a release with no signature at all", () => {
      publish("1.5.0", { noSig: true });
      const res = runInstaller([], env, path.join(work, `home-nosig-${verifier}`));
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("treated as tampering");
    });
  });
});
