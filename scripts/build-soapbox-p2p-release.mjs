import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const base = path.resolve(process.argv[2]);
const output = path.join(root, "dist/soapbox-integration");
execFileSync("python3", [path.join(root, "scripts/build-soapbox-p2p-release.py"), base], {
  stdio: "inherit",
});
const { stage } = JSON.parse(await readFile(path.join(output, "source-stage.json"), "utf8"));
execFileSync(
  process.execPath,
  [path.join(root, "scripts/build-soapbox-integration.mjs"), base, "--plugin-only"],
  { cwd: root, stdio: "inherit" },
);
execFileSync(process.execPath, ["scripts/build-gateway-entry.mjs"], {
  cwd: stage,
  stdio: "inherit",
});
await mkdir(path.join(output, "gateway"), { recursive: true });
for (const name of ["entry.js", "babel.cjs"])
  await cp(path.join(stage, "dist", name), path.join(output, "gateway", name));
const entry = path.join(output, "gateway/entry.js");
await writeFile(entry, (await readFile(entry, "utf8")).replace(/^\/\/# sourceMappingURL=.*$/m, ""));
execFileSync(
  process.execPath,
  [path.join(root, "desktop/node_modules/vite/bin/vite.js"), "build"],
  { cwd: path.join(stage, "desktop"), stdio: "inherit" },
);
await rm(path.join(output, "ui"), { recursive: true, force: true });
await cp(path.join(stage, "desktop/dist-renderer"), path.join(output, "ui"), { recursive: true });
const version = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8")).version;
await writeFile(
  path.join(output, "build.json"),
  JSON.stringify(
    {
      version,
      base_commit: execFileSync("/usr/bin/git", ["-C", base, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      built_at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("Built Compute plugin, gateway and UI for Bitterbot " + version);
