import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vite";

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
    plugins: [react()],
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
