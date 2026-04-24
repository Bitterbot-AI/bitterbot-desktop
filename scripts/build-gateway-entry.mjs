#!/usr/bin/env node
/**
 * Bundle src/entry.ts into a single dist/entry.js via esbuild.
 *
 * Why: tsdown produces ~1455 chunks in dist/ across all entry points.
 * On WSL's /mnt/d 9P filesystem, Node's module-resolution walk across
 * those chunks pushes gateway cold boot to ~190 s. A single bundled
 * file drops boot-time file reads from thousands to a handful.
 *
 * Externalized (left as runtime imports):
 *  - Native addons (must resolve to platform .node files at runtime).
 *  - @coinbase/agentkit + @coinbase/cdp-sdk — these are dynamic-imported
 *    on first wallet RPC, so they don't sit on the boot critical path.
 *    Keeping them external avoids inflating the bundle size (~60 MB of
 *    cross-chain SDK surface) for code that's rarely used.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

// Strip the source shebang from src/entry.ts so esbuild doesn't emit it
// in the middle of the bundled output (shebangs are only valid on line 1).
// The banner below re-inserts it.
const stripShebangPlugin = {
  name: "strip-shebang",
  setup(b) {
    b.onLoad({ filter: /src[\\/]entry\.ts$/ }, (args) => {
      const contents = readFileSync(args.path, "utf-8").replace(/^#!.*\n/, "");
      return { contents, loader: "ts" };
    });
  },
};

// ESM output can't natively serve require() calls that live inside bundled
// CJS packages (dotenv etc.). Inject a createRequire-backed shim so they
// resolve against the bundle's own URL.
const BANNER = `#!/usr/bin/env node
import { createRequire as __bitterbot_cr } from "node:module";
const require = __bitterbot_cr(import.meta.url);`;

const NATIVE_EXTERNALS = [
  "@napi-rs/canvas",
  "@napi-rs/canvas-*",
  "lightningcss",
  "lightningcss-*",
  "@mariozechner/clipboard",
  "@mariozechner/clipboard-*",
  "@oxlint/binding",
  "@oxlint/binding-*",
  "@oxfmt/binding",
  "@oxfmt/binding-*",
  // node-llama-cpp bundles optional platform-specific submodules
  // (@node-llama-cpp/mac-x64, win-x64-cuda, etc.) that esbuild can't
  // resolve at bundle time. Keep the whole tree external.
  "node-llama-cpp",
  "@node-llama-cpp/*",
  // reflink binds a .node file per platform; leave external.
  "@reflink/reflink",
  "@reflink/reflink-*",
];

const LAZY_EXTERNALS = [
  "@coinbase/agentkit",
  "@coinbase/cdp-sdk",
  // Playwright / chromium-bidi do dynamic-require chains into submodule
  // paths that aren't in chromium-bidi's exports map. Externalize wholesale
  // rather than patching every subpath; this code is lazy (browser automation)
  // and doesn't sit on the boot critical path anyway.
  "playwright",
  "playwright-core",
  "playwright-core/*",
  "chromium-bidi",
  "chromium-bidi/*",
];

const outfile = "dist/entry.js";
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: ["src/entry.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile,
  packages: "bundle",
  external: [...NATIVE_EXTERNALS, ...LAZY_EXTERNALS],
  splitting: false,
  minify: false,
  sourcemap: "linked",
  logLevel: "info",
  metafile: true,
  // Belt-and-braces: if a .node require slips through the externals,
  // tell esbuild to emit it as-is rather than erroring out.
  loader: { ".node": "file" },
  banner: { js: BANNER },
  plugins: [stripShebangPlugin],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});

writeFileSync("dist/entry.meta.json", JSON.stringify(result.metafile, null, 2));
console.log(`[build-gateway-entry] wrote ${outfile}`);
