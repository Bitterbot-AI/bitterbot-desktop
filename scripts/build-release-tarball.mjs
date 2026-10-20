#!/usr/bin/env node
/**
 * Build one release tarball for the HOST platform (PLAN-56 Phase 3a).
 *
 *   node scripts/build-release-tarball.mjs --version 1.5.0 --out release-out
 *
 * Prerequisite: `pnpm install --frozen-lockfile && pnpm build` in this
 * checkout (dist/ and dist/control-ui must exist). Run by
 * .github/workflows/release-tarball.yml (one runner per platform) and by the
 * CI installer smoke test. Not meant for a laptop: it downloads Node and the
 * orchestrator and installs the production dependency tree from scratch.
 *
 * Every input is verified before it is packed, and any failure exits
 * non-zero with nothing written to --out except partial staging:
 *   - Node runtime: official nodejs.org archive, SHA-256 against the
 *     release's SHASUMS256.txt (fetched over HTTPS from nodejs.org).
 *   - orchestrator: the signed `orchestrator-v<Cargo.toml version>` release;
 *     checksums.txt must carry a valid minisign signature from the PINNED key
 *     (scripts/orchestrator-signature.mjs, fail closed), then SHA-256.
 *   - native packages: each one is loaded by the bundled Node from the staged
 *     tree (sqlite-vec into node:sqlite, node-pty spawns, sharp encodes).
 *   - the launcher prints this exact version.
 *
 * Outputs in --out:
 *   bitterbot-<version>-<platform>.tar.gz
 *   bitterbot-<version>-<platform>.manifest.json  (same as manifest.json inside)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkChecksumsSignature, resolvePinnedMinisignPubkey } from "./orchestrator-signature.mjs";
import {
  buildManifest,
  INSTALL_KIND_MARKER,
  LAUNCHER_SCRIPT,
  nodeArchiveName,
  parseShasums,
  pickBundledNodeVersion,
  platformIdFor,
  RELEASE_PLATFORMS,
  tarballBaseName,
} from "./release-tarball-lib.mjs";

const REPO = "Bitterbot-AI/bitterbot-desktop";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const log = (msg) => console.log(`[release-tarball] ${msg}`);
function fail(msg) {
  console.error(`[release-tarball] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { version: null, out: "release-out", nodeVersion: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (!v) {
        fail(`${a} needs a value`);
      }
      i += 1;
      return v;
    };
    if (a === "--version") {
      args.version = next();
    } else if (a === "--out") {
      args.out = next();
    } else if (a === "--node-version") {
      args.nodeVersion = next();
    } else {
      fail(`unknown argument ${a}`);
    }
  }
  return args;
}

async function fetchOk(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url}: HTTP ${res.status}`);
  }
  return res;
}

async function fetchText(url) {
  return (await fetchOk(url)).text();
}

async function fetchBuffer(url) {
  return Buffer.from(await (await fetchOk(url)).arrayBuffer());
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    fail(`${cmd} exited with ${res.status ?? res.signal}`);
  }
}

/** The npm package file list: what `npm publish` would ship (package.json `files`). */
function npmPackFiles() {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(raw.slice(raw.indexOf("[")))[0];
  if (!report?.files?.length) {
    fail("npm pack --dry-run returned no files");
  }
  return report.files.map((f) => f.path).filter((p) => !p.split("/").includes("node_modules"));
}

function copyFilePreservingMode(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}

async function stageNodeRuntime(stage, platform, requested) {
  let nodeVersion = requested;
  if (!nodeVersion) {
    const index = JSON.parse(await fetchText("https://nodejs.org/dist/index.json"));
    nodeVersion = pickBundledNodeVersion(index, platform.nodeDist);
    if (!nodeVersion) {
      fail(`no Node 22 LTS build found for ${platform.nodeDist}`);
    }
  }
  if (!nodeVersion.startsWith("v")) {
    nodeVersion = `v${nodeVersion}`;
  }
  const archive = nodeArchiveName(nodeVersion, platform.nodeDist);
  const base = `https://nodejs.org/dist/${nodeVersion}`;
  const sums = await fetchText(`${base}/SHASUMS256.txt`);
  const expected = parseShasums(sums, archive);
  if (!expected) {
    fail(`SHASUMS256.txt for ${nodeVersion} has no entry for ${archive}`);
  }
  log(`downloading ${archive}`);
  const buf = await fetchBuffer(`${base}/${archive}`);
  const actual = sha256(buf);
  if (actual !== expected) {
    fail(`${archive} sha256 mismatch: expected ${expected}, got ${actual}`);
  }
  log(`${archive} sha256 verified against nodejs.org SHASUMS256.txt`);
  const tmp = path.join(path.dirname(stage), archive);
  fs.writeFileSync(tmp, buf);
  const dest = path.join(stage, "runtime", "node");
  fs.mkdirSync(dest, { recursive: true });
  run("tar", ["-xzf", tmp, "-C", dest, "--strip-components=1"]);
  fs.rmSync(tmp);
  // Headers and man pages are for building addons, not running them.
  for (const extra of ["include", "share"]) {
    fs.rmSync(path.join(dest, extra), { recursive: true, force: true });
  }
  return nodeVersion;
}

