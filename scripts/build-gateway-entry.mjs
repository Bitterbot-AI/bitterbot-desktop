#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
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

// The gateway only uses two symbols from the @coinbase/agentkit barrel:
// CdpSmartWalletProvider (wallet ops) and X402ActionProvider (x402 paywalls).
// The full barrel re-exports every chain/provider (~30 MB of Solana, Privy,
// ZeroDev, Zora, Jupiter, ...), so instead of bundling it we resolve the bare
// `@coinbase/agentkit` specifier to a virtual module that re-exports just those
// two from their own files. Absolute paths bypass agentkit's strict `exports`
// map (which only exposes "."). x402ActionProvider.js pulls in the @x402/*
// client packages, which resolve correctly relative to its real location.
const AGENTKIT_CDP_WALLET_PROVIDER = resolve(
  "node_modules/@coinbase/agentkit/dist/wallet-providers/cdpSmartWalletProvider.js",
);
const AGENTKIT_CDP_EVM_WALLET_PROVIDER = resolve(
  "node_modules/@coinbase/agentkit/dist/wallet-providers/cdpEvmWalletProvider.js",
);
const AGENTKIT_X402_ACTION_PROVIDER = resolve(
  "node_modules/@coinbase/agentkit/dist/action-providers/x402/x402ActionProvider.js",
);
const agentkitBarrelShimPlugin = {
  name: "agentkit-barrel-shim",
  setup(b) {
    b.onResolve({ filter: /^@coinbase\/agentkit$/ }, () => ({
      path: "agentkit-barrel-shim",
      namespace: "agentkit-shim",
    }));
    b.onLoad({ filter: /^agentkit-barrel-shim$/, namespace: "agentkit-shim" }, () => ({
      contents:
        `export { CdpSmartWalletProvider } from ${JSON.stringify(AGENTKIT_CDP_WALLET_PROVIDER)};\n` +
        `export { CdpEvmWalletProvider } from ${JSON.stringify(AGENTKIT_CDP_EVM_WALLET_PROVIDER)};\n` +
        `export { X402ActionProvider, x402ActionProvider } from ${JSON.stringify(AGENTKIT_X402_ACTION_PROVIDER)};\n`,
      resolveDir: process.cwd(),
    }));
  },
};

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
  // sqlite-vec locates its platform extension (vec0.so/.dylib/.dll) RELATIVE
  // to its own module file: getLoadablePath() resolves
  // `<dir-of-sqlite-vec>/../sqlite-vec-<os>-<arch>/vec0.<ext>` off import.meta.url.
  // Bundling it into dist/entry.js makes that base `dist/`, so it hunts for a
  // nonexistent `<repo>/sqlite-vec-linux-x64/vec0.so` and throws "Loadble
  // extension ... not found" — silently dropping vector search to the FTS
  // fallback. Keep the package (and its per-platform binary subpackages)
  // external so the import resolves to the real node_modules location at runtime.
  "sqlite-vec",
  "sqlite-vec-*",
  // sharp loads its native binary from a sibling package
  // (@img/sharp-<os>-<arch>/lib/sharp-*.node) by a path built at runtime.
  // Inlined into dist/entry.js it cannot find it and throws 'Could not load the
  // "sharp" module using the linux-x64 runtime', and every screenshot and image
  // the agent should see is replaced by an "omitted image payload" note.
  "sharp",
  "@img/*",
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
  // agentkitBarrelShimPlugin redirects the @coinbase/agentkit barrel to a
  // virtual module exposing only CdpSmartWalletProvider + X402ActionProvider,
  // keeping the barrel's ~30 MB of unused chain/provider deps out of the bundle.
  plugins: [stripShebangPlugin, agentkitBarrelShimPlugin],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});

writeFileSync("dist/entry.meta.json", JSON.stringify(result.metafile, null, 2));
console.log(`[build-gateway-entry] wrote ${outfile}`);

// Regression guard: packages that find a native binary relative to their own
// files MUST stay external (see NATIVE_EXTERNALS above). Inlined, sqlite-vec
// resolves its extension against dist/ and vector search silently degrades to
// the FTS fallback; sharp cannot load at all and images are silently dropped.
// Fail the build loudly here rather than discovering it from a runtime warning.
for (const pkg of ["sqlite-vec", "sharp"]) {
  const inNodeModules = new RegExp(`(^|[\\\\/])node_modules[\\\\/]${pkg}[\\\\/]`);
  const inlined = Object.keys(result.metafile.inputs).filter((p) => inNodeModules.test(p));
  if (inlined.length > 0) {
    console.error(
      `[build-gateway-entry] ${pkg} was bundled into ${outfile} (${inlined
        .slice(0, 5)
        .join(", ")}). It must be external — add it to NATIVE_EXTERNALS.`,
    );
    process.exit(1);
  }
}

// jiti's lazyTransform does `createRequire(import.meta.url)("../dist/babel.cjs")` at
// runtime — an opaque string require that esbuild can't statically rewrite, so
// the runtime call goes to disk looking for `dist/babel.cjs` next to entry.js.
// Drop a copy alongside so any TS plugin loaded by the gateway can transpile.
// Our own import (src/plugins/loader.ts) is jiti's ESM build, which never
// references babel.cjs statically; the file only appeared in the metafile
// while the pi engine bundled jiti's CJS build. Prefer the metafile when it
// has it, otherwise resolve the file from the jiti package itself
// (`jiti/dist/babel.cjs` is not in its exports map, `jiti/package.json` is).
const babelFromMetafile = Object.keys(result.metafile.inputs).find((p) =>
  p.endsWith("jiti/dist/babel.cjs"),
);
const babelFromPackage = resolve(
  dirname(createRequire(import.meta.url).resolve("jiti/package.json")),
  "dist/babel.cjs",
);
const babelInput =
  babelFromMetafile ?? (existsSync(babelFromPackage) ? babelFromPackage : undefined);
if (!babelInput) {
  console.error(
    `[build-gateway-entry] could not locate jiti/dist/babel.cjs (metafile or ${babelFromPackage})`,
  );
  process.exit(1);
}
copyFileSync(babelInput, "dist/babel.cjs");
console.log(`[build-gateway-entry] copied ${babelInput} -> dist/babel.cjs`);
