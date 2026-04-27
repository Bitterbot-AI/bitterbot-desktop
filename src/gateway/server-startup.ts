import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import type { loadBitterbotPlugins } from "../plugins/loader.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../agents/model-selection.js";
import { startCronEngine } from "../cron/runtime.js";
import { startGmailWatcher } from "../hooks/gmail-watcher.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadInternalHooks } from "../hooks/loader.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { getP2pStatus, patchP2pStatus, setP2pStatus } from "../infra/p2p-status.js";
import { type PluginServicesHandle, startPluginServices } from "../plugins/services.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadBitterbotPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  // Start Bitterbot browser control server (unless disabled via config).
  let browserControl: Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>> = null;
  try {
    browserControl = await startBrowserControlServerIfEnabled();
  } catch (err) {
    params.logBrowser.error(`server failed to start: ${String(err)}`);
  }

  // Start Gmail watcher if configured (hooks.gmail.account).
  if (!isTruthyEnvValue(process.env.BITTERBOT_SKIP_GMAIL_WATCHER)) {
    try {
      const gmailResult = await startGmailWatcher(params.cfg);
      if (gmailResult.started) {
        params.logHooks.info("gmail watcher started");
      } else if (
        gmailResult.reason &&
        gmailResult.reason !== "hooks not enabled" &&
        gmailResult.reason !== "no gmail account configured"
      ) {
        params.logHooks.warn(`gmail watcher not started: ${gmailResult.reason}`);
      }
    } catch (err) {
      params.logHooks.error(`gmail watcher failed to start: ${String(err)}`);
    }
  }

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via BITTERBOT_SKIP_CHANNELS or BITTERBOT_SKIP_PROVIDERS.
  const skipChannels =
    isTruthyEnvValue(process.env.BITTERBOT_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.BITTERBOT_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info("skipping channel start (BITTERBOT_SKIP_CHANNELS=1)");
  }

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  // Start P2P orchestrator bridge if configured.
  let orchestratorBridge: import("../infra/orchestrator-bridge.js").OrchestratorBridge | null =
    null;
  let skillNetworkBridge: import("../memory/skill-network-bridge.js").SkillNetworkBridge | null =
    null;
  if (params.cfg.p2p?.enabled) {
    try {
      const { OrchestratorBridge: Bridge } = await import("../infra/orchestrator-bridge.js");
      orchestratorBridge = new Bridge(params.cfg.p2p);
      await orchestratorBridge.start();
      // Publish initial status snapshot for system prompt / doctor / UI consumers.
      // peer_connected/peer_disconnected callbacks below maintain peerCount live.
      setP2pStatus({
        enabled: true,
        connected: false,
        peerCount: 0,
        lastError: null,
      });
      orchestratorBridge.onPeerConnected(() => {
        const next = getP2pStatus().peerCount + 1;
        patchP2pStatus({ peerCount: next, connected: next > 0 });
      });
      orchestratorBridge.onPeerDisconnected(() => {
        const next = Math.max(0, getP2pStatus().peerCount - 1);
        patchP2pStatus({ peerCount: next, connected: next > 0 });
      });
      // Wire skill_received → ingestion pipeline (with reputation manager support)
      orchestratorBridge.onSkillReceived(async (event) => {
        const { ingestSkill } = await import("../agents/skills/ingest.js");
        const { loadConfig } = await import("../config/config.js");
        const envelope = event as import("../agents/skills/ingest.js").SkillEnvelope;
        const result = await ingestSkill({
          envelope,
          config: loadConfig(),
          workspaceDir: params.defaultWorkspaceDir,
        }).catch((err) => {
          params.log.warn(`P2P skill ingestion failed: ${String(err)}`);
          return null;
        });

        // Also route to SkillNetworkBridge for crystal-level ingestion
        if (skillNetworkBridge && result?.action !== "rejected") {
          try {
            skillNetworkBridge.ingestNetworkSkill(envelope);
          } catch (err) {
            params.log.warn(`Skill network bridge ingestion failed: ${String(err)}`);
          }
        }
      });
      orchestratorBridge.onWeatherReceived((event) => {
        skillNetworkBridge?.handleWeatherEvent(event);
      });
      orchestratorBridge.onBountyReceived((event) => {
        skillNetworkBridge?.handleBountyEvent(event);
      });
      orchestratorBridge.onTelemetryReceived((event) => {
        skillNetworkBridge?.handleTelemetryEvent(event);
      });
      orchestratorBridge.onQueryReceived((event) => {
        skillNetworkBridge?.handleQueryEvent(event).catch((err) => {
          params.log.warn(`Query event handling failed: ${String(err)}`);
        });
      });
      params.log.warn(
        `P2P orchestrator bridge started (binary: ${orchestratorBridge.getHealth().binaryPath})`,
      );
    } catch (err) {
      // P2P is core, not optional. Surface the failure loudly with the
      // operator-facing hint already embedded in the thrown error.
      params.log.warn(
        `P2P orchestrator bridge FAILED to start — node will be isolated from the network.\n${String(err)}`,
      );
      setP2pStatus({
        enabled: true,
        connected: false,
        peerCount: 0,
        lastError: String(err),
      });
    }
  }

  // Start memory backend — now that P2P bridge is available, pass it for skill network wiring.
  void startGatewayMemoryBackend({
    cfg: params.cfg,
    log: params.log,
    orchestratorBridge: orchestratorBridge ?? undefined,
  })
    .then((result) => {
      if (result.skillNetworkBridge) {
        skillNetworkBridge = result.skillNetworkBridge;
      }
    })
    .catch((err) => {
      params.log.warn(`memory startup initialization failed: ${String(err)}`);
    });

  // Start the cron engine. Failures here are non-fatal — the rest of the
  // gateway should boot even if cron jobs fail to load.
  void startCronEngine(params.cfg).catch((err) => {
    params.log.warn(`cron engine failed to start: ${String(err)}`);
  });

  return { browserControl, pluginServices, orchestratorBridge, skillNetworkBridge };
}