function readOrchestratorVersion() {
  const cargo = fs.readFileSync(path.join(ROOT, "orchestrator", "Cargo.toml"), "utf8");
  const match = cargo.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    fail("could not read the orchestrator version from orchestrator/Cargo.toml");
  }
  return match[1];
}

async function stageOrchestrator(stage, platform) {
  const version = readOrchestratorVersion();
  const base = `https://github.com/${REPO}/releases/download/orchestrator-v${version}`;
  const checksumsBody = await fetchText(`${base}/checksums.txt`);
  const signature = await checkChecksumsSignature({
    pubkeyB64: resolvePinnedMinisignPubkey(process.env, (m) => log(m)),
    version,
    checksumsBody,
    fetchMinisig: () => fetchText(`${base}/checksums.txt.minisig`),
    log,
    warn: (m) => log(m),
  });
  // Release builds require a VERIFIED signature, not merely "ok": an
  // unpinned key would downgrade to SHA-256 only, which a release must not.
  if (!signature.ok || !signature.verified) {
    fail(
      `orchestrator-v${version} checksums signature not verified (${signature.reason ?? "no pinned key"})`,
    );
  }
  const expected = parseShasums(checksumsBody, platform.orchestratorAsset);
  if (!expected) {
    fail(`orchestrator-v${version} checksums.txt has no entry for ${platform.orchestratorAsset}`);
  }
  const buf = await fetchBuffer(`${base}/${platform.orchestratorAsset}`);
  const actual = sha256(buf);
  if (actual !== expected) {
    fail(`${platform.orchestratorAsset} sha256 mismatch: expected ${expected}, got ${actual}`);
  }
  const dest = path.join(stage, "bin", "bitterbot-orchestrator");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf, { mode: 0o755 });
  fs.chmodSync(dest, 0o755);
  log(`orchestrator v${version} (${platform.orchestratorAsset}) signature + sha256 verified`);
  return version;
}

function installProductionDeps(stage) {
  // The workspace lockfile needs its workspace manifests to stay frozen; the
  // desktop app is excluded from the install by filter and removed after.
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "desktop/package.json"]) {
    copyFilePreservingMode(path.join(ROOT, file), path.join(stage, file));
  }
  // Root lifecycle scripts (preinstall check, orchestrator fetch): the npm
  // file list already carries them for `npm install -g`; copied again here
  // so this step never depends on that. The tarball bundles its own verified
  // orchestrator, so both hooks are skipped by env and removed after.
  for (const file of [
    "scripts/preinstall-check.mjs",
    "scripts/fetch-orchestrator.mjs",
    "scripts/orchestrator-signature.mjs",
  ]) {
    copyFilePreservingMode(path.join(ROOT, file), path.join(stage, file));
  }
  run(
    "pnpm",
    [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--config.confirmModulesPurge=false",
      "--filter",
      "!bitterbot-control-ui",
    ],
    {
      cwd: stage,
      env: {
        ...process.env,
        CI: "1",
        BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD: "1",
        BITTERBOT_SKIP_PREINSTALL_CHECK: "1",
      },
    },
  );
  for (const extra of ["desktop", "scripts", "pnpm-workspace.yaml", ".npmrc"]) {
    fs.rmSync(path.join(stage, extra), { recursive: true, force: true });
  }
  // pnpm bookkeeping with absolute CI paths and timestamps; Node never reads it.
  for (const name of fs.readdirSync(path.join(stage, "node_modules"))) {
    if (name === ".modules.yaml" || name.startsWith(".pnpm-workspace-state")) {
      fs.rmSync(path.join(stage, "node_modules", name), { force: true });
    }
  }
}

