/**
 * Fake signed release-tarball releases on disk for the updater tests
 * (PLAN-56 Phase 3b): the same layout, manifest format, checksums and
 * minisign signature as .github/workflows/release-tarball.yml, with a POSIX
 * sh launcher that answers `--version` and `update preflight --json`.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildManifest } from "../../scripts/release-tarball-lib.mjs";
import { signTestMinisign, type TestMinisignKey } from "./minisign.js";

export type FakeLauncherBehaviour = {
  /** What `--version` prints (default: the release version). */
  printVersion?: string;
  /** `ok` (default), `block` (ok:false + exit 1) or `missing` (an old version without the command). */
  preflight?: "ok" | "block" | "missing";
};

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function fakeLauncher(version: string, b: FakeLauncherBehaviour = {}): string {
  const printed = b.printVersion ?? version;
  const pf = b.preflight ?? "ok";
  const report = (ok: boolean, blocking: string[]) =>
    JSON.stringify({
      kind: "bitterbot-update-preflight",
      version,
      ok,
      blocking,
      warnings: ["main.sqlite: schema 70 will be migrated to 78 on boot"],
      memorySchemaLatest: 78,
    });
  const preflightBody =
    pf === "missing"
      ? `echo "error: unknown command 'preflight'" >&2; exit 1`
      : pf === "block"
        ? `echo '${report(false, ["config fails the schema"])}'; exit 1`
        : `echo '${report(true, [])}'; exit 0`;
  return [
    "#!/bin/sh",
    'root=$(cd "$(dirname "$0")/.." && pwd -P)',
    'mkdir -p "$root/.pids" && : > "$root/.pids/$$"',
    'case "$1" in',
    `  --version) echo "${printed}" ;;`,
    `  update) if [ "$2" = "preflight" ]; then ${preflightBody}; fi; exit 2 ;;`,
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");
}

/** Write an unpacked version directory (what install.sh leaves) at `dir`. */
export function writeVersionDir(
  dir: string,
  version: string,
  platformId: string,
  behaviour: FakeLauncherBehaviour = {},
): void {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  const launcher = Buffer.from(fakeLauncher(version, behaviour));
  fs.writeFileSync(path.join(dir, "bin", "bitterbot"), launcher, { mode: 0o755 });
  const entry = Buffer.from(`// bitterbot ${version}\n`);
  fs.writeFileSync(path.join(dir, "dist", "entry.js"), entry);
  fs.writeFileSync(path.join(dir, "bitterbot.mjs"), "// fake\n");
  const manifest = buildManifest({
    version,
    platformId,
    nodeVersion: "v22.0.0",
    orchestratorVersion: "0.2.3",
    commit: null,
    builtAt: "2026-10-11T00:00:00.000Z",
    files: [
      { path: "bin/bitterbot", sha256: sha256(launcher), size: launcher.length, mode: "755" },
      { path: "bitterbot.mjs", sha256: sha256(Buffer.from("// fake\n")), size: 8, mode: "644" },
      { path: "dist/entry.js", sha256: sha256(entry), size: entry.length, mode: "644" },
    ],
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  fs.writeFileSync(path.join(dir, ".bitterbot-install-kind"), "tarball\n");
}

export type PublishOptions = FakeLauncherBehaviour & {
  tamper?: boolean;
  comment?: string;
  signer?: TestMinisignKey;
  noSig?: boolean;
  /** Corrupt one file after the manifest was written (manifest check must fail). */
  corruptFile?: boolean;
};

/** A fake release `version` under `<releases>/download/v<version>/` plus the API listing. */
export function publishFakeRelease(params: {
  releases: string;
  work: string;
  version: string;
  platformId: string;
  key: TestMinisignKey;
  opts?: PublishOptions;
}): void {
  const { releases, version, platformId, key } = params;
  const opts = params.opts ?? {};
  const top = `bitterbot-${version}-${platformId}`;
  const src = path.join(params.work, `src-${version}-${crypto.randomBytes(4).toString("hex")}`);
  writeVersionDir(path.join(src, top), version, platformId, opts);
  if (opts.corruptFile) {
    fs.appendFileSync(path.join(src, top, "dist", "entry.js"), "tampered\n");
  }
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
      signTestMinisign(opts.signer ?? key, checksums, opts.comment ?? `v${version} checksums`),
    );
  }
  if (opts.tamper) {
    fs.appendFileSync(path.join(dir, asset), "tampered");
  }
  writeReleasesApi(releases);
}

export function writeReleasesApi(releases: string): void {
  const dl = path.join(releases, "download");
  const tags = fs.existsSync(dl) ? fs.readdirSync(dl) : [];
  const listing = tags.map((tag) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: fs.readdirSync(path.join(dl, tag)).map((name) => ({
      name,
      browser_download_url: `https://github.com/Bitterbot-AI/bitterbot-desktop/releases/download/${tag}/${name}`,
    })),
  }));
  fs.mkdirSync(path.join(releases, "api"), { recursive: true });
  fs.writeFileSync(path.join(releases, "api", "releases.json"), JSON.stringify(listing));
}
