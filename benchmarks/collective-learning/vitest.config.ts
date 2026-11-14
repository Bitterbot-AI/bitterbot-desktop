import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["benchmarks/collective-learning/*.test.ts"], environment: "node" },
});
