import type { OnboardOptions } from "../commands/onboard-types.js";
import type { BitterbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { GatewayWizardSettings, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommand } from "../commands/health.js";
import {
  detectBrowserOpenSupport,
  openUrl,
  probeGatewayReachable,
  waitForGatewayReachable,
} from "../commands/onboard-helpers.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { resolveBitterbotPackageRoot } from "../infra/bitterbot-root.js";
import { formatDocsLink } from "../terminal/links.js";
import { setupOnboardingShellCompletion } from "./onboarding.completion.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: BitterbotConfig;
  nextConfig: BitterbotConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

export async function finalizeOnboardingWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, nextConfig, settings, prompter, runtime } = options;

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(options.doneMessage);
    }
  };

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  // On Linux without systemd (WSL2, containers, slim VMs) we silently skip
  // lingering + daemon install — the wizard's auto-spawn step later will
  // offer to run `pnpm dev:all`, so there's nothing the user needs to do
  // differently here. No upfront "systemd unavailable" note: we used to
  // fire one here AND another one in the daemon-install branch, which
  // read as two scary warnings for something that isn't actually wrong.

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason:
        "Linux installs use a systemd user service by default. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
      requireConfirm: false,
    });
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (process.platform === "linux" && !systemdAvailable) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message:
        "Install the gateway as a system service? (recommended — it stays running, restarts after reboots, dreams happen even when you forget about it)",
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    // Explicit --install-daemon on a host without systemd: quick heads-up
    // then fall through to the auto-spawn offer. Deliberately does NOT
    // tell the user to run pnpm dev:all themselves — the finalize step
    // below asks if they want us to spawn it for them.
    await prompter.note(
      "No systemd here — can't install a background service. I'll offer to start the gateway + Control UI for you in a moment.",
      "Gateway service",
    );
    installDaemon = false;
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? DEFAULT_GATEWAY_DAEMON_RUNTIME
        : await prompter.select({
            message: "Gateway service runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          });
    if (flow === "quickstart") {
      await prompter.note(
        "QuickStart uses Node for the Gateway service (stable + supported).",
        "Gateway service runtime",
      );
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (loaded) {
      const action = await prompter.select({
        message: "A gateway service is already installed. What now?",
        options: [
          { value: "restart", label: "Restart it", hint: "Pick up new config without reinstall" },
          { value: "reinstall", label: "Reinstall", hint: "Replace the service definition" },
          { value: "skip", label: "Leave it alone", hint: "Don't touch the existing service" },
        ],
      });
      if (action === "restart") {
        await withWizardProgress(
          "Gateway service",
          { doneMessage: "Gateway service restarted." },
          async (progress) => {
            progress.update("Restarting Gateway service…");
            await service.restart({
              env: process.env,
              stdout: process.stdout,
            });
          },
        );
      } else if (action === "reinstall") {
        await withWizardProgress(
          "Gateway service",
          { doneMessage: "Gateway service uninstalled." },
          async (progress) => {
            progress.update("Uninstalling Gateway service…");
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (!loaded || (loaded && !(await service.isLoaded({ env: process.env })))) {
      const progress = prompter.progress("Gateway service");
      let installError: string | null = null;
      try {
        progress.update("Preparing Gateway service…");
        const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
          env: process.env,
          port: settings.port,
          token: settings.gatewayToken,
          runtime: daemonRuntime,
          warn: (message, title) => prompter.note(message, title),
          config: nextConfig,
        });

        progress.update("Installing Gateway service…");
        await service.install({
          env: process.env,
          stdout: process.stdout,
          programArguments,
          workingDirectory,
          environment,
        });
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
      } finally {
        progress.stop(
          installError ? "Gateway service install failed." : "Gateway service installed.",
        );
      }
      if (installError) {
        await prompter.note(`Gateway service install failed: ${installError}`, "Gateway");
        await prompter.note(gatewayInstallErrorHint(), "Gateway");
      }
    }
  }

  if (!opts.skipHealth && installDaemon) {
    const probeWsUrl = `ws://127.0.0.1:${settings.port}`;
    try {
      // Daemon install/restart can briefly flap the WS; give it a moment.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(
        [
          `Gateway not responding at ${probeWsUrl}.`,
          "If you just installed the daemon, it may still be starting.",
          "Run `bitterbot health` in a minute to re-check.",
        ].join("\n"),
        "Health check",
      );
    }
  }

  await prompter.note(
    [
      "Add nodes for extra features:",
      "- macOS app (system + notifications)",
      "- iOS app (camera/canvas)",
      "- Android app (camera/canvas)",
    ].join("\n"),
    "Optional apps",
  );

  // Since PLAN-39 Phase 4 the gateway serves the Control UI itself, so the UI
  // and the API share one origin and one process. Vite on 5173 is dev-only.
  const controlUiUrl = `http://127.0.0.1:${settings.port}/`;
  const gatewayWsUrl = `ws://127.0.0.1:${settings.port}`;

  // Resolve the Bitterbot repo root once. Only when it's present (and has a
  // stack-launcher script) do we auto-spawn — a global npm install of
  // bitterbot has no repo to run `pnpm start:all` in.
  const repoRoot = await resolveBitterbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  // Prefer the production launcher (`start:all`: plain gateway boot + Vite,
  // skips whatever is already up). Fall back to `dev:all` (watch mode) only if
  // start:all is absent, so older checkouts still work.
  const startAllAvailable = await hasScript(repoRoot, "start:all");
  const devAllAvailable = await hasScript(repoRoot, "dev:all");
  const stackCommand = startAllAvailable ? "start:all" : devAllAvailable ? "dev:all" : null;

  // No desktop/.env any more (PLAN-39 Phase 4): the served UI derives the
  // gateway URL from its own origin and fetches the token from the same-origin
  // handoff endpoint, so there is nothing to pre-wire.

  const gatewayProbe = await probeGatewayReachable({
    url: gatewayWsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
  });

  await prompter.note(
    [
      `Control UI:   ${controlUiUrl}`,
      `Gateway API:  ${gatewayWsUrl}`,
      gatewayProbe.ok ? "Gateway: reachable" : "Gateway: starting up",
      "",
      "The Control UI is the Bitterbot interface — chat, dreams, skills, marketplace.",
      "The gateway serves it directly: one process, one port.",
    ].join("\n"),
    "Control UI",
  );

  let controlUiOpened = false;
  let spawnedStack = false;

  if (opts.skipUi) {
    await prompter.note("Skipping Control UI startup.", "Control UI");
  } else if (repoRoot && stackCommand && installDaemon) {
    // A service manager owns the gateway, and the gateway serves the Control UI
    // itself (PLAN-39 Phase 4) — so there is NOTHING left to spawn. Spawning
    // start:all here would exit 0 within a second ("nothing to start") and trip
    // the early-exit failure detector for a perfectly healthy setup. Just wait
    // for the service's gateway and open the UI it serves.
    const probe = await waitForGatewayReachable({
      url: gatewayWsUrl,
      token: settings.authMode === "token" ? settings.gatewayToken : undefined,
      password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : undefined,
      deadlineMs: 90_000,
      pollMs: 1000,
    });
    spawnedStack = true;
    if (probe.ok) {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(controlUiUrl);
      }
      await prompter.note(
        controlUiOpened
          ? `Opened ${controlUiUrl} in your browser.`
          : `Gateway is up. Open this URL when ready: ${controlUiUrl}`,
        "Control UI",
      );
    } else {
      await prompter.note(
        [
          "The gateway service hadn't finished booting when the 90-second wait",
          `window expired. Give it another minute, then open: ${controlUiUrl}`,
        ].join("\n"),
        "Still starting",
      );
    }
  } else if (repoRoot && stackCommand) {
    // Bring the gateway up automatically so the wizard finishes with it (and
    // the Control UI it serves) already running — nothing for the user to
    // type. `start:all` is idempotent (skips an already-listening gateway). If
    // the primary launcher fails to spawn, silently retry with watch-mode
    // `dev:all` as a hidden backup.
    let outcome = await spawnStackHardened({
      command: stackCommand,
      repoRoot,
      gatewayWsUrl,
      settings,
      nextConfig,
      prompter,
    });
    if (!outcome.spawned && stackCommand !== "dev:all" && devAllAvailable) {
      outcome = await spawnStackHardened({
        command: "dev:all",
        repoRoot,
        gatewayWsUrl,
        settings,
        nextConfig,
        prompter,
      });
    }
    spawnedStack = outcome.spawned;
    if (spawnedStack && outcome.gatewayUp) {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(controlUiUrl);
      }
      await prompter.note(
        controlUiOpened
          ? `Opened ${controlUiUrl} in your browser. The Control UI may take a moment to finish hydrating — refresh if it's blank.`
          : `Gateway is up. Open this URL when ready: ${controlUiUrl}`,
        "Control UI",
      );
    } else if (spawnedStack) {
      await prompter.note(
        [
          "The stack is starting in the background, but the gateway hadn't finished",
          "booting when the 90-second wait window expired — cold starts on a fresh",
          "checkout can run over a minute (first-run bundle plus the P2P orchestrator",
          "and channel plugins warming up).",
          "",
          `Give it another minute, then open: ${controlUiUrl}`,
          "",
          `Tail the live logs: tail -f ${outcome.logPath}`,
          `Or run it in a terminal: cd ${repoRoot} && pnpm ${stackCommand}`,
        ].join("\n"),
        "Still starting",
      );
    }
    // outcome.spawned === false: spawnStackHardened already surfaced the failure
    // note (log tail + the exact command to run by hand).
  } else {
    // Global install / no repo checkout — nothing to spawn. Open the browser
    // and point at the production start command.
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(controlUiUrl);
    }
    await prompter.note(
      [
        controlUiOpened
          ? `Opened ${controlUiUrl} in your browser.`
          : `Open this URL in your browser: ${controlUiUrl}`,
        "",
        gatewayProbe.ok
          ? "The gateway is running. If the Control UI shows 'Disconnected', reload\n  the page; it fetches its session token from the gateway it was served by."
          : "Start the gateway when ready:\n  pnpm start gateway",
      ].join("\n"),
      "Dashboard",
    );
  }

  await prompter.note(
    [
      "Back up your agent workspace.",
      `Docs: ${formatDocsLink("/memory/architecture-overview.md", "Memory Architecture")}`,
    ].join("\n"),
    "Workspace backup",
  );

  await prompter.note(
    `Running agents on your computer is risky — harden your setup: ${formatDocsLink(
      "/security/",
      "Security guide",
    )}`,
    "Security",
  );

  await setupOnboardingShellCompletion({ flow, prompter });

  // If we haven't already prompted to open the Control UI above (e.g.
  // because skipUi was not set but the earlier hatch prompt was shown),
  // this is a no-op. The Control UI URL and guidance were already shown.

  // Web search status note — simplified since the wizard now prompts
  // for the key inline. This just confirms what the user set up.
  {
    const searchProvider = nextConfig.tools?.web?.search?.provider ?? "brave";
    const searchCfg = nextConfig.tools?.web?.search;
    const providerEnvVars: Record<string, string> = {
      brave: "BRAVE_API_KEY",
      perplexity: "PERPLEXITY_API_KEY",
      grok: "XAI_API_KEY",
      tavily: "TAVILY_API_KEY",
    };
    const envVar = providerEnvVars[searchProvider] ?? "BRAVE_API_KEY";
    const configKey =
      searchProvider === "brave"
        ? searchCfg?.apiKey
        : (searchCfg as Record<string, Record<string, unknown>> | undefined)?.[searchProvider]
            ?.apiKey;
    const webSearchKey = (typeof configKey === "string" ? configKey : "").trim();
    const webSearchEnv = (process.env[envVar] ?? "").trim();
    const hasWebSearchKey = Boolean(webSearchKey || webSearchEnv);
    if (!hasWebSearchKey) {
      await prompter.note(
        [
          "Web search is not yet configured. Your agent won’t be able to look",
          "things up online — the curiosity engine and dream research mode",
          "will be limited to what’s in memory.",
          "",
          `Set it up later: ${formatCliCommand("bitterbot configure --section web")}`,
          `Or just export ${envVar} in the gateway environment.`,
        ].join("\n"),
        "Web search (not configured)",
      );
    }
  }

  // Ask for a star while we still have their attention — the wizard is
  // the one moment every new operator passes through at peak engagement
  // (agent just came to life). Friendly, skippable, and offers to open
  // the page for users whose browser is already supported. Non-interactive
  // runs (opts.skipUi) skip entirely so CI/automation pipelines stay quiet.
  if (!opts.skipUi) {
    const repoUrl = "https://github.com/Bitterbot-AI/bitterbot-desktop";
    const wantStar = await prompter.confirm({
      message: `If Bitterbot earned its keep, a GitHub star goes a long way — stars are how other operators find the project. Open ${repoUrl} in your browser?`,
      initialValue: true,
    });
    if (wantStar) {
      const { detectBrowserOpenSupport, openUrl } = await import("../commands/onboard-helpers.js");
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        const opened = await openUrl(repoUrl);
        if (!opened) {
          await prompter.note(`Couldn't open a browser here. Star manually: ${repoUrl}`, "Star");
        }
      } else {
        await prompter.note(
          `No browser available in this shell. Star manually: ${repoUrl}`,
          "Star",
        );
      }
    }
  }

  await prompter.note(
    [
      "Your agent is alive. A few good first moves:",
      "",
      "  1. Open the Control UI and have a real conversation —",
      "     the dream engine learns from session content, not from prompts.",
      "  2. Tune your GENOME.md (workspace root) — set hormonal baselines,",
      "     core values, and immutable safety axioms. The Phenotype evolves",
      "     within these constraints.",
      "  3. Fund the wallet with a small float you can afford to lose.",
      "     `bitterbot wallet status` shows the address; send a few USDC on Base.",
      "  4. Browse the marketplace once dreams have run a few cycles —",
      "     `bitterbot skills marketplace`.",
      "  5. See what other operators are building: https://github.com/Bitterbot-AI/bitterbot-desktop/discussions",
      "",
      "Bring the stack up yourself anytime: `pnpm start:all` (gateway + Control UI).",
      "Developing and want hot-reload? `pnpm dev:all` runs both in watch mode.",
      "",
      "When something feels off: `bitterbot doctor` walks ~25 subsystem checks.",
    ].join("\n"),
    "What now",
  );

  await prompter.outro(
    spawnedStack
      ? `Setup done. Gateway + Control UI starting in the background; ${controlUiUrl} should load in a few seconds.`
      : controlUiOpened
        ? `Setup done. Control UI is at ${controlUiUrl} — run \`pnpm start:all\` if the gateway isn't up.`
        : `Setup done. Run \`pnpm start:all\` then open ${controlUiUrl} to drive Bitterbot.`,
  );

  return { launchedTui: false };
}

