import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["renderer/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist-renderer"],
    setupFiles: [path.join(here, "test", "setup.ts")],
  },
  resolve: {
    alias: {
      "@": path.join(here, "renderer", "src"),
    },
  },
});
