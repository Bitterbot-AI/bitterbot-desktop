import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "bitterbot/plugin-sdk/account-id",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "account-id.ts"),
      },
      {
        find: "bitterbot/plugin-sdk",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      },
    ],
  },
  test: {
    testTimeout: 60_000,
    pool: "forks",
    include: ["benchmarks/biomemeval/suites/*.test.ts"],
    setupFiles: ["benchmarks/biomemeval/setup.ts"],
    reporters: [
      "default",
      ["json", { outputFile: "benchmarks/biomemeval/results/vitest-results.json" }],
    ],
    globals: true,
    root: repoRoot,
  },
});
