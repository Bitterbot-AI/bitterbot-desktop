import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["benchmarks/learning-strategy/*.test.ts"], pool: "forks", maxWorkers: 1 },
});
