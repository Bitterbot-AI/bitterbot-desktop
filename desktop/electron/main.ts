import { app, BrowserWindow, shell, ipcMain, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startGateway, stopGateway, getGatewayPort, isReusingExternalGateway } from "./gateway-bridge.js";
import {
  createMainWindow,
  setupWindowIPC,
} from "./window-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Prevent ECONNREFUSED from crashing the app when the orchestrator isn't running.
// This is expected during startup and reconnect cycles.
process.on("uncaughtException", (err) => {
  const msg = err?.message ?? "";
  if (msg.includes("ECONNREFUSED") && msg.includes("19002")) {
    console.warn("[bitterbot] Orchestrator IPC connection refused (non-fatal, will retry)");
    return;
  }
  // EADDRINUSE on gateway port — already handled by gateway-bridge startup logic
  if (msg.includes("EADDRINUSE")) {
    console.warn("[bitterbot] Address already in use (non-fatal):", msg);
    return;
  }
  console.error("[bitterbot] Uncaught exception:", err);
});

async function bootstrap() {
  // ── State directory setup ──────────────────────────────────────────
  // Use Electron's userData as the bitterbot state dir
  // On Windows: %APPDATA%/Bitterbot
  // On macOS: ~/Library/Application Support/Bitterbot
  const stateDir = app.getPath("userData");

  if (!process.env.BITTERBOT_STATE_DIR) {
    process.env.BITTERBOT_STATE_DIR = stateDir;
  }

  fs.mkdirSync(stateDir, { recursive: true });

  // ── Bundled templates and skills ───────────────────────────────────
  // In packaged mode, set env vars so the resolvers find templates/skills
  // inside the app resources instead of looking for the monorepo root.
  if (!isDev) {
    const appDir = path.join(process.resourcesPath, "app");
    const templatesDir = path.join(appDir, "templates");
    const skillsDir = path.join(appDir, "skills");

    if (fs.existsSync(templatesDir) && !process.env.BITTERBOT_TEMPLATE_DIR) {
      process.env.BITTERBOT_TEMPLATE_DIR = templatesDir;
      console.log("[bitterbot] Templates dir:", templatesDir);
    } else {
      console.log("[bitterbot] Templates dir NOT SET. exists:", fs.existsSync(templatesDir), "env:", process.env.BITTERBOT_TEMPLATE_DIR ?? "unset", "path:", templatesDir);
    }
    if (fs.existsSync(skillsDir) && !process.env.BITTERBOT_BUNDLED_SKILLS_DIR) {
      process.env.BITTERBOT_BUNDLED_SKILLS_DIR = skillsDir;
      console.log("[bitterbot] Skills dir:", skillsDir);
    }
    const a2uiDir = path.join(appDir, "a2ui");
    if (fs.existsSync(a2uiDir) && !process.env.BITTERBOT_A2UI_DIR) {
      process.env.BITTERBOT_A2UI_DIR = a2uiDir;
      console.log("[bitterbot] A2UI dir:", a2uiDir);
    }
  }

  // ── API keys ────────────────────────────────────────────────────────
  // For beta: load from .env file in userData, or fall back to hardcoded demo keys.
  // Post-beta: replace with in-app key entry UI.
  const envPath = path.join(stateDir, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
      if (match) {
        const val = match[2]!.trim();
        // Skip placeholder values from old installer builds
        if (!val.startsWith("REPLACE_WITH")) {
          process.env[match[1]!] = val;
        }
      }
    }
  }

  // Check for required API keys — warn if missing so users know to configure.
  // Keys are loaded from ~/.bitterbot/.env (above) or from environment variables.
  const missingKeys: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missingKeys.push("ANTHROPIC_API_KEY");
  if (!process.env.OPENAI_API_KEY) missingKeys.push("OPENAI_API_KEY");
  if (missingKeys.length > 0) {
    console.warn(
      `[bitterbot] Missing API keys: ${missingKeys.join(", ")}. ` +
      `Add them to ${envPath} or set as environment variables. ` +
      `See desktop/.env.example for the template.`,
    );
  }

  // ── First-launch: copy demo config + env ───────────────────────────
  const configPath = path.join(stateDir, "bitterbot.json");
  if (!fs.existsSync(configPath)) {
    const resourcesDir = isDev
      ? path.join(__dirname, "..", "resources")
      : path.join(process.resourcesPath, "resources");
    const demoConfig = path.join(resourcesDir, "demo-config.json");
    if (fs.existsSync(demoConfig)) {
      fs.copyFileSync(demoConfig, configPath);
      console.log("[bitterbot] Copied demo config to", configPath);
    }
  } else if (!isDev) {
    // Ensure existing config has controlUi settings for beta
    // (fixes testers who have old config without admin bypass)
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      let patched = false;
      if (!cfg.gateway) cfg.gateway = {};
      if (!cfg.gateway.controlUi) { cfg.gateway.controlUi = {}; patched = true; }
      if (!cfg.gateway.controlUi.dangerouslyDisableDeviceAuth) { cfg.gateway.controlUi.dangerouslyDisableDeviceAuth = true; patched = true; }
      if (!cfg.gateway.controlUi.allowInsecureAuth) { cfg.gateway.controlUi.allowInsecureAuth = true; patched = true; }
      // Force token to match renderer's hardcoded value for beta
      if (!cfg.gateway.auth) cfg.gateway.auth = {};
      if (cfg.gateway.auth.token !== "local-dev-token") {
        cfg.gateway.auth.token = "local-dev-token";
        patched = true;
      }
      // Ensure elevated exec is enabled for webchat (desktop app)
      if (!cfg.tools) cfg.tools = {};
      if (!cfg.tools.elevated) {
        cfg.tools.elevated = { enabled: true, allowFrom: { webchat: ["*"] } };
        patched = true;
      } else if (!cfg.tools.elevated.allowFrom?.webchat) {
        if (!cfg.tools.elevated.allowFrom) cfg.tools.elevated.allowFrom = {};
        cfg.tools.elevated.allowFrom.webchat = ["*"];
        patched = true;
      }
      // Ensure exec runs without approval for beta
      if (!cfg.tools.exec || cfg.tools.exec.ask !== "off") {
        cfg.tools.exec = { ...(cfg.tools.exec ?? {}), ask: "off", host: "gateway", security: "full" };
        patched = true;
      }
      if (patched) {
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
        console.log("[bitterbot] Patched config with beta settings");
      }
    } catch {}
  }

  // Copy demo .env on first launch (API keys)
  if (!fs.existsSync(envPath)) {
    const resourcesDir = isDev
      ? path.join(__dirname, "..", "resources")
      : path.join(process.resourcesPath, "resources");
    const envSrc = path.join(resourcesDir, ".env");
    if (fs.existsSync(envSrc)) {
      fs.copyFileSync(envSrc, envPath);
      console.log("[bitterbot] Copied demo env to", envPath);
      // Re-read the env file we just copied
      const lines = fs.readFileSync(envPath, "utf-8").split("\n");
      for (const line of lines) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
        if (match) {
          process.env[match[1]!] = match[2]!.trim();
        }
      }
    }
  }

  // ── Bootstrap workspace files on first launch ──────────────────────
  // The gateway only creates workspace files when agents.create is called,
  // but we want GENOME.md, PROTOCOLS.md, TOOLS.md, HEARTBEAT.md, MEMORY.md
  // to exist from the moment the app first opens.
  const defaultWorkspaceDir = path.join(
    process.env.BITTERBOT_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".bitterbot"),
    "workspace",
  );
  if (!fs.existsSync(path.join(defaultWorkspaceDir, "GENOME.md"))) {
    fs.mkdirSync(defaultWorkspaceDir, { recursive: true });
    const templatesDir = process.env.BITTERBOT_TEMPLATE_DIR;
    if (templatesDir) {
      for (const file of ["GENOME.md", "PROTOCOLS.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"]) {
        const dest = path.join(defaultWorkspaceDir, file);
        const src = path.join(templatesDir, file);
        if (!fs.existsSync(dest) && fs.existsSync(src)) {
          let content = fs.readFileSync(src, "utf-8");
          // Strip YAML frontmatter
          if (content.startsWith("---")) {
            const endIdx = content.indexOf("---", 3);
            if (endIdx !== -1) {
              content = content.slice(endIdx + 3).trimStart();
            }
          }
          fs.writeFileSync(dest, content, "utf-8");
          console.log(`[bitterbot] Created ${file}`);
        }
      }
    }
  }

  // ── Start the gateway ──────────────────────────────────────────────
  // The single-instance lock (above) prevents duplicate Electron processes.
  // If a healthy gateway is already on the port (lingering process, CLI, etc.)
  // we reuse it instead of crashing.  SO_REUSEADDR handles TIME_WAIT.
  try {
    // Read the auth token so the probe can authenticate to an existing gateway
    let authToken: string | undefined;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      authToken = cfg?.gateway?.auth?.token;
    } catch {}
    if (!authToken) authToken = process.env.BITTERBOT_GATEWAY_TOKEN;

    await startGateway(19001, { authToken });

    if (isReusingExternalGateway()) {
      console.log(`[bitterbot] Reusing existing gateway on port ${getGatewayPort()}`);
    } else {
      console.log(`[bitterbot] Gateway started on port ${getGatewayPort()}`);
    }
  } catch (err) {
    console.error("[bitterbot] Failed to start gateway:", err);
    dialog.showErrorBox(
      "Bitterbot — Startup Error",
      `Failed to start the gateway: ${err instanceof Error ? err.message : String(err)}\n\n` +
      `If you just closed Bitterbot, wait a few seconds and try again.`,
    );
  }

  // ── Create window ──────────────────────────────────────────────────
  const win = createMainWindow({ isDev, dirname: __dirname });

  setupWindowIPC();

  // Expose gateway URL to renderer via IPC
  ipcMain.handle("get-gateway-url", () => {
    return `ws://127.0.0.1:${getGatewayPort()}`;
  });

  ipcMain.handle("get-version", () => {
    return app.getVersion();
  });

  ipcMain.handle("open-external", (_event, url: string) => {
    shell.openExternal(url);
  });

  if (isDev) {
    // In dev mode, load the Vite dev server
    await win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // In production, serve renderer files via a local HTTP server
    // This avoids file:// protocol issues with CSP, CORS, and module loading
    const { createServer } = await import("node:http");
    const rendererDir = path.join(__dirname, "../dist-renderer");
    const mimeTypes: Record<string, string> = {
      ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
      ".css": "text/css", ".json": "application/json", ".png": "image/png",
      ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
      ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
    };
    const http = await import("node:http");
    const rendererServer = createServer((req, res) => {
      // Proxy canvas/a2ui requests to the gateway so iframes load same-origin
      if (req.url?.startsWith("/__bitterbot__/")) {
        const proxyReq = http.request(
          `http://127.0.0.1:${getGatewayPort()}${req.url}`,
          { method: req.method, headers: req.headers },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", () => {
          res.statusCode = 502;
          res.end("gateway unavailable");
        });
        req.pipe(proxyReq);
        return;
      }
      let filePath = path.join(rendererDir, req.url === "/" ? "index.html" : req.url!);
      if (!fs.existsSync(filePath)) filePath = path.join(rendererDir, "index.html");
      const ext = path.extname(filePath);
      res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
      res.end(fs.readFileSync(filePath));
    });
    await new Promise<void>((resolve) => rendererServer.listen(0, "localhost", resolve));
    const rendererPort = (rendererServer.address() as import("node:net").AddressInfo).port;
    console.log(`[bitterbot] Renderer server on http://localhost:${rendererPort}`);
    await win.loadURL(`http://localhost:${rendererPort}`);
  }

  // Beta: log renderer console to main process stdout
  win.webContents.on("console-message", (_e, _level, message) => {
    console.log("[renderer]", message);
  });

  // Beta: log any page errors
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("[bitterbot] Page load failed:", code, desc);
  });
}

// ── Single-instance lock ──────────────────────────────────────────────
// Prevent multiple Electron instances from running simultaneously.
// This is the primary fix for the port 19001/19002 conflict — if another
// instance is already running, focus it instead of starting a second gateway.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("[bitterbot] Another instance is already running — focusing it");
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap);

  app.on("window-all-closed", async () => {
    await stopGateway().catch(() => {});
    // Wait for socket to fully release before quitting
    await new Promise((r) => setTimeout(r, 500));
    app.quit();
  });

  app.on("before-quit", () => {
    stopGateway().catch(() => {});
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createMainWindow({ isDev, dirname: __dirname });
      if (isDev) {
        win.loadURL("http://localhost:5173");
      } else {
        win.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
      }
    }
  });
}
