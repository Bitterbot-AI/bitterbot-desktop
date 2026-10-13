#!/usr/bin/env node
/**
 * CI helper (PLAN-56 Phase 3b): derive another release tarball from a built
 * one, so the installer job can prove an in-place update A -> B without a
 * second full build. Same code, only the version string differs:
 *
 *   node scripts/make-release-variant.mjs --tarball <A.tar.gz> --version <B> --out <dir>
 *        [--fail-gateway]
 *
 * - unpacks <A.tar.gz> (system tar, so pnpm's symlinks survive),
 * - renames the top directory to bitterbot-<B>-<platform>,
 * - sets "version" in package.json and dist/build-info.json,
 * - with --fail-gateway, makes bin/bitterbot exit 1 when it would RUN the
 *   gateway (`gateway`, `gateway run`, `gateway --flags`): a release whose
 *   gateway cannot boot. `--version`, `update preflight` and the gateway
 *   management subcommands (`gateway switch`, `gateway status`, ...) still
 *   work, so the updater activates it and the boot watchdog must roll it
 *   back, and `gateway switch` must roll back to the gateway it replaced,
 * - rewrites manifest.json (version, sha256 and size of the changed files),
 * - packs <out>/bitterbot-<B>-<platform>.tar.gz and its .manifest.json.
 *
 * Never used for a real release: real tarballs come from
 * scripts/build-release-tarball.mjs in .github/workflows/release-tarball.yml.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(msg) {
  console.error(`[release-variant] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { tarball: null, version: null, out: null, failGateway: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--fail-gateway") {
      args.failGateway = true;
      continue;
    }
    const v = argv[i + 1];
    if (!v) {
      fail(`${a} needs a value`);
    }
    i += 1;
    if (a === "--tarball") {
      args.tarball = v;
    } else if (a === "--version") {
      args.version = v;
    } else if (a === "--out") {
      args.out = v;
    } else {
      fail(`unknown argument ${a}`);
    }
  }
  if (!args.tarball || !args.version || !args.out) {
    fail("usage: --tarball <A.tar.gz> --version <X.Y.Z> --out <dir> [--fail-gateway]");
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.version)) {
    fail(`--version must be X.Y.Z, got ${args.version}`);
  }
  return args;
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function setJsonVersion(file, version) {
  if (!fs.existsSync(file)) {
    return false;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.version = version;
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

const args = parseArgs(process.argv.slice(2));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-release-variant-"));
try {
  execFileSync("tar", ["-xzf", args.tarball, "-C", work]);
  const tops = fs.readdirSync(work);
  if (tops.length !== 1) {
    fail(`expected one top directory in ${args.tarball}, found ${tops.join(", ")}`);
  }
  const oldTop = tops[0];
  const m = /^bitterbot-(\d+\.\d+\.\d+)-(.+)$/.exec(oldTop);
  if (!m) {
    fail(`unexpected top directory ${oldTop}`);
  }
  const platform = m[2];
  const newTop = `bitterbot-${args.version}-${platform}`;
  const root = path.join(work, newTop);
  fs.renameSync(path.join(work, oldTop), root);

  const changed = ["package.json"];
  setJsonVersion(path.join(root, "package.json"), args.version);
  if (setJsonVersion(path.join(root, "dist", "build-info.json"), args.version)) {
    changed.push("dist/build-info.json");
  }
  if (args.failGateway) {
    const launcher = path.join(root, "bin", "bitterbot");
    const lines = fs.readFileSync(launcher, "utf8").split("\n");
    lines.splice(
      1,
      0,
      "# CI: a release whose gateway cannot boot (PLAN-56 Phase 3b rollback smoke).",
      'if [ "${1:-}" = "gateway" ]; then case "${2:-}" in "" | -* | run) echo "simulated boot failure" >&2; exit 1 ;; esac; fi',
    );
    fs.writeFileSync(launcher, lines.join("\n"));
    changed.push("bin/bitterbot");
  }

  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = args.version;
  for (const entry of manifest.files) {
    if (changed.includes(entry.path) && typeof entry.sha256 === "string") {
      const file = path.join(root, entry.path);
      entry.sha256 = sha256File(file);
      entry.size = fs.statSync(file).size;
    }
  }
  const manifestText = `${JSON.stringify(manifest, null, 1)}\n`;
  fs.writeFileSync(manifestPath, manifestText);

  fs.mkdirSync(args.out, { recursive: true });
  const asset = path.join(args.out, `${newTop}.tar.gz`);
  execFileSync("tar", ["-czf", asset, "-C", work, newTop]);
  fs.writeFileSync(path.join(args.out, `${newTop}.manifest.json`), manifestText);
  console.log(
    `[release-variant] ${asset} (v${args.version}${args.failGateway ? ", gateway fails to boot" : ""}; changed ${changed.join(", ")})`,
  );
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
