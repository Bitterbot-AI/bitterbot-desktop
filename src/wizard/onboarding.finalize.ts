import fs from "node:fs/promises";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { BitterbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { GatewayWizardSettings, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
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
  formatControlUiSshHint,
  openUrl,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { resolveUserPath } from "../utils.js";
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
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;

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

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.gatewayToken,
      deadlineMs: 15_000,
    });
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(
        [
          "Docs:",
          "https://docs.bitterbot.ai/gateway/health",
          "https://docs.bitterbot.ai/gateway/troubleshooting",
        ].join("\n"),
        "Health check help",
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

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
  });
  const authedUrl =
    settings.authMode === "token" && settings.gatewayToken
      ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}`
      : links.httpUrl;
  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? "Gateway: reachable"
    : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
  const bootstrapPath = path.join(
    resolveUserPath(options.workspaceDir),
    DEFAULT_BOOTSTRAP_FILENAME,
  );
  const _hasBootstrap = await fs
    .access(bootstrapPath)
    .then(() => true)
    .catch(() => false);

  await prompter.note(
    [
      `Web UI: ${links.httpUrl}`,
      settings.authMode === "token" && settings.gatewayToken
        ? `Web UI (with token): ${authedUrl}`
        : undefined,
      `Gateway WS: ${links.wsUrl}`,
      gatewayStatusLine,
      "Docs: https://docs.bitterbot.ai/web/control-ui",
    ]
      .filter(Boolean)
      .join("\n"),
    "Control UI",
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "web" | "later" | null = null;

  if (!opts.skipUi && gatewayProbe.ok) {
    await prompter.note(
      [
        "Gateway token: shared auth for the Gateway + Control UI.",
        "Stored in: ~/.bitterbot/bitterbot.json (gateway.auth.token) or BITTERBOT_GATEWAY_TOKEN.",
        `View token: ${formatCliCommand("bitterbot config get gateway.auth.token")}`,
        `Generate token: ${formatCliCommand("bitterbot doctor --generate-gateway-token")}`,
        "Web UI stores a copy in this browser's localStorage (bitterbot.control.settings.v1).",
        `Open the dashboard anytime: ${formatCliCommand("bitterbot dashboard --no-open")}`,
        "If prompted: paste the token into Control UI settings (or use the tokenized dashboard URL).",
      ].join("\n"),
      "Token",
    );

    hatchChoice = await prompter.select({
      message: "How do you want to hatch your bot?",
      options: [
        { value: "web", label: "Open the Web UI (recommended)" },
        { value: "later", label: "Do this later" },
      ],
      initialValue: "web",
    });

    if (hatchChoice === "web") {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        });
      }
      await prompter.note(
        [
          `Dashboard link (with token): ${authedUrl}`,
          controlUiOpened
            ? "Opened in your browser. Keep that tab to control Bitterbot."
            : "Copy/paste this URL in a browser on this machine to control Bitterbot.",
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        "Dashboard ready",
      );
    } else {
      await prompter.note(
        `When you're ready: ${formatCliCommand("bitterbot dashboard --no-open")}`,
        "Later",
      );
    }
  } else if (opts.skipUi) {
    await prompter.note("Skipping Control UI/TUI prompts.", "Control UI");
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

  const shouldOpenControlUi =
    !opts.skipUi &&
    settings.authMode === "token" &&
    Boolean(settings.gatewayToken) &&
    hatchChoice === null;
  if (shouldOpenControlUi) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(authedUrl);
      if (!controlUiOpened) {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
    } else {
      controlUiOpenHint = formatControlUiSshHint({
        port: settings.port,
        basePath: controlUiBasePath,
        token: settings.gatewayToken,
      });
    }

    await prompter.note(
      [
        `Dashboard link (with token): ${authedUrl}`,
        controlUiOpened
          ? "Opened in your browser. Keep that tab to control Bitterbot."
          : "Copy/paste this URL in a browser on this machine to control Bitterbot.",
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      "Dashboard ready",
    );
  }

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
    controlUiOpened
      ? "Setup done. Dashboard's open — keep that tab to drive Bitterbot."
      : seededInBackground
        ? "Setup done. Control UI is seeding in the background; open it anytime via the dashboard link above."
        : "Setup done. Open the dashboard link above to drive Bitterbot.",
  );

  return { launchedTui: false };
}
