import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { SkillEntry } from "../../agents/skills/types.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import { authorizeGatewayConnect } from "../auth.js";
import { getBearerToken } from "../http-utils.js";
import {
  sendJson,
  sendGatewayAuthFailure,
  readJsonBodyOrError,
} from "../http-common.js";
import { resolveGatewayClientIp, isPrivateOrLoopbackAddress } from "../net.js";
import { getHeader } from "../http-utils.js";
import { buildAgentCard } from "./agent-card.js";
import { handleA2aJsonRpc, isStreamingMethod } from "./server.js";
import { streamTaskEvents } from "./streaming.js";
import { A2aTaskManager } from "./task-manager.js";
import type { JsonRpcRequest, MessageSendParams } from "./types.js";
import { A2aErrorCodes } from "./types.js";
import { verifyA2aPayment, isPaymentRateLimited } from "./payment.js";
import { executeA2aTask, extractTaskText } from "./task-executor.js";

const MAX_A2A_BODY_BYTES = 1_048_576; // 1 MB
const WELL_KNOWN_PATH = "/.well-known/agent.json";
const A2A_PATH = "/a2a";

let taskManager: A2aTaskManager | null = null;
let cachedAgentCard: { json: string; version: number } | null = null;

function getOrCreateTaskManager(config: BitterbotConfig, externalDb?: DatabaseSync): A2aTaskManager {
  if (!taskManager) {
    const db = externalDb ?? (() => {
      // Persist A2A tasks to a file-backed SQLite DB so they survive restarts.
      const stateDir = process.env.BITTERBOT_STATE_DIR?.trim()
        || path.join(os.homedir(), ".bitterbot");
      const dbDir = path.join(stateDir, "a2a");
      mkdirSync(dbDir, { recursive: true });
      return new DatabaseSync(path.join(dbDir, "tasks.db"));
    })();
    db.exec("PRAGMA journal_mode = WAL");
    taskManager = new A2aTaskManager(db, config);
  }
  return taskManager;
}

/**
 * Handle A2A HTTP requests in the gateway request pipeline.
 *
 * Handles:
 * - `GET /.well-known/agent.json` — Agent Card discovery (no auth)
 * - `POST /a2a` — JSON-RPC endpoint (auth required)
 *
 * Returns `true` if the request was handled, `false` to pass to next handler.
 */