/** Size in bytes of a directory tree (symlinks not followed). */
function treeSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const dirent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, dirent.name);
      if (dirent.isDirectory()) {
        walk(abs);
      } else if (dirent.isFile()) {
        total += fs.statSync(abs).size;
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * Drop what the runtime never reads, then log the biggest packages so the
 * release log shows where the size goes:
 *   - GPU builds of llama.cpp (`@node-llama-cpp/*-cuda*`, `*-vulkan*`, about
 *     650 MB on linux-x64). node-llama-cpp falls back to its CPU build, which
 *     is what the small local embedding model needs (see LIMITATIONS.md).
 *   - type declarations and source maps inside node_modules.
 */
function pruneForRelease(stage) {
  const virtualStore = path.join(stage, "node_modules", ".pnpm");
  const before = treeSize(path.join(stage, "node_modules"));
  for (const name of fs.readdirSync(virtualStore)) {
    if (/^@node-llama-cpp\+.*-(cuda|vulkan)/.test(name)) {
      fs.rmSync(path.join(virtualStore, name), { recursive: true, force: true });
      log(`pruned GPU build ${name}`);
    }
  }
  const prunable = /\.(d\.ts|d\.mts|d\.cts|map)$/;
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) {
        // Links to pruned GPU packages would dangle: remove them too.
        if (!fs.existsSync(abs)) {
          fs.rmSync(abs);
        }
      } else if (dirent.isDirectory()) {
        walk(abs);
      } else if (dirent.isFile() && prunable.test(dirent.name)) {
        fs.rmSync(abs);
      }
    }
  };
  walk(path.join(stage, "node_modules"));
  for (const ext of fs.readdirSync(path.join(stage, "extensions"))) {
    const nm = path.join(stage, "extensions", ext, "node_modules");
    if (fs.existsSync(nm)) {
      walk(nm);
    }
  }
  const after = treeSize(path.join(stage, "node_modules"));
  const mib = (n) => `${(n / 1024 / 1024).toFixed(0)} MiB`;
  log(`node_modules ${mib(before)} -> ${mib(after)} after pruning`);
  const sizes = fs
    .readdirSync(virtualStore, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, size: treeSize(path.join(virtualStore, d.name)) }))
    .toSorted((a, b) => b.size - a.size)
    .slice(0, 25);
  log(
    `largest packages:\n${sizes.map((e) => `  ${mib(e.size).padStart(8)}  ${e.name}`).join("\n")}`,
  );
}

/**
 * Load every native package with the BUNDLED Node from the staged tree. A
 * missing platform prebuild or an ABI mismatch fails the release here, not
 * on a user's first boot.
 */
function verifyNativePackages(stage) {
  const node = path.join(stage, "runtime", "node", "bin", "node");
  const script = `
    import { createRequire } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    const require = createRequire(${JSON.stringify(path.join(stage, "package.json"))});
    const results = [];
    const sqliteVec = require("sqlite-vec");
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    db.loadExtension(sqliteVec.getLoadablePath());
    results.push("sqlite-vec " + db.prepare("select vec_version() as v").get().v);
    db.close();
    const pty = require("@lydell/node-pty");
    const out = await new Promise((resolve, reject) => {
      const p = pty.spawn("/bin/sh", ["-c", "echo pty-ok"], { cols: 80, rows: 24 });
      let buf = "";
      p.onData((d) => { buf += d; });
      p.onExit(() => resolve(buf));
      setTimeout(() => reject(new Error("node-pty timed out")), 10000);
    });
    if (!out.includes("pty-ok")) throw new Error("node-pty output: " + JSON.stringify(out));
    results.push("@lydell/node-pty ok");
    const sharp = require("sharp");
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const meta = await sharp(png).metadata();
    if (meta.width !== 2) throw new Error("sharp metadata: " + JSON.stringify(meta));
    results.push("sharp " + sharp.versions.vips);
    require.resolve("playwright-core");
    results.push("playwright-core resolves");
    console.log(results.join("\\n"));
  `;
  const res = spawnSync(node, ["--input-type=module", "-e", script], {
    cwd: stage,
    encoding: "utf8",
  });
  process.stdout.write(res.stdout ?? "");
  process.stderr.write(res.stderr ?? "");
  if (res.status !== 0) {
    fail("native package check failed with the bundled Node");
  }
}

function verifyLauncher(stage, version) {
  const res = spawnSync(path.join(stage, "bin", "bitterbot"), ["--version"], {
    encoding: "utf8",
    env: { ...process.env, BITTERBOT_NO_RESPAWN: "1" },
  });
  const out = (res.stdout ?? "").trim();
  if (res.status !== 0 || !out.split(/\s+/).includes(version)) {
    process.stderr.write(res.stderr ?? "");
    fail(`bin/bitterbot --version printed "${out}", expected ${version}`);
  }
  log(`bin/bitterbot --version -> ${out}`);
}

/** Every file and symlink under `stage`, for the manifest; refuses links that escape. */
function collectManifestEntries(stage) {
  const entries = [];
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, dirent.name);
      const rel = path.relative(stage, abs).split(path.sep).join("/");
      if (dirent.isSymbolicLink()) {
        const link = fs.readlinkSync(abs);
        if (path.isAbsolute(link)) {
          fail(`absolute symlink in the tarball: ${rel} -> ${link}`);
        }
        const target = path.resolve(path.dirname(abs), link);
        if (path.relative(stage, target).startsWith("..")) {
          fail(`symlink escapes the tarball: ${rel} -> ${link}`);
        }
        entries.push({ path: rel, link });
      } else if (dirent.isDirectory()) {
        walk(abs);
      } else if (dirent.isFile()) {
        const st = fs.statSync(abs);
        entries.push({
          path: rel,
          sha256: sha256(fs.readFileSync(abs)),
          size: st.size,
          mode: (st.mode & 0o777).toString(8),
        });
      }
    }
  };
  walk(stage);
  return entries;
}

function resolveCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? null;
  }
}

/**
 * SOURCE_DATE_EPOCH (set by the release workflow from the tag's commit), else
 * the HEAD commit time, else now. Used for builtAt and every mtime, so a
 * rebuild of the same tag produces the same manifest and, where the
 * dependency tree is byte-identical, the same tarball.
 */
function resolveSourceDateEpoch() {
  const fromEnv = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  try {
    return Number(
      execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: ROOT, encoding: "utf8" }).trim(),
    );
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

function normalizeMtimes(dir, epoch) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      normalizeMtimes(abs, epoch);
    }
    fs.lutimesSync(abs, epoch, epoch);
  }
  fs.lutimesSync(dir, epoch, epoch);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const epoch = resolveSourceDateEpoch();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = args.version ?? pkg.version;
  if (version !== pkg.version) {
    fail(`--version ${version} does not match package.json ${pkg.version}`);
  }
  const platformId = platformIdFor(process.platform, process.arch);
  if (!platformId) {
    fail(`no release tarball is defined for ${process.platform}-${process.arch}`);
  }
  const platform = RELEASE_PLATFORMS[platformId];
  for (const required of ["dist/entry.js", "dist/control-ui/index.html"]) {
    if (!fs.existsSync(path.join(ROOT, required))) {
      fail(`${required} is missing: run pnpm build first`);
    }
  }

  const baseName = tarballBaseName(version, platformId);
  const out = path.resolve(args.out);
  const stagingRoot = path.join(out, "staging");
  const stage = path.join(stagingRoot, baseName);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  log(`staging ${baseName} in ${stage}`);

  const files = npmPackFiles();
  for (const rel of files) {
    copyFilePreservingMode(path.join(ROOT, rel), path.join(stage, rel));
  }
  log(`copied ${files.length} package files (npm pack list)`);

  installProductionDeps(stage);
  pruneForRelease(stage);
  const nodeVersion = await stageNodeRuntime(stage, platform, args.nodeVersion);
  const orchestratorVersion = await stageOrchestrator(stage, platform);

  fs.writeFileSync(path.join(stage, "bin", "bitterbot"), LAUNCHER_SCRIPT, { mode: 0o755 });
  fs.chmodSync(path.join(stage, "bin", "bitterbot"), 0o755);
  fs.writeFileSync(path.join(stage, INSTALL_KIND_MARKER), "tarball\n");

  verifyNativePackages(stage);
  verifyLauncher(stage, version);

  const manifest = buildManifest({
    version,
    platformId,
    nodeVersion,
    orchestratorVersion,
    commit: resolveCommit(),
    builtAt: new Date(epoch * 1000).toISOString(),
    files: collectManifestEntries(stage),
  });
  const manifestText = `${JSON.stringify(manifest, null, 1)}\n`;
  fs.writeFileSync(path.join(stage, "manifest.json"), manifestText);
  fs.writeFileSync(path.join(out, `${baseName}.manifest.json`), manifestText);
  log(
    `manifest: ${manifest.files.length} entries, node ${nodeVersion}, orchestrator ${orchestratorVersion}`,
  );

  const tarball = path.join(out, `${baseName}.tar.gz`);
  fs.rmSync(tarball, { force: true });
  // Reproducible where cheap: every mtime is SOURCE_DATE_EPOCH, entries are
  // sorted and owned by 0:0 (GNU tar; macOS uses gtar when the runner has
  // it), and gzip stores no name or timestamp.
  normalizeMtimes(stagingRoot, epoch);
  const tarCmd = ["gtar", "tar"].find((cmd) =>
    spawnSync(cmd, ["--version"], { encoding: "utf8" }).stdout?.includes("GNU tar"),
  );
  const tarArgs = tarCmd
    ? [
        "--sort=name",
        `--mtime=@${epoch}`,
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
      ]
    : ["--uid", "0", "--gid", "0"];
  const tarBin = tarCmd ?? "tar";
  const quoted = (a) => `'${String(a).replaceAll("'", "'\\''")}'`;
  run("bash", [
    "-c",
    `set -o pipefail; ${tarBin} -cf - ${tarArgs.map(quoted).join(" ")} -C ${quoted(stagingRoot)} ${quoted(baseName)} | gzip -n -6 > ${quoted(tarball)}`,
  ]);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  const size = fs.statSync(tarball).size;
  log(`wrote ${tarball} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
}

main().catch((err) => fail(err?.stack ?? String(err)));
