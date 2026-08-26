import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { createGatewayStartHandler } from "./gateway-launcher";

function resolveGatewayUrl(): string {
  return process.env.VITE_GATEWAY_URL?.trim() || "ws://localhost:19001";
}

function resolveClientName(): string {
  return process.env.VITE_GATEWAY_CLIENT_NAME?.trim() || "bitterbot-control-ui";
}

/**
 * Dev-server-only endpoint (POST /__gateway/start) so the Overview tab's
 * "Start gateway" button can launch the gateway when only the UI is running.
 * The dev server is the sole surviving process once the gateway stops, so it
 * is the only place this can live until PLAN-39 (gateway-served UI) exists.
 * Absent from production/Tauri builds (`apply: "serve"`); the button falls
 * back to terminal guidance there.
 */
function gatewayLauncherPlugin(gatewayUrl: string): Plugin {
  return {
    name: "bitterbot-gateway-launcher",
    apply: "serve",
    configureServer(server) {
      const handler = createGatewayStartHandler({
        resolveToken: resolveGatewayToken,
        gatewayUrl,
        repoRoot: path.resolve(__dirname, ".."),
        logPath: path.join(os.homedir(), ".bitterbot", "logs", "gateway-ui-launch.log"),
      });
      server.middlewares.use("/__gateway/start", (req, res) => {
        void handler(req, res);
      });
    },
  };
}

export default defineConfig(() => {
  const url = resolveGatewayUrl();
  const clientName = resolveClientName();

  // The gateway token is deliberately NOT built into the bundle any more
  // (PLAN-39 Phase 3 / PLAN-37 item 13). It made the artifact machine-specific
  // and, once the gateway serves this bundle over HTTP, would hand the gateway
  // credential to anyone who fetched the JS. The renderer now asks the gateway
  // it was served from via the same-origin handoff endpoint, falling back to the
  // FirstRun paste flow. See renderer/src/lib/gateway-origin.ts.

  return {
    plugins: [react(), gatewayLauncherPlugin(url)],
    root: "renderer",
    envDir: __dirname,
    base: "./",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "renderer/src"),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      // WSL on a Windows-mounted drive (/mnt/*): the 9p filesystem delivers
      // NO inotify events, so Vite's watcher never sees edits and serves a
      // stale module graph until the server is bounced ("it did not hot
      // reload"). Chokidar polling is the only reliable signal there; on
      // native filesystems this stays off (polling a big tree costs CPU).
      watch:
        process.platform === "linux" && __dirname.startsWith("/mnt/")
          ? { usePolling: true, interval: 400 }
          : undefined,
    },
    build: {
      outDir: path.resolve(__dirname, "dist-renderer"),
      emptyOutDir: true,
    },
    // Expose resolved values as import.meta.env.VITE_* in the renderer.
    // This replaces the need for a desktop/.env file.
    define: {
      "import.meta.env.VITE_GATEWAY_URL": JSON.stringify(url),
      "import.meta.env.VITE_GATEWAY_CLIENT_NAME": JSON.stringify(clientName),
    },
  };
});
