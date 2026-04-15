/**
 * Top-level Canvas doctor section.
 *
 * Canvas is the A2UI rendering surface — HTML/CSS bundles the agent serves
 * over its own small HTTP server for rich visual output (plots, diagrams,
 * maps, generated interfaces). It's separate from the gateway because it
 * serves untrusted content and needs origin isolation.
 *
 * What we check:
 *   1. Canvas host config — enabled state, port derivation
 *   2. Canvas root directory — exists, readable, not pointing at /
 *   3. A2UI bundle presence — the Rust-rendered UI framework must be built
 *   4. Port availability (informational; gateway-running check tells us
 *      whether the canvas port SHOULD be in use)
 *
 * What we deliberately don't check:
 *   - Live canvas server health (that's in doctor-gateway-health if running)
 *   - Individual canvas bundle contents (the resolver is strict about this)
 */

import fs from "node:fs";
import path from "node:path";
import type { BitterbotConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/config.js";
import { DEFAULT_CANVAS_HOST_PORT, deriveDefaultCanvasHostPort } from "../config/port-defaults.js";
import { note } from "../terminal/note.js";

type Level = "ok" | "warn" | "error" | "info";
type CheckResult = { level: Level; message: string };

const ok = (message: string): CheckResult => ({ level: "ok", message });
const warn = (message: string): CheckResult => ({ level: "warn", message });
const error = (message: string): CheckResult => ({ level: "error", message });
const info = (message: string): CheckResult => ({ level: "info", message });

function formatLevel(r: CheckResult): string {
  switch (r.level) {
    case "ok":
      return `\u2714 ${r.message}`;
    case "warn":
      return `\u26A0 ${r.message}`;
    case "error":
      return `\u2718 ${r.message}`;
    case "info":
      return `\u2139 ${r.message}`;
  }
}

export async function runCanvasChecks(params: { config: BitterbotConfig }): Promise<void> {
  const { config } = params;
  const canvas = config.canvasHost;
  const results: CheckResult[] = [];

  // ── Enabled? ──
  if (canvas?.enabled === false) {
    results.push(
      info("Canvas host disabled — agent cannot render A2UI output (charts, maps, generated UIs)"),
    );
    renderSection(results);
    return;
  }
  results.push(
    ok(
      canvas?.enabled === true ? "Canvas host explicitly enabled" : "Canvas host enabled (default)",
    ),
  );

  // ── Port ──
  const gatewayPort = resolveGatewayPort(config);
  const configuredPort = canvas?.port;
  const effectivePort = configuredPort ?? deriveDefaultCanvasHostPort(gatewayPort);
  if (configuredPort && configuredPort !== DEFAULT_CANVAS_HOST_PORT) {
    results.push(ok(`Canvas port: ${effectivePort} (explicit override)`));
  } else {
    results.push(ok(`Canvas port: ${effectivePort} (derived from gateway port ${gatewayPort})`));
  }

  // ── Root directory ──
  const rootRaw = canvas?.root;
  if (rootRaw) {
    const root = path.resolve(rootRaw);
    if (root === "/" || root === path.resolve("/")) {
      results.push(
        error(
          `Canvas root is set to filesystem root "${root}" — refusing to serve (would expose everything)`,
        ),
      );
    } else {
      try {
        const stat = fs.statSync(root);
        if (!stat.isDirectory()) {
          results.push(error(`Canvas root ${root} exists but is not a directory`));
        } else {
          try {
            fs.accessSync(root, fs.constants.R_OK);
            results.push(ok(`Canvas root: ${root}`));
          } catch {
            results.push(error(`Canvas root ${root} is not readable`));
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          results.push(
            info(`Canvas root ${root} does not exist yet (will be created on first write)`),
          );
        } else {
          results.push(
            warn(
              `Canvas root ${root} check failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      }
    }
  } else {
    results.push(info("Canvas root: default (~/.bitterbot/workspace/canvas)"));
  }

  // ── A2UI bundle ──
  // a2ui.bundle.js is committed (it's a pre-compiled Rust→WASM runtime) so
  // its presence is a proxy for "this install has the renderer."
  const a2uiBundle = path.resolve(process.cwd(), "src/canvas-host/a2ui/a2ui.bundle.js");
  const a2uiBundleAlt = path.resolve(process.cwd(), "dist/canvas-host/a2ui/a2ui.bundle.js");
  const bundleFound = fs.existsSync(a2uiBundle) || fs.existsSync(a2uiBundleAlt);
  if (bundleFound) {
    results.push(ok("A2UI renderer bundle present"));
  } else {
    results.push(
      warn(
        "A2UI renderer bundle NOT found (src/canvas-host/a2ui/a2ui.bundle.js).\n" +
          "  Canvas will serve static content but cannot render A2UI scenes.\n" +
          "  If this is a library install, ignore. If source clone, check your build.",
      ),
    );
  }

  // ── Live reload (dev signal) ──
  if (canvas?.liveReload === true) {
    results.push(info("Live reload enabled (dev mode — don't ship this in prod)"));
  }

  renderSection(results);
}

function renderSection(results: CheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  note(results.map(formatLevel).join("\n"), "Canvas (A2UI rendering)");
}
