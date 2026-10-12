/**
 * The release-tarball updater (PLAN-56 Phase 3b) against fake signed
 * releases on disk: verify -> download -> unpack -> manifest -> new launcher
 * check -> snapshot -> activate -> prune, every refusal leaving `current`
 * untouched, and the rollback data policy. HOME, the state dir and the app
 * dir are temp directories; no real key or config is read.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  publishFakeRelease,
  writeReleasesApi,
  writeVersionDir,
} from "../test-utils/fake-tarball-release.js";
import { makeTestMinisignKey, type TestMinisignKey } from "../test-utils/minisign.js";
import { tarballPlatformId } from "./install-kind.js";
import { readVersionLink, swapVersionLink, versionInUse } from "./tarball-install.js";
import {
  fetchVerifiedChecksums,
  resolveLatestTarballVersion,
  resolveReleaseSource,
  type ReleaseSource,
} from "./tarball-release.js";
import {
  parsePreflightOutput,
  rollbackTarballInstall,
  runTarballUpdate,
} from "./tarball-updater.js";
import { listSnapshots, readSnapshotManifest, type SnapshotSources } from "./update-snapshot.js";

const platformId = tarballPlatformId();
const describeUpdater = process.platform !== "win32" && platformId ? describe : describe.skip;

function makeDb(file: string, schemaVersion: number, rows = 3): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, text TEXT)");
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(schemaVersion));
  for (let i = 0; i < rows; i += 1) {
    db.prepare("INSERT INTO chunks (text) VALUES (?)").run(`memory ${i}`);
  }
  db.close();
}

function countRows(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describeUpdater("runTarballUpdate", () => {
  let work: string;
  let key: TestMinisignKey;
  let releases: string;
  let appDir: string;
  let stateDir: string;
  let sources: SnapshotSources;
  let source: ReleaseSource;

  beforeAll(() => {
    key = makeTestMinisignKey();
  });

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tarball-update-"));
    releases = path.join(work, "releases");
    fs.mkdirSync(releases);
    writeReleasesApi(releases);
    const home = path.join(work, "home");
    appDir = path.join(home, ".bitterbot", "app");
    stateDir = path.join(home, ".bitterbot");
    writeVersionDir(path.join(appDir, "1.4.0"), "1.4.0", platformId!);
    swapVersionLink(appDir, "current", "1.4.0");
    fs.writeFileSync(path.join(stateDir, "bitterbot.json"), '{"gateway":{"mode":"local"}}\n');
    fs.writeFileSync(path.join(stateDir, ".env"), "X=1\n");
    makeDb(path.join(stateDir, "memory", "main.sqlite"), 70);
    fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "workspace", "GENOME.md"), "# genome\n");
    fs.writeFileSync(path.join(stateDir, "workspace", "MEMORY.md"), "# memory\n");
    fs.mkdirSync(path.join(stateDir, "keys"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "keys", "node.key"), "SECRET-TEST-KEY", { mode: 0o600 });
    sources = {
      stateDir,
      configPath: path.join(stateDir, "bitterbot.json"),
      workspaceDir: path.join(stateDir, "workspace"),
      keyDir: path.join(stateDir, "keys"),
    };
    source = resolveReleaseSource({
      allowTestMode: true,
      env: {
        BITTERBOT_INSTALL_TEST_MODE: "1",
        BITTERBOT_INSTALL_BASE_URL: pathToFileURL(releases).href,
        BITTERBOT_INSTALL_TEST_PUBKEY: key.pubkeyB64,
      },
    });
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function publish(version: string, opts = {}) {
    publishFakeRelease({ releases, work, version, platformId: platformId!, key, opts });
  }

  function update(target: string, extra: Partial<Parameters<typeof runTarballUpdate>[0]> = {}) {
    return runTarballUpdate({
      appDir,
      platformId: platformId!,
      fromVersion: readVersionLink(appDir, "current") ?? "1.4.0",
      targetVersion: target,
      source,
      snapshot: sources,
      fromMemorySchemaLatest: 70,
      procRoot: null,
      ...extra,
    });
  }

  it("resolves the newest COMPLETE release (same rule as install.sh)", async () => {
    publish("1.5.0");
    publish("1.6.0", { noSig: true });
    expect(await resolveLatestTarballVersion(source, platformId!, 5000)).toBe("1.5.0");
  });

  it("verifies, snapshots, activates and keeps the old version as previous", async () => {
    publish("1.5.0");
    const res = await update("1.5.0");
    expect(readVersionLink(appDir, "current")).toBe("1.5.0");
    expect(readVersionLink(appDir, "previous")).toBe("1.4.0");
    expect(fs.existsSync(path.join(appDir, "1.4.0", "bin", "bitterbot"))).toBe(true);
    expect(res.reused).toBe(false);
    expect(res.steps.map((s) => s.name)).toEqual([
      "verify signature",
      "download",
      "unpack",
      "verify files",
      "validate",
      "snapshot",
      "install",
      "activate",
    ]);
    expect(res.preflight.warnings.length).toBeGreaterThan(0);
    // Snapshot: manifest, a consistent DB copy, config, workspace files, keys COPIED.
    const manifest = readSnapshotManifest(res.snapshotDir)!;
    expect(manifest).toMatchObject({ from: "1.4.0", to: "1.5.0", fromMemorySchemaLatest: 70 });
    const kinds = manifest.entries.map((e) => `${e.kind}:${path.basename(e.file)}`).toSorted();
    expect(kinds).toEqual([
      "config:.env",
      "config:bitterbot.json",
      "database:main.sqlite",
      "key:node.key",
      "workspace:GENOME.md",
      "workspace:MEMORY.md",
    ]);
    expect(manifest.entries.find((e) => e.kind === "database")?.schemaVersion).toBe(70);
    expect(countRows(path.join(res.snapshotDir, "memory", "main.sqlite"))).toBe(3);
    expect(fs.readFileSync(path.join(stateDir, "keys", "node.key"), "utf8")).toBe(
      "SECRET-TEST-KEY",
    );
    expect(fs.readFileSync(path.join(res.snapshotDir, "keys", "node.key"), "utf8")).toBe(
      "SECRET-TEST-KEY",
    );
    expect(fs.statSync(res.snapshotDir).mode & 0o777).toBe(0o700);
    // The app dir is never part of a snapshot.
    expect(manifest.entries.some((e) => e.source.startsWith(appDir))).toBe(false);
    // No staging leftovers, no lock.
    expect(fs.readdirSync(appDir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("keeps only the newest 3 snapshots and prunes versions that are not current/previous", async () => {
    for (const v of ["1.5.0", "1.6.0", "1.7.0", "1.8.0"]) {
      publish(v);
    }
    for (const v of ["1.5.0", "1.6.0", "1.7.0", "1.8.0"]) {
      await update(v);
    }
    expect(listSnapshots(stateDir).map((s) => s.manifest.to)).toEqual(["1.8.0", "1.7.0", "1.6.0"]);
    expect(
      fs
        .readdirSync(appDir)
        .filter((n) => /^\d/.test(n))
        .toSorted(),
    ).toEqual(["1.7.0", "1.8.0"]);
  });

  describe("never prunes a version in use", () => {
    let child: ChildProcess | null = null;
    afterEach(() => {
      child?.kill("SIGKILL");
      child = null;
    });
    it("a live .pids marker keeps an old version directory", async () => {
      child = spawn("sleep", ["30"]);
      writeVersionDir(path.join(appDir, "1.3.0"), "1.3.0", platformId!);
      fs.mkdirSync(path.join(appDir, "1.3.0", ".pids"));
      fs.writeFileSync(path.join(appDir, "1.3.0", ".pids", String(child.pid)), "");
      publish("1.5.0");
      const res = await update("1.5.0");
      expect(res.pruned.keptInUse).toEqual([{ version: "1.3.0", pid: child.pid }]);
      expect(fs.existsSync(path.join(appDir, "1.3.0"))).toBe(true);
      expect(versionInUse(path.join(appDir, "1.3.0"), { procRoot: null })).toBe(child.pid);
    });
  });

  it("never prunes the version directory the updating process runs from", async () => {
    writeVersionDir(path.join(appDir, "1.3.0"), "1.3.0", platformId!);
    publish("1.5.0");
    await update("1.5.0", { runningVersion: "1.3.0" });
    expect(fs.existsSync(path.join(appDir, "1.3.0", "bin", "bitterbot"))).toBe(true);
  });

  it("downloads over loopback http (the CI path) as well as file://", async () => {
    publish("1.5.0");
    const server = http.createServer((req, res) => {
      const file = path.join(releases, decodeURIComponent((req.url ?? "/").split("?")[0]!));
      if (!file.startsWith(releases) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const httpSource = resolveReleaseSource({
        allowTestMode: true,
        env: {
          BITTERBOT_INSTALL_TEST_MODE: "1",
          BITTERBOT_INSTALL_BASE_URL: `http://127.0.0.1:${port}`,
          BITTERBOT_INSTALL_TEST_PUBKEY: key.pubkeyB64,
        },
      });
      expect(await resolveLatestTarballVersion(httpSource, platformId!, 5000)).toBe("1.5.0");
      await update("1.5.0", { source: httpSource });
      expect(readVersionLink(appDir, "current")).toBe("1.5.0");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("re-uses an already installed, intact copy of the target", async () => {
    publish("1.5.0");
    await update("1.5.0");
    swapVersionLink(appDir, "current", "1.4.0");
    const res = await update("1.5.0");
    expect(res.reused).toBe(true);
    expect(readVersionLink(appDir, "current")).toBe("1.5.0");
  });

  const refusals: Array<[string, () => void, RegExp]> = [
    ["a tampered tarball", () => publish("1.5.0", { tamper: true }), /SHA-256 mismatch/],
    ["a missing signature", () => publish("1.5.0", { noSig: true }), /no checksums\.txt\.minisig/],
    [
      "a signature replayed from another release",
      () => publish("1.5.0", { comment: "v1.4.9 checksums" }),
      /replayed/,
    ],
    [
      "a signature from a foreign key",
      () => publish("1.5.0", { signer: makeTestMinisignKey() }),
      /signature check FAILED/,
    ],
    [
      "a file that does not match the manifest",
      () => publish("1.5.0", { corruptFile: true }),
      /does not match its manifest/,
    ],
    [
      "a launcher that prints another version",
      () => publish("1.5.0", { printVersion: "1.4.0" }),
      /expected 1\.5\.0/,
    ],
    [
      "a new version that refuses this machine's data",
      () => publish("1.5.0", { preflight: "block" }),
      /refuses this machine's data: config fails the schema/,
    ],
    [
      "a version too old to run the activation check",
      () => publish("1.5.0", { preflight: "missing" }),
      /cannot run the activation check/,
    ],
  ];
  for (const [name, arrange, message] of refusals) {
    it(`refuses ${name} and changes nothing`, async () => {
      arrange();
      await expect(update("1.5.0")).rejects.toThrow(message);
      expect(readVersionLink(appDir, "current")).toBe("1.4.0");
      expect(readVersionLink(appDir, "previous")).toBeNull();
      expect(fs.existsSync(path.join(appDir, "1.5.0"))).toBe(false);
      expect(fs.readdirSync(appDir).filter((n) => n.startsWith("."))).toEqual([]);
    });
  }

  it("refuses a release that does not exist", async () => {
    await expect(fetchVerifiedChecksums(source, "9.9.9", platformId!, 5000)).rejects.toThrow(
      /no checksums\.txt/,
    );
  });

  it("one update at a time: a live lock holder is refused", async () => {
    publish("1.5.0");
    const child = spawn("sleep", ["30"]);
    try {
      fs.writeFileSync(path.join(appDir, ".update.lock"), String(child.pid));
      await expect(update("1.5.0")).rejects.toThrow(/another update is already running/);
      // A stale lock (dead pid) is taken over.
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      await update("1.5.0");
      expect(readVersionLink(appDir, "current")).toBe("1.5.0");
    } finally {
      child.kill("SIGKILL");
    }
  });

  describe("rollback data policy", () => {
    it("manual rollback switches back, restores a changed config, keeps the databases", async () => {
      publish("1.5.0");
      const res = await update("1.5.0");
      // After the update: config rewritten and new memories written.
      fs.writeFileSync(sources.configPath, '{"gateway":{"mode":"local"},"newKey":true}\n');
      makeDb(path.join(stateDir, "memory", "main.sqlite"), 70, 2);
      const out = await rollbackTarballInstall({
        appDir,
        stateDir,
        fromVersion: "1.5.0",
        toVersion: "1.4.0",
        mode: "manual",
        targetMemorySchemaLatest: 70,
      });
      expect(readVersionLink(appDir, "current")).toBe("1.4.0");
      expect(readVersionLink(appDir, "previous")).toBe("1.5.0");
      expect(out.snapshotDir).toBe(res.snapshotDir);
      expect(out.restore?.restored).toEqual([sources.configPath]);
      expect(fs.readFileSync(sources.configPath, "utf8")).toBe('{"gateway":{"mode":"local"}}\n');
      // The post-update config is kept, never deleted.
      const displaced = fs.readdirSync(out.restore!.displacedDir!);
      expect(displaced).toContain("config-bitterbot.json");
      // Memories written after the update survive.
      expect(countRows(path.join(stateDir, "memory", "main.sqlite"))).toBe(5);
      expect(out.plan?.kept.some((k) => k.source.endsWith("main.sqlite"))).toBe(true);
      // Keys and workspace files are never restored automatically.
      expect(out.plan?.restore.some((r) => r.entry.kind === "key")).toBe(false);
    });

    it("manual rollback with --restore-data restores the databases too", async () => {
      publish("1.5.0");
      await update("1.5.0");
      makeDb(path.join(stateDir, "memory", "main.sqlite"), 70, 2);
      const out = await rollbackTarballInstall({
        appDir,
        stateDir,
        fromVersion: "1.5.0",
        toVersion: "1.4.0",
        mode: "manual",
        targetMemorySchemaLatest: 70,
        includeData: true,
      });
      expect(countRows(path.join(stateDir, "memory", "main.sqlite"))).toBe(3);
      expect(out.restore?.restored).toContain(path.join(stateDir, "memory", "main.sqlite"));
    });

    it("auto rollback restores a database the failed version migrated past what the old one knows", async () => {
      publish("1.5.0");
      await update("1.5.0");
      // The new version migrated main.sqlite to schema 80 and then failed to boot.
      makeDb(path.join(stateDir, "memory", "main.sqlite"), 80, 1);
      const out = await rollbackTarballInstall({
        appDir,
        stateDir,
        fromVersion: "1.5.0",
        toVersion: "1.4.0",
        mode: "auto",
        targetMemorySchemaLatest: 70,
      });
      expect(out.restore?.restored).toContain(path.join(stateDir, "memory", "main.sqlite"));
      expect(countRows(path.join(stateDir, "memory", "main.sqlite"))).toBe(3);
    });

    it("auto rollback keeps a database whose schema the old version still knows", async () => {
      publish("1.5.0");
      await update("1.5.0");
      makeDb(path.join(stateDir, "memory", "main.sqlite"), 70, 1);
      const out = await rollbackTarballInstall({
        appDir,
        stateDir,
        fromVersion: "1.5.0",
        toVersion: "1.4.0",
        mode: "auto",
        targetMemorySchemaLatest: 70,
      });
      expect(out.restore?.restored ?? []).not.toContain(
        path.join(stateDir, "memory", "main.sqlite"),
      );
      expect(countRows(path.join(stateDir, "memory", "main.sqlite"))).toBe(4);
    });

    it("refuses to roll back to a missing version", async () => {
      await expect(
        rollbackTarballInstall({
          appDir,
          stateDir,
          fromVersion: "1.4.0",
          toVersion: "1.3.0",
          mode: "manual",
          targetMemorySchemaLatest: 70,
        }),
      ).rejects.toThrow(/missing or incomplete/);
    });
  });
});

describe("resolveReleaseSource (test mode follows install.sh)", () => {
  const base = { BITTERBOT_INSTALL_BASE_URL: "http://127.0.0.1:8765" };
  it("production without overrides", () => {
    const s = resolveReleaseSource({ allowTestMode: true, env: {} });
    expect(s.testMode).toBe(false);
    expect(s.baseUrl).toBe("https://github.com/Bitterbot-AI/bitterbot-desktop/releases");
  });
  it("refuses overrides without BITTERBOT_INSTALL_TEST_MODE=1", () => {
    expect(() => resolveReleaseSource({ allowTestMode: true, env: base })).toThrow(
      /need BITTERBOT_INSTALL_TEST_MODE=1/,
    );
  });
  it("refuses a non-loopback URL, userinfo, and a key override without a loopback URL", () => {
    const tm = { BITTERBOT_INSTALL_TEST_MODE: "1" };
    for (const url of [
      "https://github.com/x",
      "http://example.com:80",
      "http://127.0.0.1.evil.com:80",
      "http://127.0.0.1@evil.com:80",
      "file://host/x",
    ]) {
      expect(() =>
        resolveReleaseSource({
          allowTestMode: true,
          env: { ...tm, BITTERBOT_INSTALL_BASE_URL: url },
        }),
      ).toThrow();
    }
    expect(() =>
      resolveReleaseSource({
        allowTestMode: true,
        env: { ...tm, BITTERBOT_INSTALL_TEST_PUBKEY: "RWQ=" },
      }),
    ).toThrow(/cannot be combined with GitHub Releases/);
  });
  it("the gateway path (allowTestMode false) ignores every override, even with TEST_MODE=1", () => {
    const warnings: string[] = [];
    const s = resolveReleaseSource({
      allowTestMode: false,
      env: {
        BITTERBOT_INSTALL_TEST_MODE: "1",
        BITTERBOT_INSTALL_BASE_URL: "http://127.0.0.1:8765",
        BITTERBOT_INSTALL_TEST_PUBKEY: "RWQ=",
      },
      warn: (m) => warnings.push(m),
    });
    expect(s.testMode).toBe(false);
    expect(s.pubkeyB64).not.toBe("RWQ=");
    expect(s.baseUrl).toMatch(/^https:\/\/github\.com\//);
    expect(warnings.join(" ")).toContain("ignored");
  });

  describe("loopback http", () => {
    let server: http.Server;
    let port = 0;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url?.includes("redirect")) {
          res.writeHead(302, { Location: "https://example.com/x" });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });
    it("refuses redirects in test mode", async () => {
      const s = resolveReleaseSource({
        allowTestMode: true,
        env: {
          BITTERBOT_INSTALL_TEST_MODE: "1",
          BITTERBOT_INSTALL_BASE_URL: `http://127.0.0.1:${port}/redirect`,
          BITTERBOT_INSTALL_TEST_PUBKEY: makeTestMinisignKey().pubkeyB64,
        },
      });
      await expect(fetchVerifiedChecksums(s, "1.5.0", "linux-x64", 5000)).rejects.toThrow();
    });
  });
});

describe("parsePreflightOutput", () => {
  it("finds the report among other output and ignores foreign JSON", () => {
    const line = JSON.stringify({
      kind: "bitterbot-update-preflight",
      version: "1.5.0",
      ok: true,
      blocking: [],
      warnings: [],
      memorySchemaLatest: 78,
    });
    expect(parsePreflightOutput(`banner\n${line}\n`)?.version).toBe("1.5.0");
    expect(
      parsePreflightOutput('{"kind":"other","version":"1","ok":true,"blocking":[]}'),
    ).toBeNull();
    expect(parsePreflightOutput("error: unknown command")).toBeNull();
  });
});
