/**
 * `bitterbot onboard` in the browser (PLAN-56 Phase 4).
 *
 * Starts the gateway when nothing listens on its port (or reuses the running
 * one: a service, a container), mints a setup token (30 minutes at most,
 * until setup finishes; wizard scope only; src/gateway/setup-token.ts) and
 * prints, then opens,
 * `http://127.0.0.1:<port><basePath>/setup?token=...`. The Control UI's setup
 * page runs the same steps as the terminal QuickStart over `wizard.*`.
 *
 * Surface choice: `--no-browser` keeps the terminal wizard; `--browser`
 * forces the setup page. Without either, the setup page is the default, and
 * the link is opened when a browser is available and stdin is a terminal;
 * headless, SSH and container sessions print the link instead. Flags that
 * only the terminal wizard understands (--flow, --mode, --auth-choice and
 * the provider key, gateway and daemon flags, --json and the --skip-* flags)
 * keep the terminal wizard. Without a terminal (stdin not a TTY) the default
 * is an error rather than a background gateway nobody asked for: scripts pass
 * --browser (print the link) or --non-interactive.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig, readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  buildSetupUrl,
  issueSetupToken,
  SETUP_TOKEN_TTL_MS,
  setupInProgress,
} from "../gateway/setup-token.js";
import { looksLikeContainer, readDeclaredInstallKind } from "../infra/install-kind.js";
import { withoutInstallerEnv } from "../infra/installer-env.js";
import type { RuntimeEnv } from "../runtime.js";
import { isSetUpSnapshot } from "../wizard/onboarding.first-boot.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import type { OnboardOptions } from "./onboard-types.js";

export type OnboardSurface =
  | { kind: "terminal" }
  | { kind: "browser"; open: boolean; headless: boolean; inContainer: boolean }
  | { kind: "no-terminal"; message: string };

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

/** Switches the CLI always passes (false when absent): they count when on. */
const TERMINAL_ONLY_SWITCHES: Array<keyof OnboardOptions> = [
  "json",
  "skipChannels",
  "skipProviders",
  "skipHealth",
  "skipSkills",
  "skipUi",
];

/** True when a flag only the terminal wizard (or --non-interactive) honours is set. */
export function hasTerminalOnlyFlag(opts: OnboardOptions): boolean {
  return (
    TERMINAL_ONLY_KEYS.some((key) => opts[key] !== undefined) ||
    TERMINAL_ONLY_SWITCHES.some((key) => opts[key] === true)
  );
}

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
  if (opts.browser !== true && hasTerminalOnlyFlag(opts)) {
    return { kind: "terminal" };
  }
  if (opts.browser !== true && !params.stdinIsTty && !params.inContainer) {
    return {
      kind: "no-terminal",
      message: [
        "`bitterbot onboard` needs a terminal to choose a setup surface, and none is attached.",
        "Print a browser setup link instead (starts the gateway in the background if needed):",
        "  bitterbot onboard --browser",
        "Or set up without prompts:",
        "  bitterbot onboard --non-interactive --accept-risk --anthropic-api-key <key>",
      ].join("\n"),
    };
  }
  const headless = params.inContainer || params.remote;
  return {
    kind: "browser",
    open: !headless && params.stdinIsTty,
    headless,
    inContainer: params.inContainer,
  };
}

export { buildSetupUrl };

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
    // Unsupervised: if setup installs the gateway service, this process
    // hands its port over at Finish (src/infra/setup-handover.ts).
    { detached: true, stdio: ["ignore", fd, fd], env: withoutInstallerEnv(process.env) },
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

/** What `bitterbot gateway switch --check` would say about the gateway on the port. */
export type OnboardGatewayCheck = {
  /** The listener is a Bitterbot gateway from another install (older or different). */
  otherInstall: boolean;
  /** Something that must not be linked to (a foreign program, an unidentifiable gateway). */
  blocked: string | null;
  /** Plain-language lines describing what was found. */
  summary: string[];
  /** This install's version. */
  version: string | null;
};