export function createA2aHttpHandler(opts: {
  getConfig: () => BitterbotConfig;
  getSkills: () => SkillEntry[];
  getGatewayUrl: () => string;
  getSkillsVersion: () => number;
}): (
  req: IncomingMessage,
  res: ServerResponse,
  authOpts: {
    auth: ResolvedGatewayAuth;
    trustedProxies: string[];
    rateLimiter?: AuthRateLimiter;
  },
) => Promise<boolean> {
  const { getConfig, getSkills, getGatewayUrl, getSkillsVersion } = opts;

  return async (req, res, authOpts) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Agent Card discovery — no auth required per A2A spec.
    if (path === WELL_KNOWN_PATH && req.method === "GET") {
      const config = getConfig();
      if (!config.a2a?.enabled) {
        return false;
      }
      const version = getSkillsVersion();
      if (!cachedAgentCard || cachedAgentCard.version !== version) {
        // Load marketplace prices for the Agent Card
        let skillPrices: Map<string, number> | undefined;
        try {
          const { MemoryIndexManager } = await import("../../memory/manager.js");
          const memManager = await MemoryIndexManager.get({ cfg: config, agentId: "default", purpose: "status" });
          const marketplace = memManager?.getMarketplaceEconomics?.();
          if (marketplace) {
            const listings = marketplace.getListableSkills();
            skillPrices = new Map(listings.map((l: any) => [l.skillCrystalId, l.priceUsdc]));
          }
        } catch { /* non-critical */ }
        const card = buildAgentCard({
          config,
          skills: getSkills(),
          gatewayUrl: getGatewayUrl(),
          skillPrices,
        });
        cachedAgentCard = { json: JSON.stringify(card, null, 2), version };
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.end(cachedAgentCard.json);
      return true;
    }

    // All other A2A routes require the /a2a path prefix.
    if (path !== A2A_PATH) {
      return false;
    }

    const config = getConfig();
    if (!config.a2a?.enabled) {
      return false;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: A2aErrorCodes.INVALID_REQUEST, message: "Method Not Allowed" },
        id: null,
      });
      return true;
    }

    // Authenticate — bearer token or local loopback.
    const authOk = await authorizeA2aRequest(req, config, authOpts);
    if (!authOk.ok) {
      sendGatewayAuthFailure(res, authOk.result);
      return true;
    }

    // Parse JSON-RPC body.
    const body = await readJsonBodyOrError(req, res, MAX_A2A_BODY_BYTES);
    if (body === undefined) {
      return true; // readJsonBodyOrError already sent the error response.
    }

    const rpcRequest = body as JsonRpcRequest;
    if (!rpcRequest.method || !rpcRequest.id) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: A2aErrorCodes.INVALID_REQUEST, message: "Invalid JSON-RPC request" },
        id: rpcRequest?.id ?? null,
      });
      return true;
    }

    const manager = getOrCreateTaskManager(config);

    // Payment gate: if marketplace payments are enabled, verify x402 payment
    if (config.a2a?.payment?.enabled && rpcRequest.method === "message/send") {
      // Rate-limit payment verification attempts to prevent DoS via fake tokens
      // triggering expensive on-chain calls.
      const clientIp = resolveGatewayClientIp({
        remoteAddr: req.socket?.remoteAddress ?? "",
        forwardedFor: getHeader(req, "x-forwarded-for"),
        realIp: getHeader(req, "x-real-ip"),
        trustedProxies: authOpts.trustedProxies,
      });
      if (clientIp && isPaymentRateLimited(clientIp)) {
        sendJson(res, 429, {
          jsonrpc: "2.0",
          error: { code: A2aErrorCodes.INTERNAL_ERROR, message: "Too many payment attempts" },
          id: rpcRequest.id,
        });
        return true;
      }
      let marketplace: import("../../memory/marketplace-economics.js").MarketplaceEconomics | null = null;
      try {
        const { MemoryIndexManager } = await import("../../memory/manager.js");
        const memManager = await MemoryIndexManager.get({
          cfg: config,
          agentId: "default",
          purpose: "status",
        });
        marketplace = memManager?.getMarketplaceEconomics?.() ?? null;
      } catch { /* memory manager not available */ }

      const paymentResult = await verifyA2aPayment(req, config, marketplace, rpcRequest.params as any);
      if (!paymentResult.paid) {
        // Plan 8, Phase 6: x402 native payment gate — spec-verified headers
        // x402 v2 uses three headers: PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE
        // All headers contain Base64-encoded JSON strings per x402.org spec.
        const paymentRequirements = {
          scheme: "exact",
          network: "base",
          maxAmountRequired: String(paymentResult.pricing?.priceUsdc ?? "0.01"),
          resource: req.url ?? "/a2a",
          description: "Payment required for skill execution",
          mimeType: "application/json",
          payTo: config.a2a?.payment?.x402?.address ?? "",
          maxTimeoutSeconds: 300,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        };
        const paymentRequiredB64 = Buffer.from(
          JSON.stringify([paymentRequirements]),
        ).toString("base64");
        res.setHeader("PAYMENT-REQUIRED", paymentRequiredB64);

        sendJson(res, 402, {
          jsonrpc: "2.0",
          error: {
            code: A2aErrorCodes.PAYMENT_REQUIRED,
            message: "Payment required for this task",
            data: {
              pricing: paymentResult.pricing,
              payTo: config.a2a?.payment?.x402?.address,
              chain: "base",
              token: "USDC",
            },
          },
          id: rpcRequest.id,
        });
        return true;
      }

      // Plan 8, Phase 6: x402 PAYMENT-RESPONSE header on successful settlement
      if (paymentResult.txHash) {
        const settlementResponse = {
          success: true,
          scheme: "exact",
          network: "base",
          transactionHash: paymentResult.txHash,
          payer: paymentResult.buyerPeerId ?? "unknown",
        };
        res.setHeader(
          "PAYMENT-RESPONSE",
          Buffer.from(JSON.stringify(settlementResponse)).toString("base64"),
        );
      }

      // Payment verified — record the sale + compute revenue shares
      if (paymentResult.txHash && marketplace) {
        try {
          const purchaseId = marketplace.recordPurchase({
            skillCrystalId: paymentResult.skillId ?? "unknown",
            buyerPeerId: paymentResult.buyerPeerId ?? "unknown",
            amountUsdc: paymentResult.amountUsdc ?? 0,
            txHash: paymentResult.txHash,
            direction: "sale",
          });

          // Plan 8, Phase 1: Queue revenue shares with 48h dispute hold
          if (paymentResult.amountUsdc && paymentResult.amountUsdc > 0) {
            try {
              const shares = marketplace.computeRevenueShares(
                paymentResult.skillId ?? "unknown",
                paymentResult.amountUsdc,
              );
              for (const share of shares) {
                if (share.peerId !== "local" && share.amountUsdc >= 0.001) {
                  marketplace.queueRevenuePayment({
                    skillCrystalId: paymentResult.skillId ?? "unknown",
                    purchaseId,
                    recipientPeerId: share.peerId,
                    amountUsdc: share.amountUsdc,
                    role: share.role,
                  });
                }
              }
            } catch { /* revenue sharing failure shouldn't block the sale */ }
          }
        } catch { /* non-critical */ }
      }
    }

    // SSE streaming for message/stream.
    if (isStreamingMethod(rpcRequest)) {
      const params = rpcRequest.params as { message?: unknown } | undefined;
      if (!params?.message) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: A2aErrorCodes.INVALID_PARAMS, message: "Missing message in params" },
          id: rpcRequest.id,
        });
        return true;
      }

      const sendParams = params as MessageSendParams;
      const task = manager.createTask(sendParams);
      manager.updateStatus(task.id, "working");
      streamTaskEvents({ res, taskId: task.id, taskManager: manager });

      // Spawn sub-agent execution in the background — SSE events are emitted
      // as the task manager transitions through states.
      const taskText = extractTaskText(sendParams);
      void executeA2aTask({ taskId: task.id, taskText, config, taskManager: manager });
      return true;
    }

    // Standard JSON-RPC request/response.
    const rpcResponse = handleA2aJsonRpc(rpcRequest, { taskManager: manager, config });
    const httpStatus = rpcResponse.error ? mapErrorToHttpStatus(rpcResponse.error.code) : 200;
    sendJson(res, httpStatus, rpcResponse);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function authorizeA2aRequest(
  req: IncomingMessage,
  config: BitterbotConfig,
  authOpts: {
    auth: ResolvedGatewayAuth;
    trustedProxies: string[];
    rateLimiter?: AuthRateLimiter;
  },
): Promise<{ ok: true } | { ok: false; result: import("../auth.js").GatewayAuthResult }> {
  const a2aAuthType = config.a2a?.authentication?.type ?? "bearer";
  if (a2aAuthType === "none") {
    return { ok: true };
  }

  // Allow local loopback without token.
  const clientIp = resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: getHeader(req, "x-forwarded-for"),
    realIp: getHeader(req, "x-real-ip"),
    trustedProxies: authOpts.trustedProxies,
  });
  if (clientIp && isPrivateOrLoopbackAddress(clientIp)) {
    return { ok: true };
  }

  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, result: { ok: false, reason: "unauthorized" } };
  }

  // Check A2A-specific bearer token first.
  const a2aToken = config.a2a?.authentication?.bearerToken;
  if (a2aToken && token === a2aToken) {
    return { ok: true };
  }

  // Fall back to gateway auth.
  const result = await authorizeGatewayConnect({
    auth: authOpts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: authOpts.trustedProxies,
    rateLimiter: authOpts.rateLimiter,
  });
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, result };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapErrorToHttpStatus(code: number): number {
  switch (code) {
    case A2aErrorCodes.UNAUTHORIZED:
      return 401;
    case A2aErrorCodes.TASK_NOT_FOUND:
      return 404;
    case A2aErrorCodes.INVALID_REQUEST:
    case A2aErrorCodes.INVALID_PARAMS:
      return 400;
    case A2aErrorCodes.METHOD_NOT_FOUND:
      return 404;
    case A2aErrorCodes.PARSE_ERROR:
      return 400;
    default:
      return 500;
  }
}
