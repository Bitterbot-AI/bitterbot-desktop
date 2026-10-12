import { formatCliCommand } from "../cli/command-format.js";
import type {
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import type { BitterbotConfig } from "../config/config.js";
import {
  DEFAULT_GATEWAY_PORT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { isFirstBootOnlyConfig } from "./onboarding.first-boot.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }
  // The same acknowledgement the browser setup page asks (setup-steps.ts).
  const { requireSetupRiskAcknowledgement } = await import("./setup-steps.js");
  await requireSetupRiskAcknowledgement(params.prompter);
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

  // A file holding only the token a first gateway start generated (the
  // container image does this) is not a previous setup: keep the token and
  // onboard as new. The defaults apply with or without a file (PLAN-56).
  const firstBootOnly = snapshot.exists && isFirstBootOnlyConfig(snapshot.resolved);
  if (firstBootOnly) {
    await prompter.note(
      "The config holds only a gateway token (what a first gateway start writes). Keeping the token; setting up everything else.",
      "Config",
    );
  }

  if (snapshot.exists && !firstBootOnly) {
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
          "Next: the setup steps (model key, model, memory, web search, channels, P2P, privacy).",
        ]
      : [
          "QuickStart defaults (re-run with --flow=manual or `bitterbot configure` to change):",
          `  port: ${DEFAULT_GATEWAY_PORT}`,
          "  bind: Loopback (127.0.0.1) — only this machine can reach it",
          "  auth: Token (random, auto-generated)",
          "  Tailscale: off",
          "",
          "Next: the setup steps (model key, model, memory, web search, channels, P2P, privacy).",
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

  const { warnIfModelConfigLooksOff } = await import("../commands/auth-choice.js");
  const { resolveBitterbotPackageRoot } = await import("../infra/bitterbot-root.js");
  const { detectInstallKind } = await import("../infra/install-kind.js");
  const packageRoot = await resolveBitterbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  }).catch(() => null);
  const installKind = detectInstallKind(packageRoot);

  // The options finalize sees (the "Keep running" step may set installDaemon).
  let finalizeOpts: OnboardOptions = opts;
  let settings: Awaited<
    ReturnType<typeof import("./onboarding.gateway-config.js").configureGatewayForOnboarding>
  >["settings"];

  if (flow === "quickstart") {
    // PLAN-56 Phase 4: QuickStart IS the setup step model, the same steps the
    // browser setup page renders over wizard.* (src/wizard/setup-steps.ts).
    // An explicit --auth-choice still runs the provider-specific auth flow;
    // the model's key and model steps then keep what it configured.
    let presets: Partial<Record<"auth" | "model" | "channels" | "service", string>> | undefined;
    if (opts.authChoice !== undefined) {
      const { applyAuthChoice } = await import("../commands/auth-choice.js");
      const authResult = await applyAuthChoice({
        authChoice: opts.authChoice,
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
      presets = { auth: "skip", model: "keep" };
    }
    if (opts.skipChannels ?? opts.skipProviders) {
      presets = { ...presets, channels: "later" };
    }
    if (typeof opts.installDaemon === "boolean") {
      presets = { ...presets, service: opts.installDaemon ? "install" : "no" };
    }
    const { commitSetupKey, createSetupDraft, runSetupSteps } = await import("./setup-steps.js");
    const { detectSetupKeys, detectSignedInProfiles } = await import("./setup-keys.js");
    const { detectSetupServiceSupport } = await import("./setup-service.js");
    const ctx = {
      effective: baseConfig,
      keys: detectSetupKeys(),
      profiles: detectSignedInProfiles(),
      keyEnv: {},
      installKind,
      env: process.env,
      service: await detectSetupServiceSupport({ installKind }),
    };
    const draft = createSetupDraft(nextConfig);
    await runSetupSteps({
      ctx,
      draft,
      prompter,
      presets,
      // Asked at the start of the wizard (or --accept-risk).
      riskAcknowledged: true,
      // Flags on a run nobody can answer take the recommended answers; an
      // interactive terminal always sees the fork (P2P is a consent choice).
      acceptRecommended: opts.authChoice !== undefined && !process.stdin.isTTY,
    });
    await commitSetupKey(draft, ctx);
    for (const notice of draft.notices) {
      await prompter.note(notice, "Your previous key was kept");
    }
    nextConfig = draft.config;
    // The "Keep running" step decides the service install finalize does.
    if (draft.answers.service === "install" || draft.answers.service === "no") {
      finalizeOpts = { ...opts, installDaemon: draft.answers.service === "install" };
    }
    await warnIfModelConfigLooksOff(nextConfig, prompter);

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
    settings = gateway.settings;

    if (draft.channelsNext && !(opts.skipChannels ?? opts.skipProviders)) {
      const { setupChannels } = await import("../commands/onboard-channels.js");
      nextConfig = await setupChannels(nextConfig, runtime, prompter, {
        allowSignalInstall: true,
      });
    }
  } else {
    const { ensureAuthProfileStore } = await import("../agents/auth-profiles.js");
    const { promptAuthChoiceGrouped } = await import("../commands/auth-choice-prompt.js");
    const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
    const { applyAuthChoice, resolvePreferredProviderForAuthChoice } =
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

    // Memory embeddings, then web search: the "one more key" questions land
    // together, after the LLM provider (often the same key works).
    {
      const { setupEmbeddingsForOnboarding } = await import("./onboarding.embeddings.js");
      nextConfig = await setupEmbeddingsForOnboarding({ config: nextConfig, flow, prompter });
    }
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
    settings = gateway.settings;

    // P2P network step: after gateway config, before channels. No node-tier
    // prompt: all new nodes are edge, management is assigned manually.
    {
      const { setupP2pForOnboarding } = await import("./onboarding.p2p.js");
      nextConfig = await setupP2pForOnboarding({
        config: nextConfig,
        flow,
        prompter,
        runtime,
        installKind,
      });
    }

    if (opts.skipChannels ?? opts.skipProviders) {
      await prompter.note("Skipping channel setup.", "Channels");
    } else {
      const { setupChannels } = await import("../commands/onboard-channels.js");
      nextConfig = await setupChannels(nextConfig, runtime, prompter, {
        allowSignalInstall: true,
      });
    }
  }

  await writeConfigFile(nextConfig);
  const { logConfigUpdated } = await import("../config/logging.js");
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  if (opts.skipSkills) {
    await prompter.note("Skipping skills setup.", "Skills");
  } else if (flow === "quickstart") {
    // PLAN-41 D-M: QuickStart defers skill dependency setup to the Control UI.
    await prompter.note(
      `Bundled skills work out of the box. Install extras later in the Control UI or via \`${formatCliCommand("bitterbot configure --section skills")}\`.`,
      "Skills",
    );
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

  // Setup hooks (session memory on /new). QuickStart skips the multiselect
  // and enables the zero-config local built-ins silently (PLAN-41 D-M) —
  // without session-memory the dream engine has nothing to work on.
  if (flow === "quickstart") {
    const { applyQuickstartHookDefaults, QUICKSTART_DEFAULT_HOOKS } =
      await import("../commands/onboard-hooks.js");
    const before = nextConfig;
    nextConfig = applyQuickstartHookDefaults(nextConfig);
    if (nextConfig !== before) {
      await prompter.note(
        [
          `Enabled built-in hooks: ${QUICKSTART_DEFAULT_HOOKS.join(", ")}.`,
          "They keep session memory, startup priming, and the command audit log",
          `working out of the box. Manage them anytime: ${formatCliCommand("bitterbot hooks list")}`,
        ].join("\n"),
        "Hooks",
      );
    }
  } else {
    const { setupInternalHooks } = await import("../commands/onboard-hooks.js");
    nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);
  }

  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  // A browser setup abandoned halfway is finished now.
  (await import("../gateway/setup-token.js")).clearSetupInProgress();

  const { finalizeOnboardingWizard } = await import("./onboarding.finalize.js");
  const { launchedTui } = await finalizeOnboardingWizard({
    flow,
    opts: finalizeOpts,
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
