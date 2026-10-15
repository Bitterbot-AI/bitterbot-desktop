/**
 * scripts/install.sh (PLAN-56 Phase 3a) against fake releases on disk (and a
 * fake GitHub releases API listing): every verification tier, choosing the
 * newest COMPLETE release, upgrade-in-place with the previous version kept,
 * in-use versions never pruned, and every refusal (tampering, replayed or
 * foreign signatures, test-only overrides outside test mode, loopback-guard
 * bypasses, redirects, musl / old glibc, root). The real tarball is exercised end to end by
 * the `installer` job in .github/workflows/ci.yml.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_MINISIGN_PUBKEY,
  verifyMinisign,
} from "../../scripts/orchestrator-signature.mjs";
import { buildManifest } from "../../scripts/release-tarball-lib.mjs";
import {
  makeTestMinisignKey,
  signTestMinisign,
  type TestMinisignKey,
} from "../test-utils/minisign.js";
import { tarballPlatformId } from "./install-kind.js";

const INSTALL_SH = fileURLToPath(new URL("../../scripts/install.sh", import.meta.url));
const platformId = tarballPlatformId();

type TestKey = TestMinisignKey;
const makeKey = makeTestMinisignKey;
const minisign = signTestMinisign;

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

type Override = { draft?: boolean; prerelease?: boolean; omit?: string[] };

const describeInstaller = process.platform !== "win32" && platformId ? describe : describe.skip;

describeInstaller("scripts/install.sh", () => {
  let work: string;
  let key: TestKey;
  let releases: string;
  let homeCounter = 0;
  const overrides = new Map<string, Override>();

  /** A fresh, empty fake GitHub release store for one test. */
  function freshReleases(): string {
    releases = fs.mkdtempSync(path.join(work, "releases-"));
    overrides.clear();
    writeApi();
    return releases;
  }

  function freshHome(): string {
    homeCounter += 1;
    return path.join(work, `home-${homeCounter}`);
  }

  /** releases/api/releases.json: the GitHub releases API listing of what is on disk. */
  function writeApi() {
    const dl = path.join(releases, "download");
    const tags = fs.existsSync(dl) ? fs.readdirSync(dl) : [];
    const listing = tags.map((tag) => {
      const o = overrides.get(tag) ?? {};
      const names = fs.readdirSync(path.join(dl, tag)).filter((n) => !(o.omit ?? []).includes(n));
      return {
        tag_name: tag,
        name: `Release ${tag}`,
        draft: o.draft ?? false,
        prerelease: o.prerelease ?? false,
        body: 'notes with a fake "tag_name": "v99.0.0" inside',
        assets: names.map((n) => ({
          name: n,
          browser_download_url: `https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/${tag}/${n}`,
        })),
      };
    });
    fs.mkdirSync(path.join(releases, "api"), { recursive: true });
    fs.writeFileSync(path.join(releases, "api", "releases.json"), JSON.stringify(listing, null, 2));
  }

  /** Build a fake signed release `version` under releases/download/v<version>. */
  function publish(
    version: string,
    opts: {
      tamper?: boolean;
      comment?: string;
      signer?: TestKey;
      noSig?: boolean;
      api?: Override;
      /** bin/bitterbot body (default: echo its arguments). */
      launcher?: string;
    } = {},
  ) {
    const top = `bitterbot-${version}-${platformId}`;
    const src = path.join(work, "src", `${path.basename(releases)}-${version}`);
    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(path.join(src, top, "bin"), { recursive: true });
    const launcher = Buffer.from(
      `#!/bin/sh\n${opts.launcher ?? `echo "fake bitterbot ${version} $*"`}\n`,
    );
    fs.writeFileSync(path.join(src, top, "bin", "bitterbot"), launcher, { mode: 0o755 });
    const manifest = buildManifest({
      version,
      platformId: platformId!,
      nodeVersion: "v22.0.0",
      orchestratorVersion: "0.2.3",
      commit: null,
      builtAt: "2026-10-11T00:00:00.000Z",
      files: [
        { path: "bin/bitterbot", sha256: sha256(launcher), size: launcher.length, mode: "755" },
      ],
    });
    fs.writeFileSync(
      path.join(src, top, "manifest.json"),
      `${JSON.stringify(manifest, null, 1)}\n`,
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
    if (opts.api) {
      overrides.set(`v${version}`, opts.api);
    }
    writeApi();
  }

  function baseEnv(home: string, env: Record<string, string | undefined>) {
    fs.mkdirSync(home, { recursive: true });
    return {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: work,
      BITTERBOT_INSTALL_TEST_MODE: "1",
      BITTERBOT_INSTALL_BASE_URL: pathToFileURL(releases).href,
      BITTERBOT_INSTALL_TEST_PUBKEY: key.pubkeyB64,
      ...env,
    } as NodeJS.ProcessEnv;
  }

  function runInstaller(
    args: string[],
    env: Record<string, string | undefined> = {},
    home = path.join(work, "home"),
    opts: { cwd?: string } = {},
  ) {
    const res = spawnSync("bash", [INSTALL_SH, "--yes", "--no-onboard", ...args], {
      encoding: "utf8",
      cwd: opts.cwd,
      env: baseEnv(home, env),
    });
    return { status: res.status, out: `${res.stdout}${res.stderr}`, home };
  }

  /** Async variant, for tests that serve HTTP from this process. */
  function runInstallerAsync(
    args: string[],
    env: Record<string, string | undefined>,
    home: string,
  ): Promise<{ status: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn("bash", [INSTALL_SH, "--yes", "--no-onboard", ...args], {
        env: baseEnv(home, env),
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (status) => resolve({ status, out }));
    });
  }

  async function withServer(
    handler: http.RequestListener,
    fn: (base: string, hits: string[]) => Promise<void>,
  ) {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      await fn(`http://127.0.0.1:${port}`, hits);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  /** A directory of fake commands to put first on PATH. */
  function fakeBin(scripts: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(work, "fakebin-"));
    for (const [name, body] of Object.entries(scripts)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    return dir;
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-install-sh-"));
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
    freshReleases();
    publish("1.4.0");
    const res = runInstaller([], { BITTERBOT_INSTALL_TEST_MODE: undefined }, freshHome());
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("test-only and need BITTERBOT_INSTALL_TEST_MODE=1");
    const keyOnly = runInstaller(
      [],
      { BITTERBOT_INSTALL_TEST_MODE: undefined, BITTERBOT_INSTALL_BASE_URL: undefined },
      freshHome(),
    );
    expect(keyOnly.status).not.toBe(0);
    expect(keyOnly.out).toContain("refusing");
  });

  it.each([
    ["https://example.com/releases", "loopback"],
    ["http://127.0.0.1:1@attacker.example/releases", "'@'"],
    ["http://localhost:8080.attacker.example/releases", "loopback"],
    ["http://127.0.0.1.attacker.example:80/releases", "loopback"],
  ])("even in test mode, refuses the base URL %s", (url, why) => {
    const res = runInstaller([], { BITTERBOT_INSTALL_BASE_URL: url }, freshHome());
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(why);
  });

  it("test mode never follows a redirect, even to another loopback server", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" }).end("never fetched");
      },
      async (target, targetHits) => {
        await withServer(
          (req, res) => {
            res.writeHead(302, { location: `${target}${req.url}` }).end();
          },
          async (redirector) => {
            const home = freshHome();
            const res = await runInstallerAsync(
              ["--version", "1.4.0"],
              { BITTERBOT_INSTALL_BASE_URL: redirector },
              home,
            );
            expect(res.status).not.toBe(0);
            expect(targetHits).toEqual([]);
            expect(fs.existsSync(path.join(home, ".bitterbot", "app"))).toBe(false);
          },
        );
      },
    );
  });

  it("explains a GitHub API rate limit instead of failing obscurely", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(403, { "content-type": "application/json" }).end('{"message":"rate limit"}');
      },
      async (base) => {
        const res = await runInstallerAsync([], { BITTERBOT_INSTALL_BASE_URL: base }, freshHome());
        expect(res.status).not.toBe(0);
        expect(res.out).toContain("60 per hour");
        expect(res.out).toContain("--version X.Y.Z");
      },
    );
  });

  it("picks the newest COMPLETE release: skips ones missing the tarball, the signature, or marked draft/prerelease", () => {
    freshReleases();
    publish("1.5.0");
    publish("1.6.0", { api: { omit: [`bitterbot-1.6.0-${platformId}.tar.gz`] } }); // tarball job still running
    publish("1.7.0", { api: { omit: ["checksums.txt.minisig"] } }); // signing not approved yet
    publish("1.8.0", { api: { prerelease: true } });
    publish("1.9.0", { api: { draft: true } });
    const res = runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "none" }, freshHome());
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("Newest complete release: 1.5.0");
    expect(fs.readlinkSync(path.join(res.home, ".bitterbot", "app", "current"))).toBe("1.5.0");
  });

  it("says when no release has a tarball for this platform yet", () => {
    freshReleases();
    const res = runInstaller([], {}, freshHome());
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("no published release carries a signed tarball");
  });

  it("SHA-256-only fallback says what it checked, and --require-signature refuses it", () => {
    freshReleases();
    publish("1.4.0");
    const res = runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "none" }, freshHome());
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("Checked against checksums.txt from the same server (no signature)");
    expect(res.out).not.toContain("Verified:");
    const strict = runInstaller(
      ["--require-signature"],
      { BITTERBOT_INSTALL_TEST_VERIFIER: "none" },
      freshHome(),
    );
    expect(strict.status).not.toBe(0);
  });

  it("skips the attestation check on a gh without `gh attestation` instead of refusing", () => {
    freshReleases();
    publish("1.4.0");
    // gh 2.45 (Ubuntu 24.04's package): logged in, but `gh attestation` is an unknown command.
    const bin = fs.mkdtempSync(path.join(work, "gh-"));
    const stub = (body: string) => {
      fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    const env = (extra: Record<string, string> = {}) => ({
      BITTERBOT_INSTALL_TEST_VERIFIER: "none",
      BITTERBOT_INSTALL_TEST_GH: "1",
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      ...extra,
    });
    stub(
      [
        'case "$1" in',
        "  auth) exit 0 ;;",
        '  --version) echo "gh version 2.45.0 (2025-07-18)"; exit 0 ;;',
        '  attestation) echo unknown command attestation >&2; exit 1 ;;',
        "esac",
        "exit 1",
      ].join("\n"),
    );
    const old = runInstaller([], env(), freshHome());
    expect(old.status, old.out).toBe(0);
    expect(old.out).toContain("gh 2.45.0 has no 'gh attestation'; skipping that extra check");
    expect(old.out).not.toContain("attestation verify FAILED");

    // A gh that has the command still runs it, and a failed verification still refuses.
    stub('case "$1" in auth) exit 0 ;; attestation) exit 0 ;; esac\nexit 1');
    const good = runInstaller([], env(), freshHome());
    expect(good.status, good.out).toBe(0);
    expect(good.out).toContain("GitHub build-provenance attestation (gh attestation verify)");

    stub(
      'case "$1" in auth) exit 0 ;; attestation) [ "$2" = verify ] && [ "$3" = --help ] && exit 0; exit 1 ;; esac\nexit 1',
    );
    const bad = runInstaller([], env(), freshHome());
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain("gh attestation verify FAILED");
  });

  it("validates --version as a whole string", () => {
    const res = runInstaller(["--version", "1.5.0\nrm -rf /"], {}, freshHome());
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("--version must look like 1.5.0");
  });

  it("refuses to run as root unless --allow-root", () => {
    freshReleases();
    publish("1.4.0");
    const bin = fakeBin({ id: 'if [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi' });
    const env = { PATH: `${bin}:${process.env.PATH}`, BITTERBOT_INSTALL_TEST_VERIFIER: "none" };
    const refused = runInstaller([], env, freshHome());
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("refusing to install as root");
    const allowed = runInstaller(["--allow-root"], env, freshHome());
    expect(allowed.status, allowed.out).toBe(0);
  });

  it("refuses musl Linux even though `ldd --version` exits non-zero there", () => {
    const bin = fakeBin({
      uname: 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac',
      ldd: 'echo "musl libc (x86_64)"; echo "Version 1.2.4"; exit 1',
      getconf: "exit 1",
    });
    const res = runInstaller([], { PATH: `${bin}:${process.env.PATH}` }, freshHome());
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("musl-based Linux");
  });

  it("refuses glibc older than 2.28 (the bundled Node 22 needs it)", () => {
    const bin = fakeBin({
      uname: 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac',
      ldd: 'echo "ldd (GNU libc) 2.17"',
      getconf: "exit 1",
    });
    const res = runInstaller([], { PATH: `${bin}:${process.env.PATH}` }, freshHome());
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("glibc 2.17 is too old");
  });

  it("makes a relative --dir absolute", () => {
    freshReleases();
    publish("1.4.0");
    const cwd = fs.mkdtempSync(path.join(work, "cwd-"));
    const res = runInstaller(
      ["--dir", "rel-app"],
      { BITTERBOT_INSTALL_TEST_VERIFIER: "none" },
      freshHome(),
      { cwd },
    );
    expect(res.status, res.out).toBe(0);
    const link = fs.readlinkSync(path.join(res.home, ".local", "bin", "bitterbot"));
    expect(path.isAbsolute(link)).toBe(true);
    expect(link).toBe(path.join(fs.realpathSync(cwd), "rel-app", "current", "bin", "bitterbot"));
  });

  it("announces and replaces a foreign ~/.local/bin/bitterbot link, and warns about an earlier one on PATH", () => {
    freshReleases();
    publish("1.4.0");
    const home = freshHome();
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.symlinkSync("/usr/bin/true", path.join(home, ".local", "bin", "bitterbot"));
    const shadow = fakeBin({ bitterbot: "echo other" });
    const res = runInstaller(
      [],
      { PATH: `${shadow}:${process.env.PATH}`, BITTERBOT_INSTALL_TEST_VERIFIER: "none" },
      home,
    );
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("(replaces the existing link to /usr/bin/true)");
    expect(res.out).toContain("another bitterbot comes first on your PATH");
    expect(fs.readlinkSync(path.join(home, ".local", "bin", "bitterbot"))).toContain(
      path.join(".bitterbot", "app", "current", "bin", "bitterbot"),
    );
  });

  /**
   * A launcher that answers `gateway switch` like the real CLI (exit codes in
   * src/cli/daemon-cli/switch.ts) and logs every call.
   */
  const SWITCH_LAUNCHER = [
    'echo "$*" >> "$HOME/calls.log"',
    'echo "${BITTERBOT_INSTALLER:-} ${BITTERBOT_HIDE_BANNER:-}" >> "$HOME/modes.log"',
    'case "$*" in',
    '  "gateway switch --check") if [ "${FAKE_CHECK_RC:-10}" = 0 ]; then printf "%s" "${FAKE_CHECK_OUT:-}"; else echo "Found Bitterbot 1.4.0 from ~/bitterbot-desktop (git clone) running on port 19001."; fi; exit "${FAKE_CHECK_RC:-10}" ;;',
    '  "gateway switch --yes --no-summary") echo "Done. Your settings and memory are unchanged."; exit "${FAKE_SWITCH_RC:-0}" ;;',
    "esac",
  ].join("\n");

  function calls(home: string): string {
    const file = path.join(home, "calls.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  describe("switching a running older Bitterbot", () => {
    const env = { BITTERBOT_INSTALL_TEST_VERIFIER: "none" };

    it("--yes: announced in the plan, checked after linking, switched", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const res = runInstaller([], env, home);
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(
        "Switch:    a running older Bitterbot (git clone or older release) is switched to the new version",
      );
      expect(res.out).toContain("Found Bitterbot 1.4.0 from ~/bitterbot-desktop (git clone)");
      expect(res.out).toContain("Done. Your settings and memory are unchanged.");
      expect(calls(home)).toBe("gateway switch --check\ngateway switch --yes --no-summary\n");
      // Config advice once (the check), quiet afterwards; no banners.
      expect(fs.readFileSync(path.join(home, "modes.log"), "utf8")).toBe("1 1\nquiet 1\n");
      // The summary is printed once, before the switch.
      expect(res.out.split("Found Bitterbot 1.4.0").length - 1).toBe(1);
      expect(res.out).not.toMatch(/\u2014/);
    });

    it("a fresh machine gets no extra output or questions", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const res = runInstaller([], { ...env, FAKE_CHECK_RC: "0" }, home);
      expect(res.status, res.out).toBe(0);
      expect(res.out).not.toContain("Found Bitterbot");
      expect(calls(home)).toBe("gateway switch --check\n");
    });

    it("nothing to switch: the one config line from the check is still shown, once", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const line =
        "2 settings in your config are deprecated (still accepted this release, removed next release). Tidy them with: bitterbot doctor --fix";
      const res = runInstaller([], { ...env, FAKE_CHECK_RC: "0", FAKE_CHECK_OUT: line }, home);
      expect(res.status, res.out).toBe(0);
      expect(res.out.split(line).length - 1).toBe(1);
      // A failing check still shows what it printed.
      const bad = runInstaller([], { ...env, FAKE_CHECK_RC: "1", FAKE_CHECK_OUT: "" }, freshHome());
      expect(bad.out).toContain("could not check for a running older Bitterbot (exit 1)");
      expect(bad.out).toContain("Found Bitterbot 1.4.0");
    });

    it("--no-switch never runs the switch", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const res = runInstaller(["--no-switch"], env, home);
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain("a running older Bitterbot is left alone (--no-switch)");
      expect(calls(home)).toBe("");
    });

    it("a port held by something else: reported, nothing stopped, next steps printed", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const res = runInstaller([], { ...env, FAKE_CHECK_RC: "2" }, home);
      expect(res.status, res.out).toBe(0);
      expect(calls(home)).toBe("gateway switch --check\n");
      expect(res.out).toContain("Next: once that is sorted out");
    });

    it("a remote gateway (check exit 0) goes straight on to onboarding", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const res = runInstaller([], { ...env, FAKE_CHECK_RC: "0" }, home);
      expect(res.status, res.out).toBe(0);
      expect(res.out).not.toContain("gateway switch");
      expect(res.out).toContain("onboard (opens a setup page");
    });

    it("another program on the port (exit 5): says so, never suggests a switch", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const res = runInstaller([], { ...env, FAKE_CHECK_RC: "5" }, home);
      expect(res.status, res.out).toBe(0);
      expect(calls(home)).toBe("gateway switch --check\n");
      expect(res.out).toContain("free the port (or set another one with gateway.port)");
      expect(res.out).not.toContain(
        "Next: " + path.join(home, ".local", "bin", "bitterbot") + " gateway switch",
      );
    });

    it("a failed switch leaves `previous` and older versions as they were", () => {
      freshReleases();
      publish("1.0.0");
      publish("1.1.0");
      publish("1.2.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const app = path.join(home, ".bitterbot", "app");
      expect(runInstaller(["--version", "1.0.0"], env, home).status).toBe(0);
      expect(runInstaller(["--version", "1.1.0"], env, home).status).toBe(0);
      expect(fs.readlinkSync(path.join(app, "previous"))).toBe("1.0.0");
      const res = runInstaller(["--version", "1.2.0"], { ...env, FAKE_SWITCH_RC: "1" }, home);
      expect(res.status, res.out).toBe(1);
      expect(fs.readlinkSync(path.join(app, "previous"))).toBe("1.0.0");
      expect(fs.existsSync(path.join(app, "1.0.0", "bin", "bitterbot"))).toBe(true);
      expect(res.out).not.toContain("Removing old version");
      // (the real switch's rollback points `current` back at the old version)
      fs.rmSync(path.join(app, "current"));
      fs.symlinkSync("1.1.0", path.join(app, "current"));
      // A successful switch then moves `previous` and prunes as before.
      const ok = runInstaller(["--version", "1.2.0"], env, home);
      expect(ok.status, ok.out).toBe(0);
      expect(fs.readlinkSync(path.join(app, "previous"))).toBe("1.1.0");
      expect(fs.existsSync(path.join(app, "1.0.0"))).toBe(false);
    });

    it("a switch that did not complete fails the run with a warning", () => {
      freshReleases();
      publish("2.0.0", { launcher: SWITCH_LAUNCHER });
      const home = freshHome();
      const res = runInstaller([], { ...env, FAKE_SWITCH_RC: "1" }, home);
      expect(res.status, res.out).toBe(1);
      expect(res.out).toContain("the switch to 2.0.0 did not complete (exit 1)");
    });
  });

  const hasScript = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;
  (hasScript ? it : it.skip)(
    "asks 'Proceed? [Y/n]' on the terminal: Enter installs, n aborts",
    () => {
      freshReleases();
      publish("2.0.0");
      const ask = (input: string) => {
        const home = freshHome();
        const res = spawnSync(
          "script",
          ["-qec", `bash ${INSTALL_SH} --no-onboard --no-switch`, "/dev/null"],
          {
            encoding: "utf8",
            input,
            env: baseEnv(home, { BITTERBOT_INSTALL_TEST_VERIFIER: "none" }),
          },
        );
        return { out: `${res.stdout}${res.stderr}`, home };
      };
      const enter = ask("\n");
      expect(enter.out).toContain("Proceed? [Y/n]");
      expect(fs.existsSync(path.join(enter.home, ".bitterbot", "app", "2.0.0"))).toBe(true);
      const no = ask("n\n");
      expect(no.out).toContain("aborted");
      expect(fs.existsSync(path.join(no.home, ".bitterbot", "app"))).toBe(false);
    },
  );

  it("makes the state dir private (only the directory, never its files)", () => {
    freshReleases();
    publish("2.0.0");
    const home = freshHome();
    const state = path.join(home, ".bitterbot");
    fs.mkdirSync(state, { recursive: true });
    fs.chmodSync(state, 0o755);
    fs.writeFileSync(path.join(state, "bitterbot.json"), "{}");
    fs.chmodSync(path.join(state, "bitterbot.json"), 0o644);
    const res = runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "none" }, home);
    expect(res.status, res.out).toBe(0);
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(state, "bitterbot.json")).mode & 0o777).toBe(0o644);
    // A fresh machine: created private.
    const fresh = freshHome();
    expect(runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "none" }, fresh).status).toBe(0);
    expect(fs.statSync(path.join(fresh, ".bitterbot")).mode & 0o777).toBe(0o700);
  });

  it("state dir policy: group sharing kept, $HOME and relative paths never touched, opt-out honoured", () => {
    freshReleases();
    publish("2.0.0");
    const env = { BITTERBOT_INSTALL_TEST_VERIFIER: "none" };
    // Deliberate group sharing (2770 setgid): kept.
    const shared = freshHome();
    const sharedState = path.join(shared, ".bitterbot");
    fs.mkdirSync(sharedState, { recursive: true });
    fs.chmodSync(sharedState, 0o2770);
    expect(runInstaller([], env, shared).status).toBe(0);
    expect(fs.statSync(sharedState).mode & 0o7777).toBe(0o2770);
    // 751: only the world bit goes.
    const world = freshHome();
    const worldState = path.join(world, ".bitterbot");
    fs.mkdirSync(worldState, { recursive: true });
    fs.chmodSync(worldState, 0o751);
    expect(runInstaller([], env, world).status).toBe(0);
    expect(fs.statSync(worldState).mode & 0o777).toBe(0o750);
    // BITTERBOT_STATE_DIR=~ (home itself): never chmod $HOME.
    const homeItself = freshHome();
    fs.mkdirSync(homeItself, { recursive: true });
    fs.chmodSync(homeItself, 0o755);
    expect(
      runInstaller(
        ["--dir", path.join(homeItself, "app")],
        { ...env, BITTERBOT_STATE_DIR: " ~ " },
        homeItself,
      ).status,
    ).toBe(0);
    expect(fs.statSync(homeItself).mode & 0o777).toBe(0o755);
    // A leading ~ expands like resolveStateDir.
    const tilde = freshHome();
    const tildeState = path.join(tilde, "bbstate");
    fs.mkdirSync(tildeState, { recursive: true });
    fs.chmodSync(tildeState, 0o755);
    expect(runInstaller([], { ...env, BITTERBOT_STATE_DIR: "~/bbstate" }, tilde).status).toBe(0);
    expect(fs.statSync(tildeState).mode & 0o777).toBe(0o700);
    // Opt-out.
    const keep = freshHome();
    const keepState = path.join(keep, ".bitterbot");
    fs.mkdirSync(keepState, { recursive: true });
    fs.chmodSync(keepState, 0o755);
    expect(runInstaller([], { ...env, BITTERBOT_STATE_DIR_PERMS: "keep" }, keep).status).toBe(0);
    expect(fs.statSync(keepState).mode & 0o777).toBe(0o755);
  });

  it("never prunes or replaces a version a running process uses", async () => {
    freshReleases();
    for (const v of ["1.5.0", "1.6.0", "1.7.0", "1.8.0"]) {
      publish(v);
    }
    const home = freshHome();
    const env = { BITTERBOT_INSTALL_TEST_VERIFIER: "none" };
    expect(runInstaller(["--version", "1.5.0"], env, home).status).toBe(0);
    const app = path.join(home, ".bitterbot", "app");
    // A "gateway" started from 1.5.0: the launcher's pid marker.
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      fs.mkdirSync(path.join(app, "1.5.0", ".pids"), { recursive: true });
      fs.writeFileSync(path.join(app, "1.5.0", ".pids", String(sleeper.pid)), "");
      expect(runInstaller(["--version", "1.6.0"], env, home).status).toBe(0);
      const third = runInstaller(["--version", "1.7.0"], env, home);
      expect(third.status, third.out).toBe(0);
      expect(third.out).toContain("Keeping old version 1.5.0: in use by pid");
      expect(fs.existsSync(path.join(app, "1.5.0", "bin", "bitterbot"))).toBe(true);
    } finally {
      sleeper.kill();
      await new Promise((r) => sleeper.once("exit", r));
    }
    // Once the process is gone, the next install prunes it (and its stale marker).
    const fourth = runInstaller(["--version", "1.8.0"], env, home);
    expect(fourth.status, fourth.out).toBe(0);
    expect(fs.existsSync(path.join(app, "1.5.0"))).toBe(false);
  });

  it("re-checks an identical same-version install file by file and repairs a modified one", () => {
    freshReleases();
    publish("1.4.0");
    const home = freshHome();
    const env = { BITTERBOT_INSTALL_TEST_VERIFIER: "none" };
    expect(runInstaller([], env, home).status).toBe(0);
    const app = path.join(home, ".bitterbot", "app");
    const intact = runInstaller([], env, home);
    expect(intact.out).toContain("already installed and intact; keeping it in place");
    fs.writeFileSync(path.join(app, "1.4.0", "bin", "bitterbot"), "#!/bin/sh\necho evil\n");
    const repaired = runInstaller([], env, home);
    expect(repaired.status, repaired.out).toBe(0);
    expect(repaired.out).toContain("repairing");
    expect(fs.readFileSync(path.join(app, "1.4.0", "bin", "bitterbot"), "utf8")).toContain(
      "fake bitterbot 1.4.0",
    );
  });

  it.runIf(opensslCanVerify())(
    "verifies with OpenSSL, installs, links, then upgrades keeping the previous version",
    () => {
      freshReleases();
      publish("1.4.0");
      const home = freshHome();
      const env = { BITTERBOT_INSTALL_TEST_VERIFIER: "openssl" };
      const first = runInstaller([], env, home);
      expect(first.status, first.out).toBe(0);
      expect(first.out).toContain("minisign signature checked with OpenSSL (pinned key)");
      const app = path.join(home, ".bitterbot", "app");
      expect(fs.readlinkSync(path.join(app, "current"))).toBe("1.4.0");
      const link = path.join(home, ".local", "bin", "bitterbot");
      expect(fs.readlinkSync(link)).toBe(
        path.join(fs.realpathSync(app), "current", "bin", "bitterbot"),
      );
      expect(execFileSync(link, ["--version"], { encoding: "utf8" })).toContain(
        "fake bitterbot 1.4.0",
      );

      publish("1.4.1");
      const second = runInstaller([], env, home);
      expect(second.status, second.out).toBe(0);
      expect(fs.readlinkSync(path.join(app, "current"))).toBe("1.4.1");
      expect(fs.readlinkSync(path.join(app, "previous"))).toBe("1.4.0");
      expect(fs.existsSync(path.join(app, "1.4.0", "bin", "bitterbot"))).toBe(true);
      expect(execFileSync(link, [], { encoding: "utf8" })).toContain("fake bitterbot 1.4.1");

      // Re-running the same build keeps its directory in place.
      const marker = path.join(app, "1.4.1", "still-here");
      fs.writeFileSync(marker, "");
      const again = runInstaller([], env, home);
      expect(again.status, again.out).toBe(0);
      expect(again.out).toContain("already installed and intact; keeping it in place");
      expect(fs.existsSync(marker)).toBe(true);
      expect(
        fs.readdirSync(app).some((n) => n.startsWith(".staging") || n.startsWith(".replaced")),
      ).toBe(false);
      expect(fs.existsSync(path.join(app, "1.4.0"))).toBe(true);
    },
  );

  it.runIf(hasCommand("minisign"))("verifies with the minisign binary", () => {
    freshReleases();
    publish("1.4.2");
    const res = runInstaller([], { BITTERBOT_INSTALL_TEST_VERIFIER: "minisign" }, freshHome());
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("Verified: minisign signature (pinned key)");
  });

  describe.each(
    [opensslCanVerify() ? "openssl" : null, hasCommand("minisign") ? "minisign" : null].filter(
      (v): v is string => v !== null,
    ),
  )("refusals with the %s verifier", (verifier) => {
    const env = { BITTERBOT_INSTALL_TEST_VERIFIER: verifier };
    const pinned = ["--version", "1.5.0"];

    it("refuses a signature from another key", () => {
      freshReleases();
      publish("1.5.0", { signer: makeKey() });
      const home = freshHome();
      const res = runInstaller(pinned, env, home);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("INVALID");
      expect(fs.existsSync(path.join(home, ".bitterbot", "app", "1.5.0"))).toBe(false);
    });

    it("refuses a signature replayed from another release", () => {
      freshReleases();
      publish("1.5.0", { comment: "v1.4.0 checksums" });
      const res = runInstaller(pinned, env, freshHome());
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("replayed");
    });

    it("refuses an orchestrator release signature (same key, other trusted comment)", () => {
      freshReleases();
      publish("1.5.0", { comment: "orchestrator-v0.2.3 checksums" });
      const res = runInstaller(pinned, env, freshHome());
      expect(res.status).not.toBe(0);
    });

    it("refuses a tarball whose SHA-256 does not match the signed checksums", () => {
      freshReleases();
      publish("1.5.0", { tamper: true });
      const res = runInstaller(pinned, env, freshHome());
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("SHA-256 mismatch");
    });

    it("refuses a pinned release with no signature at all", () => {
      freshReleases();
      publish("1.5.0", { noSig: true });
      const res = runInstaller(pinned, env, freshHome());
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("treated as tampering");
    });
  });
});