/**
 * Verify the repo root defines the given pnpm script. If this returns false,
 * the wizard won't try to auto-spawn it — no point pretending to launch
 * something that would silently fail (e.g. a global npm install has no repo).
 */
async function hasScript(repoRoot: string | null, name: string): Promise<boolean> {
  if (!repoRoot) {
    return false;
  }
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

type SpawnOutcome = {
  spawned: boolean;
  gatewayUp: boolean;
  logPath: string;
};

/**
 * Spawn a stack-launcher pnpm script (`start:all` in production, or `dev:all`
 * as the watch-mode fallback) as a background process, poll the gateway until
 * it responds, and report the outcome. Hardened vs. a fire-and-forget spawn in
 * three ways:
 *
 *   1. Uses the resolved repo root as cwd (not process.cwd() which could be
 *      anywhere — the user may have installed Bitterbot globally).
 *   2. Redirects stderr to a log file under the OS temp dir so "silent
 *      failure" becomes "failure with a path to read". The path is returned
 *      so the wizard can show it in the error note.
 *   3. Polls the gateway WS endpoint with waitForGatewayReachable instead of
 *      a blind sleep — opens the browser only when the gateway actually
 *      answers, giving the build + Vite + orchestrator time to warm up.
 *
 * On Windows, shell=true is required so the `pnpm` PATH shim (pnpm.cmd) is
 * resolved. On macOS/Linux we spawn pnpm directly.
 */
async function spawnStackHardened(params: {
  command: string;
  repoRoot: string;
  gatewayWsUrl: string;
  settings: GatewayWizardSettings;
  nextConfig: BitterbotConfig;
  prompter: WizardPrompter;
}): Promise<SpawnOutcome> {
  const { command, repoRoot, gatewayWsUrl, settings, nextConfig, prompter } = params;
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const logDir = path.join(os.tmpdir(), "bitterbot-wizard");
  await fsp.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${command.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, "w");

  // Pin the gateway port the launcher probes/starts to the configured one, so
  // start:all's "already up?" check matches this node's actual gateway port.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BITTERBOT_GATEWAY_PORT: String(settings.port),
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("pnpm", [command], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      shell: process.platform === "win32",
      env: childEnv,
    });
  } catch (err) {
    fs.closeSync(logFd);
    await prompter.note(
      [
        `Couldn't spawn \`pnpm ${command}\`: ${err instanceof Error ? err.message : String(err)}`,
        "Run it yourself:",
        `  cd ${repoRoot} && pnpm ${command}`,
      ].join("\n"),
      "Start failed",
    );
    return { spawned: false, gatewayUp: false, logPath };
  }

  // Close our file descriptor — the child owns its duplicate now. Avoids
  // a leak if the child outlives the wizard.
  fs.closeSync(logFd);

  // Detect early exit — if pnpm dies within ~2s the spawn probably hit a
  // missing pnpm, a broken script, or an immediate build failure.
  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
  const exitRef: { value: ExitInfo | null } = { value: null };
  child.on("exit", (code, signal) => {
    exitRef.value = { code, signal };
  });

  await prompter.note(
    [
      `Started \`pnpm ${command}\` in the background.`,
      "Waiting for the gateway to respond…",
      "",
      `Logs streaming to: ${logPath}`,
    ].join("\n"),
    "Starting up",
  );

  // Give the process a beat to fail fast if it's going to
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const exited = exitRef.value;
  if (exited) {
    const tail = await readTail(logPath, 20);
    await prompter.note(
      [
        `\`pnpm ${command}\` exited early (code=${exited.code ?? "null"}, signal=${
          exited.signal ?? "null"
        }).`,
        "",
        tail ? `Last log lines:\n${tail}` : `Log: ${logPath}`,
        "",
        `Common causes: pnpm not on PATH, port ${settings.port} already in use, or a build error.`,
        `Run it yourself to see the full output: cd ${repoRoot} && pnpm ${command}`,
      ].join("\n"),
      "Start failed",
    );
    return { spawned: false, gatewayUp: false, logPath };
  }

  // Detach after we've confirmed it's alive — survives wizard exit.
  child.unref();

  // Now poll the gateway WS. Cold start on a fresh clone includes:
  //   - tsdown full build (~15s of 294 chunks)
  //   - gateway bootstrap (channels, hooks, heartbeat, canvas mount)
  //   - P2P orchestrator handshake (IPC + DNS bootstrap + management auth)
  // Measured end-to-end ~60s on WSL2; 90s gives comfortable headroom.
  // If we bail early the gateway is probably still coming up — we surface
  // the log path so the user can confirm rather than assume failure.
  const probe = await waitForGatewayReachable({
    url: gatewayWsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : undefined,
    deadlineMs: 90_000,
    pollMs: 1000,
  });

  return { spawned: true, gatewayUp: probe.ok, logPath };
}

async function readTail(logPath: string, lineCount: number): Promise<string> {
  try {
    const fs = await import("node:fs/promises");
    const body = await fs.readFile(logPath, "utf8");
    const lines = body.split("\n");
    return lines.slice(-lineCount).join("\n").trim();
  } catch {
    return "";
  }
}
