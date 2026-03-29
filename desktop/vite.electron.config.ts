import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "electron/main.ts"),
      formats: ["es"],
      fileName: () => "main.js",
    },
    outDir: "dist-electron",
    emptyOutDir: true,
    rollupOptions: {
      external: [
        "electron",
        /^node:.*/,
        /^[^./]/, // externalize all bare imports (node_modules)
      ],
    },
    target: "node22",
    minify: false,
  },
});