async function defaultCheckGateway(port: number): Promise<OnboardGatewayCheck> {
  const { detectGatewaySwitch } = await import("../infra/gateway-switch-system.js");
  const { describeFindings } = await import("../cli/daemon-cli/switch.js");
  const { findings, decision } = await detectGatewaySwitch({ port });
  const listener = findings.listener;
  return {
    otherInstall: Boolean(listener?.isGateway && !listener.isSelf),
    blocked: decision.action === "blocked" && listener ? decision.message : null,
    summary: describeFindings(findings, decision),
    version: findings.self.version,
  };
}

export type BrowserOnboardingDeps = {
  /** Check who serves the port before linking to it (src/infra/gateway-switch.ts). */
  checkGateway?: (port: number) => Promise<OnboardGatewayCheck>;
  /** Run `bitterbot gateway switch` interactively; returns its exit code. */
  switchGateway?: () => Promise<number>;
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
  // Never link to a gateway from another install (a git clone, an older
  // release): pre-1.5 gateways have no setup page, and setup would configure
  // the old code. Offer the switch instead. A test that fakes isListening
  // never runs the real process inspection.
  const checkGateway =
    deps.checkGateway ?? (deps.isListening || surface.inContainer ? null : defaultCheckGateway);
  // Set after a successful `gateway switch` here: an upgrade, not a setup.
  let switchedTo: { version: string | null } | null = null;
  if (listening && checkGateway) {
    const check = await checkGateway(port).catch(() => null);
    if (check?.blocked) {
      runtime.error(check.blocked);
      runtime.exit(1);
      return null;
    }
    if (check?.otherInstall) {
      const interactive = deps.stdinIsTty ?? Boolean(process.stdin.isTTY);
      if (!interactive || opts.fromInstaller) {
        runtime.log(
          [
            ...check.summary,
            `Not opening its setup page. To switch to ${check.version ?? "this version"}, run:`,
            `  ${formatCliCommand("bitterbot gateway switch")}`,
            `then run \`${formatCliCommand("bitterbot onboard")}\` again.`,
          ].join("\n"),
        );
        return null;
      }
      const code = await (deps.switchGateway ?? defaultSwitchGateway)();
      if (code !== 0) {
        return null;
      }
      switchedTo = { version: check.version };
    }
  }
  // A browser setup that lost its session before Finish is not "set up".
  const alreadySetUp = isSetUpSnapshot(snapshot, { setupInProgress: setupInProgress() });
  if (!listening && alreadySetUp && opts.fromInstaller) {
    // Set up, but no gateway runs: say how to start it rather than starting
    // a setup gateway with setup-only flags.
    runtime.log(
      [
        "Bitterbot is already set up. Start it with:",
        `  ${formatCliCommand("bitterbot gateway")}`,
        `or keep it running in the background (starts on login): ${formatCliCommand("bitterbot gateway install")}`,
      ].join("\n"),
    );
    return null;
  }
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

  let url: string;
  if (alreadySetUp && switchedTo) {
    // Just switched a set-up install to this version: that is an upgrade,
    // so open the app, not the "run setup again" page.
    url = buildControlUiUrl({ port, basePath });
    runtime.log(
      [
        `You're now on Bitterbot ${switchedTo.version ?? "(this version)"}.`,
        `Open Bitterbot: ${url}`,
      ].join("\n"),
    );
  } else if (alreadySetUp && opts.fromInstaller) {
    // Straight from install.sh: no "already set up" detour, just the app.
    url = buildControlUiUrl({ port, basePath });
    runtime.log(`Open Bitterbot: ${url}`);
  } else if (alreadySetUp) {
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
        `Finish setup in your browser (link valid ${minutes} minutes, works until setup finishes):`,
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

async function defaultSwitchGateway(): Promise<number> {
  const { runGatewaySwitch } = await import("../cli/daemon-cli/switch.js");
  return await runGatewaySwitch({});
}

/** The Control UI's address on this machine. */
export function buildControlUiUrl(params: { port: number; basePath?: string }): string {
  const setup = buildSetupUrl({ port: params.port, basePath: params.basePath });
  return setup.slice(0, -"setup".length);
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
