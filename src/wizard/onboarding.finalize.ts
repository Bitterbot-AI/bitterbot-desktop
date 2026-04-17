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
} from "../commands/onboard-helpers.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
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
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note(
      "Systemd user services are unavailable. Skipping lingering checks and service install.",
      "Systemd",
    );
  }

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
    await prompter.note(
      "Systemd user services are unavailable; skipping service install.\n" +
        "Start the gateway manually: `pnpm start gateway` (one-shot) or `pnpm dev:all` (dev + Control UI).\n" +
        "On WSL2, leave the terminal open or use tmux/screen. On Docker, use your container supervisor.",
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

  // The Control UI is the `desktop/` React SPA served by Vite on port 5173.
  // The gateway (port 19001) is the WebSocket API backend — not user-facing.
  // `pnpm dev:all` starts both in one terminal.
  const CONTROL_UI_PORT = 5173;
  const controlUiUrl = `http://localhost:${CONTROL_UI_PORT}/`;
  const gatewayWsUrl = `ws://127.0.0.1:${settings.port}`;

  const gatewayProbe = await probeGatewayReachable({
    url: gatewayWsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
  });

  await prompter.note(
    [
      `Control UI:   ${controlUiUrl}`,
      `Gateway API:  ${gatewayWsUrl}`,
      gatewayProbe.ok
        ? "Gateway: reachable"
        : "Gateway: not running (start with `pnpm dev:all` or `pnpm start gateway`)",
      "",
      "The Control UI is the Bitterbot interface — chat, dreams, skills, marketplace.",
      "The gateway is the backend API. Both must be running.",
      "",
      "Start both in one terminal:  pnpm dev:all",
      "Or separately:               pnpm gateway:watch  +  cd desktop && pnpm dev",
    ].join("\n"),
    "Control UI",
  );

  let controlUiOpened = false;

  let spawnedDevAll = false;
  if (!opts.skipUi) {
    // If the gateway isn't reachable and daemon install was skipped (WSL, or
    // user declined), offer to spawn `pnpm dev:all` right here so the user
    // doesn't have to open a second terminal and remember the command.
    const canSpawnDevAll = !gatewayProbe.ok && !installDaemon;
    const hatchChoice = await prompter.select({
      message: canSpawnDevAll ? "Ready to fire it up?" : "Open the Control UI now?",
      options: canSpawnDevAll
        ? [
            {
              value: "spawn",
              label: "Start gateway + Control UI now",
              hint: "Runs `pnpm dev:all` in the background and opens the browser",
            },
            {
              value: "web",
              label: "Just open the browser",
              hint: "I'll start the gateway myself",
            },
            { value: "later", label: "Not now — I'll handle it" },
          ]
        : [
            { value: "web", label: "Yes — open in my browser", hint: controlUiUrl },
            { value: "later", label: "Not now — I'll start things myself" },
          ],
      initialValue: canSpawnDevAll ? "spawn" : "web",
    });

    if (hatchChoice === "spawn") {
      // Spawn `pnpm dev:all` detached so it survives the wizard exiting.
      // stdio is ignored so the wizard's exit doesn't pipe-break the child.
      try {
        const { spawn } = await import("node:child_process");
        const { detectBrowserOpenSupport, openUrl } =
          await import("../commands/onboard-helpers.js");
        const devAll = spawn("pnpm", ["dev:all"], {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
          shell: process.platform === "win32",
          env: process.env,
        });
        devAll.unref();
        spawnedDevAll = true;

        await prompter.note(
          [
            "Started gateway + Control UI in the background.",
            "Both may take ~10 seconds to be ready.",
            "",
            "Follow logs later with: `pnpm dev:all` in a terminal (will reconnect).",
            "Stop everything: `pkill -f 'bitterbot-gateway|vite'`",
          ].join("\n"),
          "Starting up",
        );

        // Give them ~4s to come up, then open browser
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const browserSupport = await detectBrowserOpenSupport();
        if (browserSupport.ok) {
          controlUiOpened = await openUrl(controlUiUrl);
        }
        await prompter.note(
          controlUiOpened
            ? `Opened ${controlUiUrl} in your browser. If it shows a blank page, wait a few seconds and refresh — Vite takes a moment to boot.`
            : `Open this URL when ready: ${controlUiUrl}`,
          "Control UI",
        );
      } catch (err) {
        await prompter.note(
          [
            `Couldn't spawn dev:all: ${err instanceof Error ? err.message : String(err)}`,
            "Run it manually: pnpm dev:all",
            `Then open: ${controlUiUrl}`,
          ].join("\n"),
          "Start failed",
        );
      }
    } else if (hatchChoice === "web") {
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
          !gatewayProbe.ok
            ? "The gateway isn't running yet. Start it:\n  pnpm dev:all"
            : "The gateway is running. If the Control UI shows 'Disconnected', verify\n" +
              "  desktop/.env has the correct VITE_GATEWAY_TOKEN.",
        ].join("\n"),
        "Dashboard",
      );
    } else {
      await prompter.note(
        [
          "When you're ready:",
          "  pnpm dev:all                          # starts gateway + Control UI",
          `  Then open: ${controlUiUrl}`,
        ].join("\n"),
        "Later",
      );
    }
  } else {
    await prompter.note("Skipping Control UI prompts.", "Control UI");
  }

  await prompter.note(
    [
      "Back up your agent workspace.",
      "Docs: https://docs.bitterbot.ai/concepts/agent-workspace",
    ].join("\n"),
    "Workspace backup",
  );

  await prompter.note(
    "Running agents on your computer is risky — harden your setup: https://docs.bitterbot.ai/security",
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
      "If you're developing locally and want hot-reload on the Control UI:",
      "  - Single terminal: `pnpm dev:all` (gateway + Vite, color-tagged logs)",
      "  - Two terminals: `pnpm gateway:watch` + `cd desktop && pnpm dev`",
      "",
      "When something feels off: `bitterbot doctor` walks ~25 subsystem checks.",
    ].join("\n"),
    "What now",
  );

  await prompter.outro(
    spawnedDevAll
      ? `Setup done. Gateway + Control UI starting in the background; ${controlUiUrl} should load in a few seconds.`
      : controlUiOpened
        ? `Setup done. Control UI is at ${controlUiUrl} — start the gateway with \`pnpm dev:all\` if it's not running.`
        : `Setup done. Run \`pnpm dev:all\` then open ${controlUiUrl} to drive Bitterbot.`,
  );

  return { launchedTui: false };
}
