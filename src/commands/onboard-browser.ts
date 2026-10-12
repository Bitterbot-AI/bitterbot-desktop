/**
 * `bitterbot onboard` in the browser (PLAN-56 Phase 4).
 *
 * Starts the gateway when nothing listens on its port (or reuses the running
 * one: a service, a container), mints a one-time setup token (30 minutes,
 * wizard scope only; src/gateway/setup-token.ts) and prints, then opens,
 * `http://127.0.0.1:<port><basePath>/setup?token=...`. The Control UI's setup
 * page runs the same steps as the terminal QuickStart over `wizard.*`.
 *
 * Surface choice: `--no-browser` keeps the terminal wizard; `--browser`
 * forces the setup page. Without either, the setup page is the default, and
 * the link is opened when a browser is available and stdin is a terminal;
 * headless, SSH and container sessions print the link instead. Flags that
 * only the terminal wizard understands (--flow, --mode, --auth-choice and
 * the provider key, gateway and daemon flags) keep the terminal wizard.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig, readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { issueSetupToken, SETUP_TOKEN_TTL_MS } from "../gateway/setup-token.js";
import { looksLikeContainer, readDeclaredInstallKind } from "../infra/install-kind.js";
import type { RuntimeEnv } from "../runtime.js";
import { isFirstBootOnlyConfig } from "../wizard/onboarding.first-boot.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import type { OnboardOptions } from "./onboard-types.js";

export type OnboardSurface =
  | { kind: "terminal" }
  | { kind: "browser"; open: boolean; headless: boolean; inContainer: boolean };

/** Options only the terminal wizard (or --non-interactive) acts on. */
const TERMINAL_ONLY_KEYS: Array<keyof OnboardOptions> = [
  "flow",
  "mode",
  "workspace",
  "authChoice",
  "token",
  "tokenProvider",
  "anthropicApiKey",
  "openaiApiKey",
  "openrouterApiKey",
  "customBaseUrl",
  "remoteUrl",
  "installDaemon",
  "daemonRuntime",
  "gatewayPort",
  "gatewayBind",
  "gatewayAuth",
  "gatewayToken",
  "gatewayPassword",
  "tailscale",
  "nodeManager",
];

export function resolveOnboardSurface(params: {
  opts: OnboardOptions;
  stdinIsTty: boolean;
  inContainer: boolean;
  remote: boolean;
}): OnboardSurface {
  const { opts } = params;
  if (opts.browser === false) {
    return { kind: "terminal" };
  }
  if (opts.browser !== true && TERMINAL_ONLY_KEYS.some((key) => opts[key] !== undefined)) {
    return { kind: "terminal" };
  }
  const headless = params.inContainer || params.remote;
  return {
    kind: "browser",
    open: !headless && params.stdinIsTty,
    headless,
    inContainer: params.inContainer,
  };
}

export function buildSetupUrl(params: { port: number; basePath?: string; token?: string }): string {
  const base = normalizeControlUiBasePath(params.basePath);
  const query = params.token ? `?token=${encodeURIComponent(params.token)}` : "";
  return `http://127.0.0.1:${params.port}${base}/setup${query}`;
}

/** True when something accepts TCP connections on 127.0.0.1:<port>. */
export function isPortListening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Start `bitterbot gateway` in the background for setup; returns its log path. */
export function spawnSetupGateway(port: number): { pid?: number; logPath: string } {
  const logDir = path.join(resolveStateDir(), "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, "gateway-setup.log");
  const fd = fs.openSync(logPath, "a", 0o600);
  const entry = process.argv[1];
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      entry,
      "gateway",
      // Setup runs before a config exists; the wizard writes gateway.mode.
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      String(port),
    ],
    { detached: true, stdio: ["ignore", fd, fd], env: process.env },
  );
  child.unref();
  fs.closeSync(fd);
  return { pid: child.pid, logPath };
}

