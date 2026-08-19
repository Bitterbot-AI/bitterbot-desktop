import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { createGatewayStartHandler } from "./gateway-launcher";

/**
 * Resolve the gateway auth token with the following precedence:
 *   1. VITE_GATEWAY_TOKEN env var (CI, Docker, explicit override)
 *   2. ~/.bitterbot/bitterbot.json → gateway.auth.token (local dev)
 *   3. empty string (first-run, before `bitterbot onboard` creates the config)
 *
 * This eliminates the manual copy-paste of the token from the gateway
 * config into desktop/.env.
 */
function resolveGatewayToken(): string {
  const envToken = process.env.VITE_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;

  const configPath =
    process.env.BITTERBOT_CONFIG_PATH?.trim() ||
    path.join(os.homedir(), ".bitterbot", "bitterbot.json");

  try {
    if (!fs.existsSync(configPath)) return "";
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as {
      gateway?: { auth?: { token?: string } };
    };
    return config.gateway?.auth?.token?.trim() ?? "";
  } catch {
    return "";
  }
}

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
  const token = resolveGatewayToken();
  const url = resolveGatewayUrl();
  const clientName = resolveClientName();

  if (!token) {
    // eslint-disable-next-line no-console
    console.warn(
      "\n⚠  No gateway token found.\n" +
        "   Run `pnpm bitterbot onboard` first, or set VITE_GATEWAY_TOKEN.\n" +
        "   The Control UI will load but gateway requests will fail until the token is available.\n",
    );
  }

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
      "import.meta.env.VITE_GATEWAY_TOKEN": JSON.stringify(token),
      "import.meta.env.VITE_GATEWAY_CLIENT_NAME": JSON.stringify(clientName),
    },
  };
});
