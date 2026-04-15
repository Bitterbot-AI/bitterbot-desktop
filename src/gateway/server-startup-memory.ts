import type { BitterbotConfig } from "../config/config.js";
import type { OrchestratorBridge } from "../infra/orchestrator-bridge.js";
import type { OrchestratorBridgeLike } from "../memory/skill-network-bridge.js";
import type { SkillNetworkBridge } from "../memory/skill-network-bridge.js";
import type { PluginHookHandlerMap } from "../plugins/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { getMemorySearchManager } from "../memory/index.js";
import {
  ManagementKeyAuth,
  ManagementKeyAuthError,
  loadGenesisTrustList,
} from "../memory/management-key-auth.js";
import { ManagementNodeService } from "../memory/management-node-service.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";

export type MemoryBackendResult = {
  skillNetworkBridge: SkillNetworkBridge | null;
};

export async function startGatewayMemoryBackend(params: {
  cfg: BitterbotConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
  orchestratorBridge?: OrchestratorBridgeLike | null;
}): Promise<MemoryBackendResult> {
  const agentId = resolveDefaultAgentId(params.cfg);

  const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
  if (!manager) {
    params.log.warn(
      `memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
    );
    return { skillNetworkBridge: null };
  }

  // Wire orchestrator bridge into the memory manager's skill network bridge
  let skillNetworkBridge: SkillNetworkBridge | null = null;
  if (params.orchestratorBridge) {
    const managerAny = manager as unknown as Record<string, unknown>;
    if (typeof managerAny.wireOrchestratorBridge === "function") {
      (managerAny.wireOrchestratorBridge as (b: OrchestratorBridgeLike) => void)(
        params.orchestratorBridge,
      );
    }
    if (typeof managerAny.getSkillNetworkBridge === "function") {
      skillNetworkBridge = (managerAny.getSkillNetworkBridge as () => SkillNetworkBridge | null)();
    }

    // Initialize ManagementNodeService if this is a management node.
    // Re-read config fresh — params.cfg may have p2p fields stripped by an
    // intermediate config subset that doesn't include the full P2pConfig.
    const freshCfg = loadConfig();
    const p2pCfg = freshCfg.p2p;
    if (p2pCfg?.nodeTier === "management") {
      try {
        const trustList = loadGenesisTrustList(
          p2pCfg.genesisTrustListPath,
          p2pCfg.genesisTrustList,
        );
        const bridge = params.orchestratorBridge as unknown as OrchestratorBridge;
        const auth = await ManagementKeyAuth.init(trustList, bridge);
        const db = managerAny.db as import("node:sqlite").DatabaseSync;
        const peerRep = (managerAny.peerReputationManager ?? null) as
          | import("../memory/peer-reputation.js").PeerReputationManager
          | null;
        const economics = (managerAny.marketplaceEconomics ?? null) as
          | import("../memory/marketplace-economics.js").MarketplaceEconomics
          | null;
        const svc = new ManagementNodeService(db, bridge, peerRep, economics, auth);
        svc.start();
        managerAny.managementNodeService = svc;
        params.log.warn?.(
          `Management node service started (pubkey: ${auth.publicKeyBase64.substring(0, 8)}...)`,
        );
      } catch (err) {
        const msg =
          err instanceof ManagementKeyAuthError ? `${err.code}: ${err.message}` : String(err);
        params.log.warn(`Management node auth failed: ${msg}`);
      }
    }
  }

  // Register execution tracking hook into plugin system
  const managerForHook = manager as unknown as Record<string, unknown>;
  if (typeof managerForHook.getExecutionTrackingHook === "function") {
    const hook = (managerForHook.getExecutionTrackingHook as () => unknown)();
    if (hook && typeof hook === "function") {
      const registry = getGlobalPluginRegistry();
      if (registry) {
        registry.typedHooks.push({
          pluginId: "memory-execution-tracker",
          hookName: "after_tool_call",
          handler: hook as PluginHookHandlerMap["after_tool_call"],
          priority: 0,
          source: "memory",
        });
      }
    }
  }

  return { skillNetworkBridge };
}
