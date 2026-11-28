#!/usr/bin/env node
// PLAN-65 screenshot harness.
//
// Serves the built Control UI from a throwaway local server that also plays
// the gateway (same-origin token handoff plus a WebSocket that answers RPCs
// from fixtures.mjs), then captures a fixed set of screens in light and dark.
//
// The output is for people: attach it to a restyle PR as before and after.
// It is not a pixel-diff gate.
//
//   node desktop/scripts/ui-screenshots/capture.mjs [--out <dir>] [--no-build]
//        [--only <state,...>] [--theme light|dark]
//
// Chromium: BITTERBOT_UI_CHROME_PATH, else Playwright's own download, else a
// system chromium. No real gateway is contacted and nothing is written
// outside --out.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELLO, RESPONSES } from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "..");
const repoRoot = path.resolve(desktopDir, "..");
const distDir = path.join(desktopDir, "dist-renderer");
const require = createRequire(path.join(repoRoot, "package.json"));

function parseArgs(argv) {
  const out = {
    outDir: path.join(desktopDir, ".ui-screenshots"),
    build: true,
    only: null,
    themes: ["light", "dark"],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.outDir = path.resolve(argv[++i]);
    else if (a === "--no-build") out.build = false;
    else if (a === "--only") out.only = new Set(argv[++i].split(",").map((s) => s.trim()));
    else if (a === "--theme") out.themes = [argv[++i]];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/** Static files + token handoff + fake gateway WebSocket, all on one port. */
async function startFakeGateway(unanswered) {
  const { WebSocketServer } = require("ws");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/session-token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "screenshot-harness" }));
      return;
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = path.join(distDir, rel);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame?.type !== "req") return;
      let payload;
      if (frame.method === "connect") payload = HELLO;
      else if (frame.method in RESPONSES) {
        const r = RESPONSES[frame.method];
        payload = typeof r === "function" ? r(frame.params) : r;
      } else {
        // Refuse, as a gateway without the method would. An empty object in
        // an unexpected shape crashes views; a refusal exercises the error
        // path they already have.
        unanswered.set(frame.method, (unanswered.get(frame.method) ?? 0) + 1);
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "INVALID_REQUEST", message: `unknown method: ${frame.method}` },
          }),
        );
        return;
      }
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

/**
 * Chromium builds an earlier Playwright left in its cache, newest first. A
 * dependency bump changes the revision Playwright asks for; an older download
 * is still fine for screenshots.
 */
function cachedPlaywrightBrowsers() {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(cache)) return [];
  const names = ["chrome", "headless_shell", "chrome-headless-shell"];
  const found = [];
  for (const dir of fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .sort((a, b) => a.localeCompare(b))
    .reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, dir), { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      for (const name of names) {
        const exe = path.join(cache, dir, sub.name, name);
        if (fs.existsSync(exe)) found.push(exe);
      }
    }
  }
  return found;
}

