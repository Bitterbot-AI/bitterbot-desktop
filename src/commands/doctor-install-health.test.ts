import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkInstallKindAndChannel,
  checkLocalGguf,
  checkOrchestrator,
  checkPlaywright,
  checkVersionDrift,
  collectInstallHealth,
  type InstallHealthInput,
  LOCAL_GGUF_FILE,
} from "./doctor-install-health.js";

let dir: string;

beforeEach(() => {
  // Realpath: macOS os.tmpdir() is a symlink (/var -> /private/var).
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-install-health-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<InstallHealthInput> = {}): InstallHealthInput {
  return {
    cfg: {},
    installKind: "package",
    packageRoot: null,
    runningVersion: "1.5.0",
    homedir: dir,
    resolvePlaywright: () => "/pkg/node_modules/playwright-core",
    findBrowser: () => ({ kind: "chrome", path: "/usr/bin/google-chrome" }),
    probeOrchestrator: () => ({ found: false, candidates: [] }),
    ...overrides,
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("install kind and update channel", () => {
  it("states both", () => {
    expect(checkInstallKindAndChannel(input()).message).toBe(
      "Install kind: package; update channel: stable (default).",
    );
    expect(
      checkInstallKindAndChannel(
        input({ installKind: "tarball", cfg: { update: { channel: "beta" } } }),
      ).message,
    ).toBe("Install kind: tarball; update channel: beta (config).");
  });
});

describe("version drift", () => {
  it("is ok when the running code matches the files on disk", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.5.0" }));
    expect(checkVersionDrift(input({ packageRoot: dir })).level).toBe("ok");
  });

  it("warns when the files on disk moved ahead of the running code", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.6.0" }));
    const result = checkVersionDrift(input({ packageRoot: dir, installKind: "git" }));
    expect(result.level).toBe("warn");
    expect(result.message).toContain("pnpm install && pnpm build");
  });

  it("warns when a newer Bitterbot wrote the config", () => {
    const result = checkVersionDrift(input({ cfg: { meta: { lastTouchedVersion: "2.0.0" } } }));
    expect(result.level).toBe("warn");
    expect(result.message).toContain("2.0.0");
  });
});

describe("orchestrator present and signature verified", () => {
  it("is not needed with P2P off", async () => {
    const [r] = await checkOrchestrator(input({ cfg: { p2p: { enabled: false } } }));
    expect(r?.level).toBe("info");
  });

  it("warns with install-kind advice when missing", async () => {
    const [r] = await checkOrchestrator(input());
    expect(r?.level).toBe("warn");
    expect(r?.message).toContain("NOT FOUND");
  });

  it("re-hashes a downloaded binary against its verification record", async () => {
    const bin = path.join(dir, "bitterbot-orchestrator");
    fs.writeFileSync(bin, "binary-v1");
    const probe = () => ({
      found: true as const,
      source: "prebuilt" as const,
      path: bin,
      candidates: [],
    });
    expect((await checkOrchestrator(input({ probeOrchestrator: probe })))[0]?.level).toBe("warn");

    fs.writeFileSync(
      `${bin}.verified.json`,
      JSON.stringify({ version: "0.2.3", sha256: sha("binary-v1"), signature: "minisign" }),
    );
    const [verified] = await checkOrchestrator(input({ probeOrchestrator: probe }));
    expect(verified?.level).toBe("ok");
    expect(verified?.message).toContain("signature verified (minisign, v0.2.3)");

    fs.writeFileSync(bin, "tampered");
    expect((await checkOrchestrator(input({ probeOrchestrator: probe })))[0]?.level).toBe("error");
  });

  it("checks a tarball's bundled binary against the signed manifest", async () => {
    const versionDir = path.join(dir, "app", "1.5.0");
    fs.mkdirSync(path.join(versionDir, "bin"), { recursive: true });
    const bin = path.join(versionDir, "bin", "bitterbot-orchestrator");
    fs.writeFileSync(bin, "bundled");
    fs.writeFileSync(
      path.join(versionDir, "manifest.json"),
      JSON.stringify({
        version: "1.5.0",
        platform: "linux-x64",
        files: [{ path: "bin/bitterbot-orchestrator", sha256: sha("bundled"), size: 7 }],
      }),
    );
    const probe = () => ({
      found: true as const,
      source: "bundled" as const,
      path: bin,
      candidates: [],
    });
    const [r] = await checkOrchestrator(
      input({ installKind: "tarball", packageRoot: versionDir, probeOrchestrator: probe }),
    );
    expect(r?.level).toBe("ok");
    expect(r?.message).toContain("signed release manifest");
  });

  it("matches the manifest when the probe path runs through a symlink (macOS tmpdir)", async () => {
    const versionDir = path.join(dir, "app", "1.5.0");
    fs.mkdirSync(path.join(versionDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(versionDir, "bin", "bitterbot-orchestrator"), "bundled");
    fs.writeFileSync(
      path.join(versionDir, "manifest.json"),
      JSON.stringify({
        version: "1.5.0",
        platform: "linux-x64",
        files: [{ path: "bin/bitterbot-orchestrator", sha256: sha("bundled"), size: 7 }],
      }),
    );
    // The probe reports the binary through a symlinked parent, the layout
    // resolves to the real path: they must still line up.
    const link = path.join(dir, "linked-home");
    fs.symlinkSync(dir, link, "dir");
    const viaLink = path.join(link, "app", "1.5.0", "bin", "bitterbot-orchestrator");
    const probe = () => ({
      found: true as const,
      source: "bundled" as const,
      path: viaLink,
      candidates: [],
    });
    const [r] = await checkOrchestrator(
      input({
        installKind: "tarball",
        packageRoot: path.join(link, "app", "1.5.0"),
        probeOrchestrator: probe,
      }),
    );
    expect(r?.level).toBe("ok");
  });

  it("trusts the image build in a container", async () => {
    const probe = () => ({
      found: true as const,
      source: "release" as const,
      path: "/app/orchestrator/target/release/bitterbot-orchestrator",
      candidates: [],
    });
    const [r] = await checkOrchestrator(
      input({ installKind: "container", probeOrchestrator: probe }),
    );
    expect(r?.message).toContain("when the image was built");
  });
});

describe("Playwright", () => {
  it("is ok with Playwright and a browser", async () => {
    expect((await checkPlaywright(input())).level).toBe("ok");
  });
  it("warns without playwright-core or without a browser", async () => {
    expect((await checkPlaywright(input({ resolvePlaywright: () => null }))).level).toBe("warn");
    expect((await checkPlaywright(input({ findBrowser: () => null }))).message).toContain(
      "playwright install chromium",
    );
  });
  it("is info when the browser tool is off", async () => {
    expect((await checkPlaywright(input({ cfg: { browser: { enabled: false } } }))).level).toBe(
      "info",
    );
  });
});

describe("local GGUF", () => {
  it("finds the downloaded model in the node-llama-cpp cache", () => {
    const models = path.join(dir, ".node-llama-cpp", "models");
    fs.mkdirSync(models, { recursive: true });
    fs.writeFileSync(path.join(models, `hf_ggml-org_${LOCAL_GGUF_FILE}`), Buffer.alloc(2048));
    const r = checkLocalGguf(input());
    expect(r.level).toBe("ok");
    expect(r.message).toContain("present");
  });
  it("says it downloads on first use, or is not needed with remote embeddings", () => {
    expect(checkLocalGguf(input()).message).toContain("330 MB");
    expect(
      checkLocalGguf(
        input({ cfg: { agents: { defaults: { memorySearch: { provider: "openai" } } } } }),
      ).message,
    ).toContain("not needed");
  });
  it("warns when it is missing and auto-download is off", () => {
    const cfg = { agents: { defaults: { memorySearch: { local: { autoDownload: false } } } } };
    expect(checkLocalGguf(input({ cfg })).level).toBe("warn");
  });
});

describe("collectInstallHealth", () => {
  it("returns one result per check, offline", async () => {
    const results = await collectInstallHealth(input());
    expect(results).toHaveLength(5);
  });
});
