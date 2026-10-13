/**
 * The `pnpm ui:build` skip gate (scripts/ui-build.mjs) must rebuild the
 * Control UI when ANY build input changes, not only desktop/renderer: a vite
 * upgrade (lockfile), a vite.config.ts change or a release version bump used
 * to leave update.run shipping a stale bundle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeUiInputHash } from "../../scripts/ui-build-lib.mjs";

let root: string;

function write(rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-build-hash-"));
  write("package.json", JSON.stringify({ name: "bitterbot", version: "1.4.0", scripts: {} }));
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nvite: 8.3.4\n");
  write("pnpm-workspace.yaml", "packages:\n  - desktop\n");
  write("desktop/package.json", '{"name":"bitterbot-control-ui"}');
  write("desktop/vite.config.ts", "export default {};\n");
  write("desktop/tsconfig.json", "{}");
  write("desktop/postcss.config.mjs", "export default {};\n");
  write("desktop/gateway-launcher.ts", "export {};\n");
  write("desktop/renderer/index.html", "<html></html>");
  write("desktop/renderer/src/main.tsx", "console.log(1);\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ENV = {};

describe("computeUiInputHash", () => {
  it("is stable for unchanged inputs", () => {
    expect(computeUiInputHash(root, ENV)).toBe(computeUiInputHash(root, ENV));
  });

  it.each([
    ["renderer source", "desktop/renderer/src/main.tsx", "console.log(2);\n"],
    ["renderer index.html", "desktop/renderer/index.html", "<html><body/></html>"],
    ["vite config", "desktop/vite.config.ts", "export default { base: '/' };\n"],
    ["desktop package.json", "desktop/package.json", '{"name":"x","dependencies":{"a":"1"}}'],
    ["desktop tsconfig", "desktop/tsconfig.json", '{"compilerOptions":{}}'],
    ["a new tsconfig variant", "desktop/tsconfig.node.json", "{}"],
    ["postcss config", "desktop/postcss.config.mjs", "export default { plugins: {} };\n"],
    ["a module vite.config imports", "desktop/gateway-launcher.ts", "export const x = 1;\n"],
    ["a vite env file", "desktop/.env.production", "VITE_X=1\n"],
    [
      "the lockfile (vite/plugin upgrade)",
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\nvite: 8.4.0\n",
    ],
  ])("changes when the %s changes", (_label, rel, content) => {
    const before = computeUiInputHash(root, ENV);
    write(rel, content);
    expect(computeUiInputHash(root, ENV)).not.toBe(before);
  });

  it("changes when the root package version changes (baked in as VITE_APP_VERSION)", () => {
    const before = computeUiInputHash(root, ENV);
    write("package.json", JSON.stringify({ name: "bitterbot", version: "1.5.0", scripts: {} }));
    expect(computeUiInputHash(root, ENV)).not.toBe(before);
  });

  it("ignores root package.json changes that are not the version", () => {
    const before = computeUiInputHash(root, ENV);
    write(
      "package.json",
      JSON.stringify({ name: "bitterbot", version: "1.4.0", scripts: { x: "y" } }),
    );
    expect(computeUiInputHash(root, ENV)).toBe(before);
  });

  it("changes with the VITE_* environment vite.config.ts reads", () => {
    const before = computeUiInputHash(root, ENV);
    expect(computeUiInputHash(root, { VITE_GATEWAY_URL: "ws://box:19001" })).not.toBe(before);
  });

  it.each([
    ["build output", "desktop/dist-renderer/index.html"],
    ["dependencies", "desktop/node_modules/vite/index.js"],
    ["Tauri shell", "desktop/src-tauri/src/main.rs"],
    ["lint scripts", "desktop/scripts/check-file-sizes.mjs"],
    ["tests", "desktop/renderer/src/main.test.tsx"],
    ["vitest config", "desktop/vitest.config.ts"],
    ["docs", "desktop/README.md"],
    ["the env example", "desktop/.env.example"],
  ])("ignores %s", (_label, rel) => {
    const before = computeUiInputHash(root, ENV);
    write(rel, "anything");
    expect(computeUiInputHash(root, ENV)).toBe(before);
  });
});
