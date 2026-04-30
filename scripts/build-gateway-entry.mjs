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
 *  - Playwright / chromium-bidi — dynamic-require chains into subpaths
 *    not in chromium-bidi's exports map; off the boot/wallet critical
 *    path so leaving them external saves bundle size.
 *
 * @coinbase/agentkit + @coinbase/cdp-sdk are NOT external despite being
 * dynamic-imported. Keeping them external made the first lazy import walk
 * ~60 MB of transitive deps over 9P and took 476 s, blocking every RPC
 * queued behind the wallet provider. They're now bundled in-place, and
 * the agentkit barrel is aliased below to just CdpSmartWalletProvider
 * (the only symbol we use) to drop Solana/Privy/ZeroDev/sushi/Clanker/
 * grammy/twitter-api-v2 dead-weight.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  // @coinbase/agentkit and @coinbase/cdp-sdk were previously external on the
  // theory that "lazy loading keeps them off the boot path." In practice the
  // first lazy import walks ~60 MB of transitive deps (Solana, Privy, ZeroDev,
  // Zora, Jupiter, Clanker, etc.) from /mnt/d over 9P and took 476 s in
  // production — blocking every RPC queued behind the wallet provider and
  // trashing the page cache so subsequent SQLite fsyncs stalled for ~60 s
  // apiece. Bundle them instead: the bundle grows ~60 MB but the cost is paid
  // once as a single-file read instead of a multi-minute fs walk.
  //
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
  // Redirect the @coinbase/agentkit barrel to its one wallet provider we
  // actually use. The barrel re-exports every chain/provider (Solana, Privy,
  // ZeroDev, Zora, OpenSea, sushi, Jupiter, Clanker, grammy/Telegram,
  // twitter-api-v2, discord-api-types, ...), which dragged ~30 MB of
  // dead-weight into the bundle and made the first lazy load a multi-minute
  // fs walk. We only use CdpSmartWalletProvider.
  alias: {
    // Absolute path — bypasses agentkit's strict `exports` map (which only
    // exposes `"."`) so we can point at a specific provider file.
    "@coinbase/agentkit": resolve(
      "node_modules/@coinbase/agentkit/dist/wallet-providers/cdpSmartWalletProvider.js",
    ),
  },
}).catch((e) => {
  console.error(e);
  process.exit(1);
});

writeFileSync("dist/entry.meta.json", JSON.stringify(result.metafile, null, 2));
console.log(`[build-gateway-entry] wrote ${outfile}`);

// jiti's lazyTransform does `createRequire(import.meta.url)("../dist/babel.cjs")` at
// runtime — an opaque string require that esbuild can't statically rewrite. esbuild
// does inline babel.cjs into entry.js, but the runtime call still goes to disk
// looking for `dist/babel.cjs` next to entry.js. Drop a copy alongside so any TS
// plugin loaded by the gateway can transpile.
// jiti is a transitive dep nested under pnpm's hashed .pnpm/ tree, so a top-
// level require.resolve("@mariozechner/jiti") doesn't find it. esbuild already
// resolved the path via its own walker — pull it back out of the metafile so
// we don't duplicate resolution logic or hard-code the pnpm hash.
const babelInput = Object.keys(result.metafile.inputs).find((p) =>
  p.endsWith("jiti/dist/babel.cjs"),
);
if (!babelInput) {
  console.error("[build-gateway-entry] could not locate jiti/dist/babel.cjs in metafile");
  process.exit(1);
}
copyFileSync(babelInput, "dist/babel.cjs");
console.log(`[build-gateway-entry] copied ${babelInput} -> dist/babel.cjs`);
