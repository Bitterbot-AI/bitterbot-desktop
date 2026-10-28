/**
 * The published npm package is the launcher (scripts/npm-package.ts,
 * src/launcher/): no dependencies, no scripts, one bundled file with only
 * `node:` imports, compat shims for 1.6.x installs, and a publish pipeline
 * that runs only after the release tarballs it downloads are public.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  COMPAT_SHIMS,
  compatShimSource,
  LAUNCHER_FILE,
  LAUNCHER_PACKAGE_FILES,
  launcherManifest,
  launcherManifestProblems,
  nonBuiltinImports,
  type PackageManifest,
  prepareLauncherPackage,
} from "../../scripts/npm-package.ts";
import { lifecycleProblems } from "../../scripts/release-check.ts";
import { publishFakeRelease, writeReleasesApi } from "../test-utils/fake-tarball-release.js";
import { makeTestMinisignKey } from "../test-utils/minisign.js";
import { tarballPlatformId } from "./install-kind.js";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const readPkg = (): PackageManifest =>
  JSON.parse(fs.readFileSync(repoFile("package.json"), "utf8")) as PackageManifest;

describe("launcherManifest", () => {
  it("accepts explicit beta releases but rejects malformed versions", () => {
    const base = launcherManifest(readPkg());
    expect(launcherManifestProblems({ ...base, version: "1.11.0-beta.2" })).toEqual([]);
    for (const version of ["1.11.0-beta.0", "1.11.0-alpha.1", "1.11.0-beta.2\n", "../1.11.0"]) {
      expect(launcherManifestProblems({ ...base, version })).toEqual([
        expect.stringContaining("version must be"),
      ]);
    }
  });
  it("publishes the repo's name and version with no dependencies and no scripts", () => {
    const pkg = readPkg();
    // The repo manifest has both (pnpm source installs); none may leak.
    expect(Object.keys(pkg.dependencies ?? {}).length).toBeGreaterThan(0);
    expect(pkg.scripts?.postinstall).toBeTruthy();
    const out = launcherManifest(pkg);
    expect(out.name).toBe("bitterbot");
    expect(out.version).toBe(pkg.version);
    expect(out.bin).toEqual({ bitterbot: "bitterbot.mjs" });
    expect(out.engines).toEqual({ node: ">=18" });
    expect(out.type).toBe("module");
    expect(out.files).toEqual([...LAUNCHER_PACKAGE_FILES]);
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "overrides",
      "scripts",
      "main",
      "exports",
      "pnpm",
      "packageManager",
    ]) {
      expect(out).not.toHaveProperty(key);
    }
    expect((out.repository as { url: string }).url).toBe(
      "git+https://github.com/Bitterbot-AI/bitterbot-desktop.git",
    );
    expect(launcherManifestProblems(out)).toEqual([]);
  });

  it("names every way the manifest could make npm install or run something", () => {
    const base = launcherManifest(readPkg());
    expect(
      launcherManifestProblems({
        ...base,
        dependencies: { chalk: "^5.0.0" },
        scripts: { postinstall: "node x.mjs" },
        bin: { bitterbot: "dist/entry.js" },
        engines: { node: ">=22.12.0" },
        main: "dist/index.js",
      }),
    ).toEqual([
      "package.json has dependencies: the launcher package must have no dependencies",
      "package.json has scripts (postinstall): the launcher package must have none",
      'bin must be exactly { "bitterbot": "bitterbot.mjs" }',
      'engines.node must be ">=18"',
      'package.json must not have "main"',
    ]);
    expect(launcherManifestProblems({ ...base, dependencies: {} })).toEqual([]);
  });
});

describe("compat shims", () => {
  it("cover the entry points 1.6.x services and the 1.6.x updater run", () => {
    expect([...COMPAT_SHIMS]).toEqual(["dist/entry.js", "dist/index.js"]);
    expect(compatShimSource("dist/index.js")).toContain('import "../bitterbot.mjs";');
    expect(nonBuiltinImports(compatShimSource("dist/entry.js"))).toEqual(["../bitterbot.mjs"]);
  });

  it("match what the daemon writes for a package install", () => {
    // program-args.ts resolves the npm bin link to <pkg>/dist/{index,entry}.js;
    // the 1.6.x updater runs <pkg>/dist/entry.js doctor after npm i -g.
    const programArgs = fs.readFileSync(repoFile("src/daemon/program-args.ts"), "utf8");
    expect(programArgs).toContain('path.join(distDir, "index.js")');
    expect(programArgs).toContain('path.join(distDir, "entry.js")');
    const updateCommand = fs.readFileSync(repoFile("src/cli/update-cli/update-command.ts"), "utf8");
    expect(updateCommand).toContain('path.join(pkgRoot, "dist", "entry.js")');
  });
});

describe("nonBuiltinImports", () => {
  it("finds bare and relative specifiers, ignores node: built-ins", () => {
    const src = [
      'import fs from "node:fs";',
      'import { x } from "chalk";',
      'import "./side.js";',
      'const y = await import("undici");',
      'const z = require("node:path");',
      "// import nothing from here",
    ].join("\n");
    expect(nonBuiltinImports(src).toSorted()).toEqual(["./side.js", "chalk", "undici"]);
  });
});

const platformId = tarballPlatformId();
const describeBundle = process.platform !== "win32" && platformId ? describe : describe.skip;

describeBundle("the built launcher package", () => {
  let work: string;
  let out: string;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-npm-launcher-"));
    out = path.join(work, "package");
    await prepareLauncherPackage({ root: repoFile("."), out });
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("is exactly the launcher, its shims, README and LICENSE", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs);
        } else {
          files.push(path.relative(out, abs).split(path.sep).join("/"));
        }
      }
    };
    walk(out);
    expect(files.toSorted()).toEqual([...LAUNCHER_PACKAGE_FILES, "package.json"].toSorted());
    const bundle = fs.readFileSync(path.join(out, LAUNCHER_FILE), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(nonBuiltinImports(bundle)).toEqual([]);
    expect(bundle).toContain(`"${readPkg().version}"`);
    expect(fs.statSync(path.join(out, LAUNCHER_FILE)).mode & 0o111).not.toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8"));
    expect(launcherManifestProblems(manifest)).toEqual([]);
    // npm runs no hook from it.
    expect(
      lifecycleProblems({ scripts: manifest.scripts, packPaths: new Set(), readFile: () => null }),
    ).toEqual([]);
  });

  it("installs a signed release on first run and runs it, through the bin and both shims", () => {
    const version = readPkg().version!;
    const releases = path.join(work, "releases");
    fs.mkdirSync(releases, { recursive: true });
    writeReleasesApi(releases);
    const key = makeTestMinisignKey();
    publishFakeRelease({ releases, work, version, platformId: platformId!, key });
    const home = path.join(work, "home");
    fs.mkdirSync(home);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      BITTERBOT_INSTALL_TEST_MODE: "1",
      BITTERBOT_INSTALL_BASE_URL: pathToFileURL(releases).href,
      BITTERBOT_INSTALL_TEST_PUBKEY: key.pubkeyB64,
    };
    const run = (file: string) =>
      spawnSync(process.execPath, [path.join(out, file), "--version"], {
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
    const first = run(LAUNCHER_FILE);
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe(version);
    expect(first.stderr).toContain(
      `Bitterbot ${version}: first run, downloading the signed release`,
    );
    expect(first.stderr).toContain(`Verified and installed to ~/.bitterbot/app/${version}.`);
    expect(fs.readlinkSync(path.join(home, ".bitterbot", "app", "current"))).toBe(version);
    for (const shim of COMPAT_SHIMS) {
      const res = run(shim);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(version);
      expect(res.stderr).toBe("");
    }
  });

  it("refuses a tampered release without a stack trace", () => {
    const version = readPkg().version!;
    const releases = path.join(work, "releases-bad");
    fs.mkdirSync(releases, { recursive: true });
    const key = makeTestMinisignKey();
    publishFakeRelease({
      releases,
      work,
      version,
      platformId: platformId!,
      key,
      opts: { tamper: true },
    });
    const home = path.join(work, "home-bad");
    fs.mkdirSync(home);
    const res = spawnSync(process.execPath, [path.join(out, LAUNCHER_FILE), "--version"], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        BITTERBOT_INSTALL_TEST_MODE: "1",
        BITTERBOT_INSTALL_BASE_URL: pathToFileURL(releases).href,
        BITTERBOT_INSTALL_TEST_PUBKEY: key.pubkeyB64,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/^Refusing to install Bitterbot .*SHA-256 mismatch/m);
    expect(res.stderr).not.toMatch(/\n\s+at /);
    expect(fs.existsSync(path.join(home, ".bitterbot", "app", "current"))).toBe(false);
  });
});

describe("publish wiring", () => {
  const workflow = (name: string) =>
    YAML.parse(fs.readFileSync(repoFile(`.github/workflows/${name}`), "utf8")) as {
      on: Record<string, { types?: string[]; inputs?: Record<string, unknown> } | null>;
      jobs: Record<
        string,
        {
          needs?: string | string[];
          if?: string;
          environment?: string;
          permissions?: Record<string, string>;
          steps?: Array<{
            run?: string;
            "working-directory"?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
  const runsOf = (steps: Array<{ run?: string }> | undefined) =>
    (steps ?? []).map((s) => s.run ?? "").join("\n");

  it("npm-publish.yml is the trusted publisher and publishes the launcher directory", () => {
    // These names are what the npm trusted-publisher form is filled with
    // (docs/reference/npm-publishing.md); renaming either breaks publishing.
    const wf = workflow("npm-publish.yml");
    expect(wf.on.release?.types).toEqual(["published"]);
    expect(wf.on.workflow_dispatch?.inputs).toHaveProperty("tag");
    const job = wf.jobs.publish;
    expect(job?.environment).toBe("npm");
    expect(job?.permissions?.["id-token"]).toBe("write");
    expect(job?.needs).toBe("assets");
    const runs = runsOf(job?.steps);
    expect(runs).toContain(
      'node --import tsx scripts/npm-package.ts prepare --out "$RUNNER_TEMP/npm-package"',
    );
    expect(runs).toContain('pnpm release:check --npm-publish --dir "$RUNNER_TEMP/npm-package"');
    expect(runs).toContain("npm publish --provenance --access public");
    expect(runs).toContain("npm install -g npm@11");
    expect(runs).toMatch(/npm view "bitterbot@/);
    expect(runs).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    // The app ships in the release tarball: no app build here.
    expect(runs).not.toContain("pnpm build");
    const publishStep = job?.steps?.find((s) => s.run?.includes("npm publish"));
    expect(publishStep?.["working-directory"]).toBe("${{ runner.temp }}/npm-package");
  });

  it("publishes only after the release assets the launcher downloads are public", () => {
    const wf = workflow("npm-publish.yml");
    const assets = runsOf(wf.jobs.assets?.steps);
    expect(assets).toContain("releases/download/v$VERSION");
    expect(assets).toContain("checksums.txt checksums.txt.minisig");
    expect(assets).toContain("bitterbot-$VERSION-$p.tar.gz");
    expect(assets).toContain("RELEASE_PLATFORMS");
    // And the launcher from this tag installs the public release with the pinned key.
    expect(assets).toContain('node "$RUNNER_TEMP/npm-package/bitterbot.mjs" --version');
    expect(assets).not.toMatch(/BITTERBOT_INSTALL_(TEST_MODE|BASE_URL|TEST_PUBKEY)/);

    const rp = workflow("release-please.yml");
    const dispatch = rp.jobs["npm-publish"];
    expect(dispatch?.needs).toEqual(["release-please", "release-tarball"]);
    expect(dispatch?.if).toContain("needs.release-tarball.result == 'success'");
    expect(runsOf(dispatch?.steps)).toContain("gh workflow run npm-publish.yml");
  });

  it("CI installs the launcher with npm 12 and fails on any warning, script or dependency", () => {
    const ci = workflow("ci.yml");
    const job = ci.jobs["npm-package"];
    const runs = runsOf(job?.steps);
    expect(runs).toContain("node --import tsx scripts/npm-package.ts prepare --out");
    expect(runs).toContain("npm install -g npm@12");
    expect(runs).toContain("npm install -g --prefix");
    expect(runs).toMatch(/grep -iE "npm warn\|allow-scripts\|install script/);
    expect(runs).toContain('test ! -e "$pkg/node_modules"');
    expect(runs).toContain('node "$pkg/dist/index.js" --version');
    expect((job?.steps ?? []).some((s) => s.with?.["node-version"] === 24)).toBe(true);
    // The installer job runs the same launcher against the real tarball.
    expect(runsOf(ci.jobs.installer?.steps)).toContain(
      'grep -q "Verified and installed to ~/.bitterbot/app/$VERSION." "$RUNNER_TEMP/npm-launcher.err"',
    );
  });

  it("the missing-local-embeddings advice names the pinned node-llama-cpp", () => {
    const pin = readPkg().peerDependencies?.["node-llama-cpp"];
    const src = fs.readFileSync(repoFile("src/memory/embeddings.ts"), "utf8");
    expect(src).toContain(`npm install -g node-llama-cpp@${pin}`);
    const doctor = fs.readFileSync(repoFile("src/commands/doctor-install-health.ts"), "utf8");
    expect(doctor).toContain(`NODE_LLAMA_CPP_VERSION = "${pin}"`);
  });
});
