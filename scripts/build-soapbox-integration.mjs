/** Build a gateway plugin and an additive UI overlay against the installed release source. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const release = path.resolve(process.argv[2] ?? root);
const output = path.join(root, "dist/soapbox-integration");
const plugin = path.join(output, "plugin");
if (!process.argv.includes("--ui-only")) await rm(plugin, { recursive: true, force: true });
await mkdir(plugin, { recursive: true });
if (!process.argv.includes("--ui-only"))
  await build({
    entryPoints: {
      index: path.join(root, "extensions/soapbox-compute/index.ts"),
      "buyer-wallet": path.join(root, "scripts/soapbox-buyer-wallet.ts"),
    },
    outdir: plugin,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    plugins: [
      {
        name: "wallet-imports",
        setup(b) {
          b.onResolve({ filter: /^@coinbase\/agentkit$/ }, () => ({
            path: "wallet",
            namespace: "wallet",
          }));
          b.onLoad({ filter: /.*/, namespace: "wallet" }, () => ({
            resolveDir: root,
            contents: [
              ["CdpEvmWalletProvider", "wallet-providers/cdpEvmWalletProvider.js"],
              ["CdpSmartWalletProvider", "wallet-providers/cdpSmartWalletProvider.js"],
              [
                "X402ActionProvider, x402ActionProvider",
                "action-providers/x402/x402ActionProvider.js",
              ],
            ]
              .map(
                ([names, file]) =>
                  `export {${names}} from ${JSON.stringify(path.join(root, "node_modules/@coinbase/agentkit/dist", file))};`,
              )
              .join("\n"),
          }));
        },
      },
    ],
    logLevel: "info",
  });
for (const file of ["package.json", "bitterbot.plugin.json"])
  await cp(path.join(root, "extensions/soapbox-compute", file), path.join(plugin, file));
const pluginPackage = JSON.parse(await readFile(path.join(plugin, "package.json"), "utf8"));
pluginPackage.bitterbot.extensions = ["./index.cjs"];
await writeFile(path.join(plugin, "package.json"), JSON.stringify(pluginPackage, null, 2));

if (process.argv.includes("--plugin-only")) process.exit(0);

const stage = await mkdtemp(path.join(tmpdir(), "soapbox-release-ui-"));
// Git archive preserves the release and excludes unrelated edits / credentials.
const archive = path.join(stage, "source.tar");
execFileSync("git", [
  "-C",
  release,
  "archive",
  "--format=tar",
  `--output=${archive}`,
  "HEAD",
  "desktop",
  "src",
  "package.json",
]);
execFileSync("tar", ["-xf", archive, "-C", stage]);
for (const folder of ["node_modules", "desktop/node_modules"])
  await symlink(path.join(release, folder), path.join(stage, folder), "dir");
await cp(
  path.join(root, "desktop/renderer/src/components/compute"),
  path.join(stage, "desktop/renderer/src/components/compute"),
  { recursive: true },
);
await cp(
  path.join(root, "src/infra/soapbox-client.ts"),
  path.join(stage, "src/infra/soapbox-client.ts"),
);
await cp(
  path.join(root, "src/infra/soapbox-setup-types.ts"),
  path.join(stage, "src/infra/soapbox-setup-types.ts"),
);
const patch = async (file, from, to) => {
  const target = path.join(stage, file);
  const text = await readFile(target, "utf8");
  assert.equal(text.split(from).length, 2, `Expected one UI anchor in ${file}`);
  await writeFile(target, text.replace(from, to));
};
await patch(
  "desktop/renderer/src/components/layout/AppShell.tsx",
  "const VIEW_MAP:",
  'import { ComputeView } from "../compute/ComputeView";\n\nconst VIEW_MAP:',
);
await patch(
  "desktop/renderer/src/components/layout/AppShell.tsx",
  "  chat: () => <ChatView />,",
  "  compute: () => <ComputeView />,\n  chat: () => <ChatView />,",
);
await patch(
  "desktop/renderer/src/nav-manifest.ts",
  "  // ── Advanced ──",
  '  { id: "compute", label: "Compute", icon: Server, group: "main" },\n  // ── Advanced ──',
);
console.log(`Building release UI from ${release} in ${stage}`);
execFileSync(
  process.execPath,
  [path.join(release, "desktop/node_modules/vite/bin/vite.js"), "build"],
  {
    cwd: path.join(stage, "desktop"),
    stdio: "inherit",
  },
);
await rm(path.join(output, "ui"), { recursive: true, force: true });
await cp(path.join(stage, "desktop/dist-renderer"), path.join(output, "ui"), { recursive: true });
const version = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8")).version;
await writeFile(
  path.join(output, "build.json"),
  JSON.stringify({ version, release, stage, built_at: new Date().toISOString() }, null, 2),
);
console.log(`Compute integration built for Bitterbot ${version}: ${output}`);
