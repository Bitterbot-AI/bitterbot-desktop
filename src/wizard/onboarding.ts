import type {
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import type { BitterbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./onboarding.types.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  DEFAULT_GATEWAY_PORT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(
    [
      "Read this before going further.",
      "",
      "Bitterbot is in open beta. It remembers your life, runs real tools,",
      "moves real USDC, and talks to other agents on a live P2P mesh.",
      "That is the whole point — and it is also how you get hurt if you",
      "skip the safety rails.",
      "",
      "What this agent can actually do once you enable its tools:",
      "- Read and write files in its workspace",
      "- Run code, browse the web, execute shell commands",
      "- Send and receive messages on channels you connect (WhatsApp, Telegram, etc.)",
      "- Hold a USDC wallet on Base, pay for paywalled APIs via x402, receive payments",
      "- Publish skills to the P2P marketplace and ingest skills from other agents",
      "",
      "LLMs can be tricked. A malicious message, a hostile webpage, or a",
      "poisoned skill from the network can steer the agent toward actions",
      "you did not intend. Plan for that, not against it.",
      "",
      "Run Bitterbot at your own risk. We ship fast, patch fast, and trust",
      "operators to harden their own nodes. If basic security and access",
      "control are unfamiliar territory, pair with someone who can help",
      "before enabling tools, channels, or the wallet.",
      "",
      "Recommended baseline:",
      "- Pairing, allowlists, and mention gating for inbound messages.",
      "- Sandbox + least-privilege tools. Start minimal; expand as you trust it.",
      "- Keep secrets out of the agent's reachable filesystem (no .env in workspace).",
      "- Use the strongest model available for any bot with tools or untrusted inboxes.",
      "- Start the wallet with a small float you can afford to lose while you learn.",
      "- P2P skill ingestion defaults to 'review' — don't flip to 'auto' until you",
      "  have a trust list and understand the SkillVerifier + reputation gates.",
      "",
      "Run regularly:",
      "  bitterbot security audit --deep",
      "  bitterbot security audit --fix",
      "  bitterbot doctor",
      "",
      "Must read: https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/SECURITY.md",
    ].join("\n"),
    "Security — at your own risk",
  );

  const ok = await params.prompter.confirm({
    message:
      "I understand Bitterbot can act on my behalf, move funds, and connect to a live P2P network. I accept the risk. Continue?",
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError("risk not accepted");
  }
}

export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  // Silence the config-io audit log ("Config overwrite: sha256 ...") while
  // the wizard is running — the user is the one writing, so the forensic
  // line is pure noise in the clack output. io.ts keeps the log for
  // non-wizard callers (daemon, doctor, direct edits).
  const previousWizardQuiet = process.env.BITTERBOT_WIZARD_QUIET;
  process.env.BITTERBOT_WIZARD_QUIET = "1";
  try {
    await runOnboardingWizardInner(opts, runtime, prompter);
  } finally {
    if (previousWizardQuiet === undefined) {
      delete process.env.BITTERBOT_WIZARD_QUIET;
    } else {
      process.env.BITTERBOT_WIZARD_QUIET = previousWizardQuiet;
    }
  }
}

async function runOnboardingWizardInner(
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) {
  // Node version gate — runs before the intro so a bad-Node user gets only
  // the upgrade guidance and nothing else. The gateway uses Rolldown which
  // pulls in node:util#styleText (Node 20.12+); Node 18 fails with a
  // cryptic SyntaxError deep in startup, so we stop here instead of
  // walking the user through the whole wizard and then crashing at spawn.
  const { gateNodeVersion } = await import("./onboarding.node-version.js");
  await gateNodeVersion({ prompter, runtime });

  const onboardHelpers = await import("../commands/onboard-helpers.js");
  onboardHelpers.printWizardHeader(runtime);
  await prompter.intro("Bitterbot onboarding");
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: BitterbotConfig = snapshot.valid ? snapshot.config : {};

  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "Invalid config");
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.bitterbot.ai/gateway/configuration",
        ].join("\n"),
        "Config issues",
      );
    }
    await prompter.outro(
      `Config invalid. Run \`${formatCliCommand("bitterbot doctor")}\` to repair it, then re-run onboarding.`,
    );
    runtime.exit(1);
    return;
  }

  const quickstartHint = `Configure details later via ${formatCliCommand("bitterbot configure")}.`;
  const manualHint = "Configure port, network, Tailscale, and auth options.";
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced"
  ) {
    runtime.error("Invalid --flow (use quickstart, manual, or advanced).");
    runtime.exit(1);
    return;
  }
  const explicitFlow: WizardFlow | undefined =
    normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced"
      ? normalizedExplicitFlow
      : undefined;
  let flow: WizardFlow =
    explicitFlow ??
    (await prompter.select({
      message: "How do you want to set this up?",
      options: [
        { value: "quickstart", label: "QuickStart", hint: `Sane defaults; ${quickstartHint}` },
        { value: "advanced", label: "Manual", hint: `Walk every choice — ${manualHint}` },
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(
      "QuickStart only supports local gateways. Switching to Manual mode.",
      "QuickStart",
    );
    flow = "advanced";
  }

  if (snapshot.exists) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      "Existing config detected",
    );

    const action = await prompter.select({
      message: "We found an existing config. What should we do with it?",
      options: [
        { value: "keep", label: "Use what's there", hint: "Skip ahead, leave settings alone" },
        {
          value: "modify",
          label: "Update some values",
          hint: "Walk through prompts, edit as you go",
        },
        {
          value: "reset",
          label: "Reset",
          hint: "Wipe and start over (config / creds / workspace)",
        },
      ],
    });

    if (action === "reset") {
      const workspaceDefault =
        baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: "How deep should the reset go?",
        options: [
          { value: "config", label: "Config only", hint: "Wipe gateway/auth/channel settings" },
          {
            value: "config+creds+sessions",
            label: "Config + creds + sessions",
            hint: "Above + auth profiles + chat history",
          },
          {
            value: "full",
            label: "Full reset",
            hint: "Above + workspace (memory, dreams, skills, MEMORY.md)",
          },
        ],
      })) as ResetScope;
      await onboardHelpers.handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
    }
  }

  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback";

    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off";

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
    };
  })();

  if (flow === "quickstart") {
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return "Loopback (127.0.0.1)";
      }
      if (value === "lan") {
        return "LAN";
      }
      if (value === "custom") {
        return "Custom IP";
      }
      if (value === "tailnet") {
        return "Tailnet (Tailscale IP)";
      }
      return "Auto";
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return "Token (default)";
      }
      return "Password";
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return "Off";
      }
      if (value === "serve") {
        return "Serve";
      }
      return "Funnel";
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          "Keeping your current gateway settings (re-run with --flow=manual to change):",
          `  port: ${quickstartGateway.port}`,
          `  bind: ${formatBind(quickstartGateway.bind)}`,
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [`  custom IP: ${quickstartGateway.customBindHost}`]
            : []),
          `  auth: ${formatAuth(quickstartGateway.authMode)}`,
          `  Tailscale: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
          "",
          "Skipping straight to channel setup.",
        ]
      : [
          "QuickStart defaults (re-run with --flow=manual or `bitterbot configure` to change):",
          `  port: ${DEFAULT_GATEWAY_PORT}`,
          "  bind: Loopback (127.0.0.1) — only this machine can reach it",
          "  auth: Token (random, auto-generated)",
          "  Tailscale: off",
          "",
          "Skipping straight to channel setup.",
        ];
    await prompter.note(quickstartLines.join("\n"), "QuickStart");
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  const localProbe = await onboardHelpers.probeGatewayReachable({
    url: localUrl,
    token: baseConfig.gateway?.auth?.token ?? process.env.BITTERBOT_GATEWAY_TOKEN,
    password: baseConfig.gateway?.auth?.password ?? process.env.BITTERBOT_GATEWAY_PASSWORD,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteProbe = remoteUrl
    ? await onboardHelpers.probeGatewayReachable({
        url: remoteUrl,
        token: baseConfig.gateway?.remote?.token,
      })
    : null;

  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: "Where will the gateway run?",
          options: [
            {
              value: "local",
              label: "Local — this machine hosts the agent",
              hint: localProbe.ok
                ? `Gateway already reachable (${localUrl})`
                : `Will start fresh (${localUrl})`,
            },
            {
              value: "remote",
              label: "Remote — point this CLI at a gateway running elsewhere",
              hint: !remoteUrl
                ? "No remote URL configured yet"
                : remoteProbe?.ok
                  ? `Gateway reachable (${remoteUrl})`
                  : `Configured but unreachable (${remoteUrl})`,
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    const { promptRemoteGatewayConfig } = await import("../commands/onboard-remote.js");
    const { logConfigUpdated } = await import("../config/logging.js");
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
    nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro("Remote gateway configured.");
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await prompter.text({
          message:
            "Workspace directory (where GENOME.md, MEMORY.md, skills/, and dream output live)",
          initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);

  const { applyOnboardingLocalWorkspaceConfig } = await import("../commands/onboard-config.js");
  let nextConfig: BitterbotConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);

  const { ensureAuthProfileStore } = await import("../agents/auth-profiles.js");
  const { promptAuthChoiceGrouped } = await import("../commands/auth-choice-prompt.js");
  const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
  const { applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff } =
    await import("../commands/auth-choice.js");
  const { applyPrimaryModel, promptDefaultModel } = await import("../commands/model-picker.js");

  const authStore = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });
  const authChoiceFromPrompt = opts.authChoice === undefined;
  const authChoice =
    opts.authChoice ??
    (await promptAuthChoiceGrouped({
      prompter,
      store: authStore,
      includeSkip: true,
    }));

  if (authChoice === "custom-api-key") {
    const customResult = await promptCustomApiConfig({
      prompter,
      runtime,
      config: nextConfig,
    });
    nextConfig = customResult.config;
  } else {
    const authResult = await applyAuthChoice({
      authChoice,
      config: nextConfig,
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: opts.tokenProvider,
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
      },
    });
    nextConfig = authResult.config;
  }

  if (authChoiceFromPrompt && authChoice !== "custom-api-key") {
    const modelSelection = await promptDefaultModel({
      config: nextConfig,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      includeVllm: true,
      preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
    });
    if (modelSelection.config) {
      nextConfig = modelSelection.config;
    }
    if (modelSelection.model) {
      nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
    }
  }

  await warnIfModelConfigLooksOff(nextConfig, prompter);

  // Memory embeddings — set up a vector provider so long-term memory works.
  // Runs after auth (the LLM provider just got configured, often the same
  // API key works for embeddings) and before web search so the flow of
  // "here's one more key we need" questions lands together.
  {
    const { setupEmbeddingsForOnboarding } = await import("./onboarding.embeddings.js");
    nextConfig = await setupEmbeddingsForOnboarding({ config: nextConfig, flow, prompter });
  }

  // Web search — set up an API key so web_search/curiosity/dreams work.
  // Runs after auth (the user already committed to a provider) and before
  // gateway config (so the key is in config before the gateway starts).
  {
    const { setupWebSearchForOnboarding } = await import("./onboarding.web-search.js");
    nextConfig = await setupWebSearchForOnboarding({ config: nextConfig, flow, prompter });
  }

  const { configureGatewayForOnboarding } = await import("./onboarding.gateway-config.js");
  const gateway = await configureGatewayForOnboarding({
    flow,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  // P2P network step — lands after gateway config (settings.gatewayToken
  // is minted) and before channels (so a slow P2P probe doesn't make
  // channel setup feel like it's hanging). No node-tier prompt: all
  // new nodes are edge, management is assigned manually post-install.
  {
    const { setupP2pForOnboarding } = await import("./onboarding.p2p.js");
    nextConfig = await setupP2pForOnboarding({
      config: nextConfig,
      flow,
      settings,
      prompter,
      runtime,
    });
  }

  if (opts.skipChannels ?? opts.skipProviders) {
    await prompter.note("Skipping channel setup.", "Channels");
  } else {
    const { listChannelPlugins } = await import("../channels/plugins/index.js");
    const { setupChannels } = await import("../commands/onboard-channels.js");
    const quickstartAllowFromChannels =
      flow === "quickstart"
        ? listChannelPlugins()
            .filter((plugin) => plugin.meta.quickstartAllowFrom)
            .map((plugin) => plugin.id)
        : [];
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
    });
  }

  await writeConfigFile(nextConfig);
  const { logConfigUpdated } = await import("../config/logging.js");
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  if (opts.skipSkills) {
    await prompter.note("Skipping skills setup.", "Skills");
  } else {
    const { setupSkills } = await import("../commands/onboard-skills.js");
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // Genome step — surface GENOME.md and let the operator tune it before the
  // agent starts shaping its personality. No-op in quickstart.
  {
    const { setupGenomeForOnboarding } = await import("./onboarding.genome.js");
    await setupGenomeForOnboarding({ workspaceDir, flow, prompter });
  }

  // Wallet step — explain the economic layer and confirm enable + spend caps.
  // After skills (the agent needs to know it CAN earn from them before we
  // explain the wallet) and before hooks (so hooks recs can assume wallet state).
  {
    const { setupWalletForOnboarding } = await import("./onboarding.wallet.js");
    nextConfig = await setupWalletForOnboarding({ config: nextConfig, flow, prompter });
  }

  // Setup hooks (session memory on /new)
  const { setupInternalHooks } = await import("../commands/onboard-hooks.js");
  nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);

  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);

  const { finalizeOnboardingWizard } = await import("./onboarding.finalize.js");
  const { launchedTui } = await finalizeOnboardingWizard({
    flow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });
  if (launchedTui) {
    return;
  }
}
