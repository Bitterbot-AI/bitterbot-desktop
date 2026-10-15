/**
 * The npm view of the package (scripts/npm-package.ts) and the repo
 * invariants that keep `npm install -g bitterbot` working: security
 * overrides in step with pnpm, optional peers, bundled extension
 * dependencies reachable from the package root, and self-contained install
 * hooks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  expectedOverrideVersions,
  NPM_OPTIONAL_PEERS,
  npmPublishManifest,
  npmPublishManifestProblems,
  overrideSyncProblems,
  type PackageManifest,
  shrinkwrapInputManifest,
  shrinkwrapOverrideViolations,
} from "../../scripts/npm-package.ts";
import { lifecycleProblems, unresolvableSpecProblems } from "../../scripts/release-check.ts";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const readPkg = (): PackageManifest =>
  JSON.parse(fs.readFileSync(repoFile("package.json"), "utf8")) as PackageManifest;

describe("npmPublishManifest", () => {
  it("marks the heavy native peers optional and keeps the key beside peerDependencies", () => {
    const out = npmPublishManifest({
      name: "bitterbot",
      peerDependencies: { "@napi-rs/canvas": "^0.1.89", "node-llama-cpp": "3.15.1" },
      engines: { node: ">=22.12.0" },
    });
    expect(out.peerDependenciesMeta).toEqual({
      "@napi-rs/canvas": { optional: true },
      "node-llama-cpp": { optional: true },
    });
    expect(Object.keys(out)).toEqual([
      "name",
      "peerDependencies",
      "peerDependenciesMeta",
      "engines",
    ]);
    expect(npmPublishManifestProblems(out)).toEqual([]);
  });

  it("flags any peer npm would auto-install", () => {
    const problems = npmPublishManifestProblems({
      peerDependencies: { "node-llama-cpp": "3.15.1", "some-new-peer": "^1.0.0" },
      peerDependenciesMeta: { "node-llama-cpp": { optional: true } },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("some-new-peer");
  });

  it("covers every peer the real package.json declares", () => {
    const pkg = readPkg();
    expect(npmPublishManifestProblems(npmPublishManifest(pkg))).toEqual([]);
    // The committed manifest must NOT mark them optional: pnpm's
    // autoInstallPeers skips optional peers, which would drop node-llama-cpp
    // from source checkouts, the image and the release tarball.
    for (const name of NPM_OPTIONAL_PEERS) {
      expect(pkg.peerDependencies?.[name]).toBeTruthy();
      expect(pkg.peerDependenciesMeta?.[name]).toBeUndefined();
    }
  });

  it("resolves the shrinkwrap without devDependencies or scripts", () => {
    const input = shrinkwrapInputManifest({
      name: "bitterbot",
      scripts: { postinstall: "node x.mjs" },
      dependencies: { a: "1.0.0" },
      devDependencies: { vitest: "^4.0.0" },
      overrides: { qs: "6.14.2" },
    });
    expect(input).toEqual({
      name: "bitterbot",
      dependencies: { a: "1.0.0" },
      overrides: { qs: "6.14.2" },
    });
  });
});

describe("overrides", () => {
  it("package.json overrides (npm) stay in step with pnpm-workspace.yaml overrides", () => {
    const pkg = readPkg();
    const workspace = YAML.parse(fs.readFileSync(repoFile("pnpm-workspace.yaml"), "utf8")) as {
      overrides?: Record<string, string>;
    };
    expect(workspace.overrides && Object.keys(workspace.overrides).length).toBeGreaterThan(0);
    expect(
      overrideSyncProblems({
        npmOverrides: pkg.overrides,
        pnpmOverrides: workspace.overrides,
        dependencies: pkg.dependencies,
      }),
    ).toEqual([]);
  });

  it("names a missing, extra, drifted or EOVERRIDE-shaped entry", () => {
    const problems = overrideSyncProblems({
      npmOverrides: { qs: "6.14.1", tar: "7.5.9", extra: "1.0.0", typebox: "$typebox" },
      pnpmOverrides: { qs: "6.14.2", tar: "7.5.9", missing: "1.0.0", typebox: "0.34.48" },
      dependencies: { tar: "7.5.22", typebox: "0.34.40" },
    });
    expect(problems.join("\n")).toMatch(/qs: npm override "6.14.1" differs/);
    expect(problems.join("\n")).toMatch(/tar: is a direct dependency, so npm needs "\$tar"/);
    expect(problems.join("\n")).toMatch(/missing: in pnpm-workspace.yaml/);
    expect(problems.join("\n")).toMatch(/extra: in package.json overrides but not/);
    expect(problems.join("\n")).toMatch(
      /typebox: dependency 0.34.40 is below the pnpm security pin/,
    );
  });

  it("expects $refs to resolve to the direct dependency's exact version", () => {
    const expected = expectedOverrideVersions({
      dependencies: { tar: "7.5.22" },
      overrides: { tar: "$tar", qs: "6.14.2" },
    });
    expect(Object.fromEntries(expected)).toEqual({ tar: "7.5.22", qs: "6.14.2" });
  });

  it("finds every nested copy that escaped an override in the shrinkwrap", () => {
    const violations = shrinkwrapOverrideViolations(
      {
        packages: {
          "": {},
          "node_modules/qs": { version: "6.14.2" },
          "node_modules/express/node_modules/qs": { version: "6.13.0" },
          "node_modules/vitest/node_modules/qs": { version: "6.0.0", dev: true },
          "node_modules/tar": { version: "7.5.22" },
        },
      },
      new Map([
        ["qs", "6.14.2"],
        ["tar", "7.5.22"],
      ]),
    );
    expect(violations).toEqual([
      "node_modules/express/node_modules/qs is 6.13.0, override pins 6.14.2",
    ]);
  });
});

describe("registry install invariants", () => {
  it("declares every bundled extension's runtime dependency at the package root", () => {
    // npm installs only the root package's dependencies; an extension's own
    // package.json is never installed from, so its imports must resolve from
    // the root node_modules (pnpm installs them per workspace member).
    const pkg = readPkg();
    const extDir = repoFile("extensions");
    const missing: string[] = [];
    for (const ext of fs.readdirSync(extDir)) {
      const manifestPath = path.join(extDir, ext, "package.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;
      for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (pkg.dependencies?.[name] !== spec) {
          missing.push(
            `${ext}: ${name}@${spec} (root has ${pkg.dependencies?.[name] ?? "nothing"})`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("has no workspace/link/file specs in the runtime dependency maps", () => {
    expect(unresolvableSpecProblems(readPkg())).toEqual([]);
  });

  it("ships every file the install hooks run, with their imports", () => {
    const pkg = readPkg();
    const files = (pkg.files as string[]) ?? [];
    const packPaths = new Set<string>();
    for (const entry of files) {
      const abs = repoFile(entry);
      if (entry.endsWith("/") || entry.startsWith("dist")) {
        continue; // directories are not where hooks live; dist is not built here
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        packPaths.add(entry);
      }
    }
    const readFile = (rel: string) => {
      try {
        return fs.readFileSync(repoFile(rel), "utf8");
      } catch {
        return null;
      }
    };
    expect(pkg.scripts?.preinstall).toBeTruthy();
    expect(pkg.scripts?.postinstall).toBeTruthy();
    expect(lifecycleProblems({ scripts: pkg.scripts, packPaths, readFile })).toEqual([]);
    // fetch-orchestrator.mjs reads the orchestrator version from this file.
    expect(files).toContain("orchestrator/Cargo.toml");
  });
});

describe("publish wiring", () => {
  const workflow = (name: string) =>
    YAML.parse(fs.readFileSync(repoFile(`.github/workflows/${name}`), "utf8")) as {
      on: Record<string, { types?: string[]; inputs?: Record<string, unknown> } | null>;
      jobs: Record<
        string,
        {
          environment?: string;
          permissions?: Record<string, string>;
          steps?: Array<{ run?: string }>;
        }
      >;
    };

  it("npm-publish.yml is the trusted publisher: npm environment, OIDC, gated publish", () => {
    // These names are what the npm trusted-publisher form is filled with
    // (docs/reference/npm-publishing.md); renaming either breaks publishing.
    const wf = workflow("npm-publish.yml");
    expect(wf.on.release?.types).toEqual(["published"]);
    expect(wf.on.workflow_dispatch?.inputs).toHaveProperty("tag");
    const job = wf.jobs.publish;
    expect(job?.environment).toBe("npm");
    expect(job?.permissions?.["id-token"]).toBe("write");
    const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("node --import tsx scripts/npm-package.ts prepare");
    expect(runs).toContain("pnpm release:check --npm-publish");
    expect(runs).toContain("npm publish --provenance --access public");
    expect(runs).toContain("npm install -g npm@11");
    expect(runs).toMatch(/npm view "bitterbot@/);
    expect(runs).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("release-please dispatches it, and CI installs the same package shape", () => {
    const rp = workflow("release-please.yml");
    expect((rp.jobs["npm-publish"]?.steps ?? []).map((s) => s.run).join("\n")).toContain(
      "gh workflow run npm-publish.yml",
    );
    const ci = workflow("ci.yml");
    const runs = (ci.jobs["npm-package"]?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("node --import tsx scripts/npm-package.ts prepare");
    expect(runs).toContain("npm install -g --prefix");
  });

  it("the missing-local-embeddings advice names the pinned node-llama-cpp", () => {
    const pin = readPkg().peerDependencies?.["node-llama-cpp"];
    const src = fs.readFileSync(repoFile("src/memory/embeddings.ts"), "utf8");
    expect(src).toContain(`npm install -g node-llama-cpp@${pin}`);
    const doctor = fs.readFileSync(repoFile("src/commands/doctor-install-health.ts"), "utf8");
    expect(doctor).toContain(`NODE_LLAMA_CPP_VERSION = "${pin}"`);
  });
});