async function launchBrowser() {
  const { chromium } = require("playwright-core");
  const candidates = [
    process.env.BITTERBOT_UI_CHROME_PATH,
    undefined, // Playwright's own download, when its revision matches
    ...cachedPlaywrightBrowsers(),
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];
  let lastErr;
  for (const executablePath of candidates) {
    if (executablePath === "") continue;
    if (executablePath && !fs.existsSync(executablePath)) continue;
    try {
      return await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `no usable Chromium. Set BITTERBOT_UI_CHROME_PATH or run "pnpm exec playwright install chromium". Last error: ${lastErr?.message?.split("\n")[0] ?? "none"}`,
  );
}

const click = (page, name) =>
  page
    .getByRole("button", typeof name === "string" ? { name, exact: true } : { name })
    .first()
    .click();

/** A sidebar destination. */
const navTo = (label) => async (page) => {
  await click(page, label);
  await page.waitForTimeout(600);
};

/** A Control Center view: open the Control Center, then pick the view. */
const controlTo = (label) => async (page) => {
  await page
    .getByRole("button", { name: /^Control Center/ })
    .first()
    .click();
  await page
    .getByRole("navigation", { name: "Control Center" })
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.waitForTimeout(600);
};

/**
 * The fixed set. Names are stable so before and after files line up.
 * `setup` runs after the app has connected and the sidebar has loaded.
 */
const STATES = [
  { name: "chat-empty", setup: async () => {} },
  {
    name: "chat-conversation",
    setup: async (page) => {
      await page.getByText("Clone and download numbers, week 47").first().click();
      await page.getByText("Downloads rose and clones fell").waitFor({ timeout: 10_000 });
    },
  },
  {
    name: "chat-composer-typed",
    setup: async (page) => {
      await page.locator("textarea").first().fill("Chart the two weeks side by side, one chart.");
    },
  },
  {
    name: "chat-narrow",
    viewport: { width: 900, height: 700 },
    setup: async (page) => {
      await page.getByText("Clone and download numbers, week 47").first().click();
      await page.getByText("Downloads rose and clones fell").waitFor({ timeout: 10_000 });
    },
  },
  {
    name: "search-open",
    setup: async (page) => {
      await click(page, /^Search/);
      await page.getByPlaceholder(/Search conversations/).fill("clone");
    },
  },
  {
    name: "sidebar-closed",
    setup: async (page) => {
      await click(page, "Close sidebar");
    },
  },
  { name: "view-memory", setup: navTo("Memory") },
  { name: "view-overview", setup: controlTo("Overview") },
  { name: "view-skills", setup: controlTo("Skills") },
  { name: "view-settings", setup: controlTo("Settings") },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.build) {
    console.log("building renderer (vite build)...");
    const r = spawnSync("pnpm", ["exec", "vite", "build"], { cwd: desktopDir, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    console.error(`no build at ${distDir}. Run without --no-build.`);
    process.exit(1);
  }
  fs.mkdirSync(args.outDir, { recursive: true });

  const unanswered = new Map();
  const failures = [];
  const gateway = await startFakeGateway(unanswered);
  const browser = await launchBrowser();
  try {
    for (const theme of args.themes) {
      for (const state of STATES) {
        if (args.only && !args.only.has(state.name)) continue;
        const context = await browser.newContext({
          viewport: state.viewport ?? { width: 1440, height: 900 },
          deviceScaleFactor: 1,
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await context.addInitScript((t) => {
          try {
            localStorage.setItem("bitterbot-theme", t);
          } catch {}
        }, theme);
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(err.message.split("\n")[0]));
        const file = path.join(args.outDir, `${state.name}.${theme}.png`);
        try {
          await page.goto(gateway.origin, { waitUntil: "load" });
          await page
            .getByText("Clone and download numbers, week 47")
            .first()
            .waitFor({ timeout: 20_000 });
          await state.setup(page);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(400);
          await page.screenshot({ path: file });
          if (pageErrors.length > 0) throw new Error(`page error: ${pageErrors[0]}`);
          console.log(`ok   ${path.relative(process.cwd(), file)}`);
        } catch (err) {
          const why = pageErrors.length > 0 ? ` (page error: ${pageErrors[0]})` : "";
          failures.push(`${state.name}.${theme}: ${err.message.split("\n")[0]}${why}`);
          if (!fs.existsSync(file)) {
            await page.screenshot({ path: file.replace(/\.png$/, ".FAILED.png") }).catch(() => {});
          }
          console.log(`FAIL ${state.name}.${theme}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await gateway.close();
  }

  if (unanswered.size > 0) {
    console.log(
      "\nunanswered methods (refused; add to fixtures.mjs if a view shows an error or looks empty):",
    );
    for (const [m, n] of [...unanswered.entries()].sort((a, b) => a[0].localeCompare(b[0])))
      console.log(`  ${m} x${n}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} state(s) failed:`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
}

await main();