export async function waitForPort(
  port: number,
  deadlineMs: number,
  probe: (port: number) => Promise<boolean> = isPortListening,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (await probe(port)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

export type BrowserOnboardingDeps = {
  stdinIsTty?: boolean;
  inContainer?: boolean;
  remote?: boolean;
  isListening?: (port: number) => Promise<boolean>;
  startGateway?: (port: number) => { pid?: number; logPath: string };
  waitForGateway?: (port: number) => Promise<boolean>;
  openUrl?: (url: string) => Promise<boolean>;
};

export async function runBrowserOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  surface: Extract<OnboardSurface, { kind: "browser" }>,
  deps: BrowserOnboardingDeps = {},
): Promise<{ url: string; tokenIssued: boolean } | null> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    runtime.error(
      `Config invalid. Run \`${formatCliCommand("bitterbot doctor")}\` to repair it, then re-run onboarding.`,
    );
    runtime.exit(1);
    return null;
  }
  const cfg = loadConfig();
  const port = resolveGatewayPort(cfg);
  const basePath = cfg.gateway?.controlUi?.basePath;

  const listening = await (deps.isListening ?? isPortListening)(port);
  if (!listening) {
    if (surface.inContainer) {
      runtime.error(
        `The gateway is not running on port ${port}. Start it with \`docker compose up -d\`, then run this again.`,
      );
      runtime.exit(1);
      return null;
    }
    const started = (deps.startGateway ?? spawnSetupGateway)(port);
    runtime.log(
      `Starting the gateway for setup on 127.0.0.1:${port} (pid ${started.pid ?? "?"}, log ${started.logPath})...`,
    );
    const ready = await (deps.waitForGateway ?? ((p) => waitForPort(p, 90_000)))(port);
    if (!ready) {
      runtime.error(
        `The gateway did not start within 90 seconds. Check ${started.logPath}, or run \`${formatCliCommand("bitterbot onboard --no-browser")}\` for the terminal setup.`,
      );
      runtime.exit(1);
      return null;
    }
  }

  const alreadySetUp = snapshot.exists && !isFirstBootOnlyConfig(snapshot.resolved);
  let url: string;
  if (alreadySetUp) {
    // A setup token cannot re-run a finished setup; the admin sign-in can
    // (a browser on this machine is signed in automatically).
    url = buildSetupUrl({ port, basePath });
    runtime.log(
      [
        "Bitterbot is already set up. To run setup again, open this page in the Control UI",
        "(a browser on this machine signs in automatically; elsewhere use the gateway token):",
        `  ${url}`,
      ].join("\n"),
    );
  } else {
    const { token } = issueSetupToken();
    url = buildSetupUrl({ port, basePath, token });
    const minutes = Math.round(SETUP_TOKEN_TTL_MS / 60_000);
    runtime.log(
      [
        "",
        `Finish setup in your browser (link valid ${minutes} minutes, works once):`,
        `  ${url}`,
        ...(surface.inContainer
          ? ["  (if you mapped a different host port, use that port in the link)"]
          : []),
        ...(surface.headless && !surface.inContainer
          ? [
              "No browser here. From your own computer, forward the port first:",
              `  ssh -N -L ${port}:127.0.0.1:${port} <this-host>`,
              "then open the link above there.",
            ]
          : []),
        `Prefer the terminal? ${formatCliCommand("bitterbot onboard --no-browser")}`,
        "",
      ].join("\n"),
    );
  }

  if (surface.open) {
    const open = deps.openUrl ?? (await import("./onboard-helpers.js")).openUrl;
    const opened = await open(url).catch(() => false);
    if (!opened) {
      runtime.log("Could not open a browser automatically; open the link above.");
    }
  }
  return { url, tokenIssued: !alreadySetUp };
}

/** The real environment for `resolveOnboardSurface`. */
export function detectOnboardEnvironment(): {
  stdinIsTty: boolean;
  inContainer: boolean;
  remote: boolean;
} {
  return {
    stdinIsTty: Boolean(process.stdin.isTTY),
    inContainer: readDeclaredInstallKind() === "container" || looksLikeContainer(),
    remote: isRemoteEnvironment(),
  };
}
