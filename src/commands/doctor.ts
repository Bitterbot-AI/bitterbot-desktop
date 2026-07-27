import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import fs from "node:fs";
import type { BitterbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_PATH, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveBitterbotPackageRoot } from "../infra/bitterbot-root.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { shortenHomePath } from "../utils.js";
import { VERSION } from "../version.js";
import { runAgentRuntimeChecks } from "./doctor-agent-runtime.js";
import { runAgentTurnProbe } from "./doctor-agent-turn.js";
import {
  maybeRemoveDeprecatedCliAuthProfiles,
  maybeRepairAnthropicOAuthProfileId,
  noteAuthProfileHealth,
} from "./doctor-auth.js";
import { noteBootHealth } from "./doctor-boot-health.js";
import { runCanvasChecks } from "./doctor-canvas.js";
import { runChannelsChecks } from "./doctor-channels.js";
import { error, info, renderSection, setDoctorJsonMode, warn } from "./doctor-check.js";
import { doctorShellCompletion } from "./doctor-completion.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { runEconomyChecks } from "./doctor-economy.js";
import { maybeRepairGatewayDaemon } from "./doctor-gateway-daemon-flow.js";
import { checkGatewayHealth } from "./doctor-gateway-health.js";
import {
  maybeRepairGatewayServiceConfig,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import { runIdentityChecks } from "./doctor-identity.js";
import { noteSourceInstallIssues } from "./doctor-install.js";
import { runMemorySearchChecks } from "./doctor-memory-search.js";
import { runMemorySystemChecks } from "./doctor-memory-system.js";
import { runModelCheck } from "./doctor-model.js";
import {
  doctorErrorMessages,
  doctorFindings,
  doctorHasError,
  resetDoctorOutcome,
  worstFindingLevel,
} from "./doctor-outcome.js";
import { runP2pNetworkChecks } from "./doctor-p2p.js";
import {
  noteMacLaunchAgentOverrides,
  noteMacLaunchctlGatewayEnvOverrides,
} from "./doctor-platform-notes.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";
import { runRetrievalChecks } from "./doctor-retrieval.js";
import { runRuntimeChecks } from "./doctor-runtime.js";
import { maybeRepairSandboxImages, noteSandboxScopeWarnings } from "./doctor-sandbox.js";
import { runSecurityChecks } from "./doctor-security.js";
import { runSkillsChecks } from "./doctor-skills.js";
import { noteStateIntegrity, noteWorkspaceBackupTip } from "./doctor-state-integrity.js";
import { runSubsystemChecks } from "./doctor-subsystems.js";
import { runTaskSpineChecks } from "./doctor-tasks.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";
import { runWalletChecks } from "./doctor-wallet.js";
import { runWebSearchChecks } from "./doctor-web-search.js";
import { noteWorkspaceStatus } from "./doctor-workspace-status.js";
import { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } from "./doctor-workspace.js";
import { applyWizardMetadata, printWizardHeader, randomToken } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

function resolveMode(cfg: BitterbotConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const jsonMode = options.json === true;
  // --json implies non-interactive at the commander layer; enforce it here too
  // so programmatic doctorCommand({json: true}) callers can never hit a prompt
  // (or the interactive update offer, whose early-return would skip the report).
  if (jsonMode && options.nonInteractive !== true) {
    options = { ...options, nonInteractive: true };
  }
  const prompter = createDoctorPrompter({ runtime, options });
  resetDoctorOutcome();
  setDoctorJsonMode(jsonMode);
  try {
    await runDoctor(runtime, options, jsonMode, prompter);
  } finally {
    // The flag is module-global; a stale `true` would silence the next
    // in-process doctor run (e.g. update-command's post-restart doctor).
    setDoctorJsonMode(false);
  }
}

async function runDoctor(
  runtime: RuntimeEnv,
  options: DoctorOptions,
  jsonMode: boolean,
  prompter: ReturnType<typeof createDoctorPrompter>,
) {
  if (!jsonMode) {
    printWizardHeader(runtime);
    intro("Bitterbot doctor");
  }

  const root = await resolveBitterbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime,
    options,
    root,
    confirm: (p) => prompter.confirm(p),
    outro,
  });
  if (updateResult.handled) {
    return;
  }

  noteSourceInstallIssues(root);

  // A post-update boot that never confirmed healthy is the highest-priority
  // signal — surface it before anything else.
  noteBootHealth();

  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (p) => prompter.confirm(p),
  });
  let cfg: BitterbotConfig = configResult.cfg;

  // Runtime (Node version, pnpm, platform posture) first — every check
  // below assumes the runtime itself is viable. Runs config-only / fast.
  runRuntimeChecks({ config: cfg });

  const configPath = configResult.path ?? CONFIG_PATH;
  if (!cfg.gateway?.mode) {
    const lines = [
      "gateway.mode is unset; gateway start will be blocked.",
      `Fix: run ${formatCliCommand("bitterbot configure")} and set Gateway mode (local/remote).`,
      `Or set directly: ${formatCliCommand("bitterbot config set gateway.mode local")}`,
    ];
    if (!fs.existsSync(configPath)) {
      lines.push(`Missing config: run ${formatCliCommand("bitterbot setup")} first.`);
    }
    renderSection("Gateway", [warn(lines.join("\n"))]);
  }

  cfg = await maybeRepairAnthropicOAuthProfileId(cfg, prompter);
  cfg = await maybeRemoveDeprecatedCliAuthProfiles(cfg, prompter);
  await noteAuthProfileHealth({
    cfg,
    prompter,
    allowKeychainPrompt: options.nonInteractive !== true && Boolean(process.stdin.isTTY),
  });
  const gatewayDetails = buildGatewayConnectionDetails({ config: cfg });
  if (gatewayDetails.remoteFallbackNote) {
    renderSection("Gateway", [info(gatewayDetails.remoteFallbackNote)]);
  }
  if (resolveMode(cfg) === "local") {
    const auth = resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    });
    const needsToken =
      auth.mode !== "password" &&
      auth.mode !== "trusted-proxy" &&
      (auth.mode !== "token" || !auth.token);
    if (needsToken) {
      renderSection("Gateway auth", [
        warn(
          "Gateway auth is off or missing a token. Token auth is now the recommended default (including loopback).",
        ),
      ]);
      const shouldSetToken =
        options.generateGatewayToken === true
          ? true
          : options.nonInteractive === true
            ? false
            : await prompter.confirmRepair({
                message: "Generate and configure a gateway token now?",
                initialValue: true,
              });
      if (shouldSetToken) {
        const nextToken = randomToken();
        cfg = {
          ...cfg,
          gateway: {
            ...cfg.gateway,
            auth: {
              ...cfg.gateway?.auth,
              mode: "token",
              token: nextToken,
            },
          },
        };
        note("Gateway token configured.", "Gateway auth");
      }
    }
  }

  await noteStateIntegrity(cfg, prompter, configResult.path ?? CONFIG_PATH);

  cfg = await maybeRepairSandboxImages(cfg, runtime, prompter);
  noteSandboxScopeWarnings(cfg);

  await maybeScanExtraGatewayServices(options, runtime, prompter);
  await maybeRepairGatewayServiceConfig(cfg, resolveMode(cfg), runtime, prompter);
  await noteMacLaunchAgentOverrides();
  await noteMacLaunchctlGatewayEnvOverrides(cfg);

  await runSecurityChecks(cfg);

  if (cfg.hooks?.gmail?.model?.trim()) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (!hooksModelRef) {
      renderSection("Hooks", [
        warn(
          [
            `hooks.gmail.model "${cfg.hooks.gmail.model}" could not be resolved.`,
            `  Fix: set a valid model ref or remove hooks.gmail.model from your config.`,
            `  Example: ${formatCliCommand(`bitterbot config set hooks.gmail.model "${DEFAULT_PROVIDER}/${DEFAULT_MODEL}"`)}`,
          ].join("\n"),
        ),
      ]);
    } else {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: cfg });
      const status = getModelRefStatus({
        cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      const warnings: string[] = [];
      if (!status.allowed) {
        warnings.push(
          `- hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        warnings.push(
          `- hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
      if (warnings.length > 0) {
        renderSection(
          "Hooks",
          warnings.map((w) => warn(w.replace(/^- /, ""))),
        );
      }
    }
  }

  if (
    options.nonInteractive !== true &&
    process.platform === "linux" &&
    resolveMode(cfg) === "local"
  ) {
    const service = resolveGatewayService();
    let loaded = false;
    try {
      loaded = await service.isLoaded({ env: process.env });
    } catch {
      loaded = false;
    }
    if (loaded) {
      await ensureSystemdUserLingerInteractive({
        runtime,
        prompter: {
          confirm: async (p) => prompter.confirm(p),
          note,
        },
        reason:
          "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
        requireConfirm: true,
      });
    }
  }

  noteWorkspaceStatus(cfg);
  await runMemorySearchChecks(cfg);

  // Check and fix shell completion
  await doctorShellCompletion(runtime, prompter, {
    nonInteractive: options.nonInteractive,
  });

  const { healthOk } = await checkGatewayHealth({
    runtime,
    cfg,
    timeoutMs: options.nonInteractive === true ? 3000 : 10_000,
  });
  await maybeRepairGatewayDaemon({
    cfg,
    runtime,
    prompter,
    options,
    gatewayDetailsMessage: gatewayDetails.message,
    healthOk,
  });

  // ── P2P Network (core infra; promoted from the memory architecture block) ──
  await runP2pNetworkChecks({ config: cfg, isGatewayRunning: healthOk });

  // ── P2P Identity (node tier, keypair, genesis trust list for management) ──
  runIdentityChecks({ config: cfg, packageRoot: root });

  // ── Skills (P2P ingest policy, quarantine dir, trust list for auto-accept) ──
  runSkillsChecks({ config: cfg });

  // ── Agent runtime observability (today's considerations log, in-memory state hints) ──
  await runAgentRuntimeChecks();

  // ── Biological Memory Architecture ──
  {
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const memSearchCfg = resolveMemorySearchConfig(cfg, agentId);
    const dbPath = memSearchCfg?.store?.path ?? "";
    const stateDir = resolveAgentDir(cfg, agentId);
    await runMemorySystemChecks({
      config: cfg,
      stateDir,
      workspaceDir,
      dbPath,
      isGatewayRunning: healthOk,
    });
  }

  // ── Post-Q1 subsystems (embeddings backlog, knowledge graph, canonical
  //    ledger, circles) — deep DB checks that surface wired-but-dead state ──
  runSubsystemChecks({ config: cfg });

  // ── Retrieval health (live dead-wire detector + offline trace sweep) ──
  await runRetrievalChecks({ config: cfg, isGatewayRunning: healthOk });

  // ── Economy (forage settlements, revenue queue, x402 payment gate) ──
  runEconomyChecks({ config: cfg, isGatewayRunning: healthOk });

  // ── Long-horizon task spine (tasks.sqlite, event journal, cron) ──
  runTaskSpineChecks({ config: cfg, isGatewayRunning: healthOk });

  // ── One real model round-trip — "configured" is not "works" ──
  await runModelCheck({ config: cfg });

  // ── One real agent turn through the gateway — the model check proves the
  //    provider, this proves the pipeline (warn-only during burn-in) ──
  await runAgentTurnProbe({
    config: cfg,
    isGatewayRunning: healthOk,
    forceDuringUpdate: options.forceAgentTurnProbe === true,
  });

  // ── Wallet (USDC on Base) ──
  await runWalletChecks({ config: cfg });

  // ── Web Search (agent's look-things-up capability) ──
  runWebSearchChecks({ config: cfg });

  // ── Channels (offline static config: creds + DM policy) ──
  runChannelsChecks({ config: cfg });

  // ── Canvas (A2UI rendering) ──
  await runCanvasChecks({ config: cfg });

  const shouldWriteConfig = prompter.shouldRepair || configResult.shouldWriteConfig;
  if (shouldWriteConfig) {
    cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
    await writeConfigFile(cfg);
    logConfigUpdated(runtime);
    const backupPath = `${CONFIG_PATH}.bak`;
    if (!jsonMode && fs.existsSync(backupPath)) {
      runtime.log(`Backup: ${shortenHomePath(backupPath)}`);
    }
  } else if (!jsonMode) {
    runtime.log(`Run "${formatCliCommand("bitterbot doctor --fix")}" to apply changes.`);
  }

  if (options.workspaceSuggestions !== false) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    noteWorkspaceBackupTip(workspaceDir);
    if (!jsonMode && (await shouldSuggestMemorySystem(workspaceDir))) {
      note(MEMORY_SYSTEM_PROMPT, "Workspace");
    }
  }

  const finalSnapshot = await readConfigFileSnapshot();
  if (finalSnapshot.exists && !finalSnapshot.valid) {
    // Error-level finding: a config the schema rejects means the next gateway
    // boot runs on defaults/partial config — genuinely broken, blocks updates.
    renderSection("Config", [
      error(
        ["Config file failed validation:"]
          .concat(finalSnapshot.issues.map((i) => `  - ${i.path || "<root>"}: ${i.message}`))
          .join("\n"),
      ),
    ]);
  }

  if (jsonMode) {
    // Machine-readable report: the structured findings + rollup. The last
    // stdout line is this object, so a consumer (the UI health surface, an
    // update gate) can parse it. Exit code still reflects error-level.
    // All rollup fields derive from the same findings list: worstLevel is the
    // max severity, hasError/blocksUpdate ⇔ worstLevel === "error".
    runtime.log(
      JSON.stringify({
        // Report-shape version, independent of the app VERSION — bump when
        // fields change so consumers can detect drift.
        schema: 1,
        version: VERSION,
        worstLevel: worstFindingLevel(),
        hasError: doctorHasError(),
        blocksUpdate: doctorHasError(),
        errors: doctorErrorMessages(),
        findings: doctorFindings(),
        checkedAt: Date.now(),
      }),
    );
  } else {
    outro("Doctor complete.");
  }

  // Real exit code: a genuinely broken subsystem (error-level finding) fails
  // the process. This is what makes the update flow's doctor gate real —
  // `update-runner.ts` runs `doctor --non-interactive` and only hands off to
  // the freshly-built gateway when it exits 0. Degraded-but-usable states are
  // warn-level and do NOT block. Placed after the report so nothing is skipped;
  // test runtimes pass a no-op exit, so unit/e2e flows are unaffected.
  if (doctorHasError()) {
    const errors = doctorErrorMessages();
    if (!jsonMode && errors.length > 0) {
      // First line only: finding messages can be multi-line prose (the full
      // text was already rendered in its section above).
      runtime.error(
        `doctor found ${errors.length} error-level problem(s):\n` +
          errors.map((m) => `  - ${m.split("\n")[0]}`).join("\n"),
      );
    }
    runtime.exit(1);
  }
}
