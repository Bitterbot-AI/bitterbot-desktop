/**
 * A2A Client Tool — lets the agent discover and hire peer agents.
 *
 * Actions:
 * - discover: Fetch a peer agent's Agent Card (skills, pricing)
 * - execute: Send a task to a peer agent (with optional x402 payment)
 * - spend_status: Check daily A2A spending status
 */

import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { A2aClient } from "../../services/a2a-client.js";
import { jsonResult, readStringParam } from "./common.js";

const _log = createSubsystemLogger("tool/a2a-client");

const A2aClientSchema = Type.Object({
  action: Type.Union([
    Type.Literal("discover"),
    Type.Literal("execute"),
    Type.Literal("spend_status"),
  ]),
  /** Agent URL for discover/execute actions */
  agentUrl: Type.Optional(Type.String()),
  /** libp2p peer ID — alternative to agentUrl; resolved via wallet_capability gossip */
  peerId: Type.Optional(Type.String()),
  /** Seller/author pubkey (a marketplace entry's authorPeerId) so commerce standing joins fraud verdicts */
  peerPubkey: Type.Optional(Type.String()),
  /** Message to send for execute action */
  message: Type.Optional(Type.String()),
  /** Maximum USDC to spend on this task (optional override) */
  maxCost: Type.Optional(Type.Number()),
});

export function createA2aClientTool(options: { config?: BitterbotConfig }): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg?.a2a?.enabled) {
    return null;
  }
  if (cfg.a2a.marketplace?.client === undefined && !cfg.a2a.marketplace?.enabled) {
    return null;
  }

  const clientConfig = cfg.a2a.marketplace?.client;
  let client: A2aClient | null = null;

  // Resolve the marketplace db so purchases are recorded and the daily
  // spend limit reads real numbers (without it the limit always sees $0).
  const getClient = async () => {
    if (!client) {
      let db: import("node:sqlite").DatabaseSync | undefined;
      try {
        const { MemoryIndexManager } = await import("../../memory/manager.js");
        const memManager = await MemoryIndexManager.get({
          cfg,
          agentId: "default",
          purpose: "status",
        });
        db = (
          memManager?.getMarketplaceEconomics?.() as
            | { getDb?: () => import("node:sqlite").DatabaseSync | undefined }
            | null
            | undefined
        )?.getDb?.();
      } catch {
        // No marketplace db — client still works, spend tracking degrades
      }
      client = new A2aClient(clientConfig, db);
    }
    return client;
  };

  return {
    label: "A2A Client",
    name: "a2a_client",
    description:
      "Discover and interact with peer agents on the A2A network. Use 'discover' to see what skills " +
      "an agent offers and their pricing. Use 'execute' to send a task to a peer agent (may require " +
      "x402 USDC payment). Use 'spend_status' to check daily spending limits. Target a peer by " +
      "agentUrl, or by peerId if the peer advertised its A2A endpoint over the mesh.",
    parameters: A2aClientSchema,
    execute: async (_toolCallId, rawParams) => {
      const action = readStringParam(rawParams, "action");

      if (action === "spend_status") {
        const a2aClient = await getClient();
        const status = a2aClient.checkDailySpendLimit();
        return jsonResult({
          allowed: status.allowed,
          spentToday: `$${status.spent.toFixed(4)} USDC`,
          remaining: `$${status.remaining.toFixed(4)} USDC`,
          dailyLimit: `$${(clientConfig?.dailySpendLimitUsdc ?? 2.0).toFixed(2)} USDC`,
        });
      }

      let agentUrl = readStringParam(rawParams, "agentUrl");
      if (!agentUrl) {
        // Resolve a peerId to its advertised A2A URL via wallet_capability gossip.
        const peerId = readStringParam(rawParams, "peerId");
        if (peerId) {
          const { getPeerWalletCapability } = await import("../../infra/wallet-discovery.js");
          const cap = getPeerWalletCapability(peerId);
          if (cap?.a2aUrl) {
            agentUrl = cap.a2aUrl;
          } else {
            return jsonResult({
              error: cap
                ? `Peer ${peerId} has not advertised an A2A URL`
                : `Peer ${peerId} unknown or its wallet advertisement is stale`,
            });
          }
        }
      }
      if (!agentUrl) {
        return jsonResult({ error: "agentUrl or peerId is required for discover/execute actions" });
      }

      if (action === "discover") {
        const a2aClient = await getClient();
        const agent = await a2aClient.discoverAgent(agentUrl);
        if (!agent) {
          return jsonResult({ error: `Could not discover agent at ${agentUrl}` });
        }
        return jsonResult({
          name: agent.name,
          description: agent.description,
          url: agent.url,
          skills: agent.skills,
          paymentRequired: agent.paymentRequired,
          paymentAddress: agent.paymentAddress,
          minPayment: agent.minPayment ? `$${agent.minPayment} USDC` : undefined,
        });
      }

      if (action === "execute") {
        const message = readStringParam(rawParams, "message");
        if (!message) {
          return jsonResult({ error: "message is required for execute action" });
        }

        // Get wallet service for payment if available
        let walletService: import("../../services/wallet-service.js").WalletService | undefined;
        try {
          const { createWalletService } = await import("../../services/wallet-service.js");
          if (cfg.tools?.wallet) {
            walletService = createWalletService(cfg.tools.wallet);
          }
        } catch {
          // No wallet — execute without payment capability
        }

        const a2aClient = await getClient();
        const peerPubkey = readStringParam(rawParams, "peerPubkey");
        const result = await a2aClient.executeTask({
          agentUrl,
          message,
          walletService,
          ...(peerPubkey ? { peerPubkey } : {}),
        });

        if (result.success) {
          return jsonResult({
            success: true,
            taskId: result.taskId,
            response: result.response,
            amountPaid: result.amountPaid ? `$${result.amountPaid} USDC` : undefined,
            txHash: result.txHash,
          });
        } else {
          return jsonResult({
            success: false,
            error: result.error,
            amountPaid: result.amountPaid ? `$${result.amountPaid} USDC` : undefined,
            txHash: result.txHash,
          });
        }
      }

      return jsonResult({ error: `Unknown action: ${action}` });
    },
  };
}
