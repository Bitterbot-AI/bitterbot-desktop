import { defineConfig, type UserConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

// Options shared by every config. Several of these pin behaviour that the
// tsdown 0.20 -> 0.23 and rolldown 1.0.0-rc.4 -> 1.2 upgrades changed by
// default, so the emitted dist/ stays equivalent to the old bundler's:
const base = {
  env,
  fixedExtension: false,
  platform: "node",
  // tsdown >= 0.22 auto-enables dts when tsconfig has `declaration: true`
  // or package.json `exports` carries nested `types` (both true here). That
  // runs rolldown-plugin-dts (a full TypeScript program) once per config,
  // seven in parallel, and OOMs CI. dist/plugin-sdk/*.d.ts is produced by
  // `pnpm build:plugin-sdk:dts` (tsc) instead, as before.
  dts: false,
  // tsdown 0.21 changed the default from "ci-only" to false. Keep warnings
  // (including rolldown warnings) fatal in CI.
  failOnWarn: "ci-only",
  // rolldown rc.7 made `minify: "dce-only"` the default; the old output was
  // unminified.
  minify: false,
  // rolldown rc.5 flipped invalidImportSideEffects to false; keep the old
  // conservative assumption that unresolvable imports may have side effects.
  treeshake: { invalidImportSideEffects: true },
  inputOptions: {
    // rolldown 1.1 enables lazy barrel elision by default; it can drop a
    // re-exported module that is relied on for side effects.
    experimental: { lazyBarrel: false },
    // rolldown rc.7/rc.18 made smart constant inlining the default.
    optimization: { inlineConst: false },
  },
  // Never inline anything from node_modules into the tsdown outputs.
  // Production deps are external by default; this turns any accidental
  // bundling of a dev/transitive dependency into a build error.
  deps: { onlyBundle: [] },
} satisfies UserConfig;

export default defineConfig([
  {
    ...base,
    entry: "src/index.ts",
  },
  // src/entry.ts is bundled separately by scripts/build-gateway-entry.mjs
  // (esbuild, single-file) to avoid tsdown's ~1455-chunk split.
  {
    ...base,
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    entry: "src/cli/daemon-cli.ts",
  },
  {
    ...base,
    entry: "src/infra/warning-filter.ts",
  },
  {
    ...base,
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
  },
  {
    ...base,
    entry: "src/plugin-sdk/account-id.ts",
    outDir: "dist/plugin-sdk",
  },
  {
    ...base,
    entry: "src/extensionAPI.ts",
  },
  {
    ...base,
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
  },
]);
