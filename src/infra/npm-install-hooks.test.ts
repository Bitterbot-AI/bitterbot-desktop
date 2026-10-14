/**
 * The install hooks as a registry install runs them: copied into a package
 * root WITHOUT pnpm-workspace.yaml (the published package never has one) or
 * flagged global by npm, versus a source checkout.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function stagePackage(opts: { workspace: boolean; scripts: string[] }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-hooks-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "bitterbot", engines: { node: ">=22.12.0" } }),
  );
  if (opts.workspace) {
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n");
  }
  for (const rel of opts.scripts) {
    fs.copyFileSync(repoFile(rel), path.join(root, rel));
  }
  return root;
}

function run(root: string, script: string, env: Record<string, string>) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (/^(npm_|bitterbot_)/i.test(key)) {
      delete clean[key];
    }
  }
  return spawnSync(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...clean, HOME: root, USERPROFILE: root, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("preinstall-check.mjs", () => {
  it("does not nag a package install about pnpm or build tools", () => {
    const root = stagePackage({ workspace: false, scripts: ["scripts/preinstall-check.mjs"] });
    const res = run(root, "scripts/preinstall-check.mjs", {
      npm_config_user_agent: "npm/10.9.4 node/v22.22.1 linux x64 workspaces/false",
      npm_config_global: "true",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("WARN");
    expect(res.stdout).toContain("(package install)");
  });

  it("treats a root without pnpm-workspace.yaml as a package install even when not global", () => {
    const root = stagePackage({ workspace: false, scripts: ["scripts/preinstall-check.mjs"] });
    const res = run(root, "scripts/preinstall-check.mjs", {
      npm_config_user_agent: "npm/10.9.4 node/v22.22.1 linux x64 workspaces/false",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("instead of pnpm");
  });

  it("still warns a source checkout installed with npm", () => {
    const root = stagePackage({ workspace: true, scripts: ["scripts/preinstall-check.mjs"] });
    const res = run(root, "scripts/preinstall-check.mjs", {
      npm_config_user_agent: "npm/10.9.4 node/v22.22.1 linux x64 workspaces/false",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("instead of pnpm");
  });

  it("hard-fails below the engines floor for a package install too", () => {
    const root = stagePackage({ workspace: false, scripts: ["scripts/preinstall-check.mjs"] });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "bitterbot", engines: { node: ">=99.0.0" } }),
    );
    const res = run(root, "scripts/preinstall-check.mjs", { npm_config_global: "true" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Bitterbot requires Node");
  });
});

describe("fetch-orchestrator.mjs", () => {
  it("never fails the install, even when its helper module is missing", () => {
    const root = stagePackage({ workspace: false, scripts: ["scripts/fetch-orchestrator.mjs"] });
    const res = run(root, "scripts/fetch-orchestrator.mjs", {});
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("[orchestrator-fetch] unexpected error");
    expect(fs.existsSync(path.join(root, ".bitterbot", "bin"))).toBe(false);
  });

  it("skips cleanly on request", () => {
    const root = stagePackage({
      workspace: false,
      scripts: ["scripts/fetch-orchestrator.mjs", "scripts/orchestrator-signature.mjs"],
    });
    const res = run(root, "scripts/fetch-orchestrator.mjs", {
      BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD: "1",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("skipped: BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD is set");
  });
});
