import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SkillEntry } from "../../agents/skills/types.js";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import type { JsonRpcRequest, MessageSendParams } from "./types.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import { authorizeGatewayConnect, isLocalDirectRequest } from "../auth.js";
import { sendJson, sendGatewayAuthFailure, readJsonBodyOrError } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";
import { getHeader } from "../http-utils.js";
import { resolveGatewayClientIp } from "../net.js";
import { checkBrowserOrigin } from "../origin-check.js";
import { buildAgentCard } from "./agent-card.js";
import { verifyA2aPayment, isPaymentRateLimited } from "./payment.js";
import { handleA2aJsonRpc, isStreamingMethod } from "./server.js";
import { streamTaskEvents } from "./streaming.js";
import { executeA2aTask, extractTaskText } from "./task-executor.js";
import { A2aTaskManager } from "./task-manager.js";
import { isTaskCreationRateLimited } from "./task-rate-limit.js";
import { A2aErrorCodes } from "./types.js";

const MAX_A2A_BODY_BYTES = 1_048_576; // 1 MB
const WELL_KNOWN_PATH = "/.well-known/agent.json";
const A2A_PATH = "/a2a";

/**
 * Open the persistent SQLite store for A2A tasks. Survives gateway restarts.
 * The caller owns the returned handle and is responsible for closing it.
 */
function openA2aTaskDb(externalDb?: DatabaseSync): DatabaseSync {
  if (externalDb) {
    return externalDb;
  }
  const stateDir = process.env.BITTERBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".bitterbot");
  const dbDir = path.join(stateDir, "a2a");
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "tasks.db"));
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export type A2aHttpHandler = {
  /** Process a single inbound HTTP request. Returns `true` if handled. */
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    authOpts: {
      auth: ResolvedGatewayAuth;
      trustedProxies: string[];
      rateLimiter?: AuthRateLimiter;
    },
  ) => Promise<boolean>;
  /**
   * Release the SQLite handle backing the task manager. Call once during
   * gateway shutdown. Safe to call multiple times.
   */
  close: () => void;
};

/**
 * Which circle verbs push a "circles" UI event when inbound stores
 * successfully: the content verbs AND circle/event.append — the shared-state
 * ledger that expenses, canvas cards, reactions, pins, and sandbox moves all
 * ride. Exported for tests: this whitelist going stale is exactly how ledger
 * panes went silently stale on the direct-dial path (8254135 review G1).
 */
export function circleInboundKind(
  method: string,
): "message" | "ask" | "answer" | "event" | undefined {
  switch (method) {
    case "circle/message":
      return "message";
    case "circle/ask":
      return "ask";
    case "circle/answer":
      return "answer";
    case "circle/event.append":
      return "event";
    default:
      return undefined;
  }
}

/**
 * Handle A2A HTTP requests in the gateway request pipeline.
 *
 * Handles:
 * - `GET /.well-known/agent.json` — Agent Card discovery (no auth)
 * - `POST /a2a` — JSON-RPC endpoint (auth required)
 *
 * State (task manager, DB handle, cached agent card) is owned by the returned
 * handler — multiple call sites in the same process produce isolated state.
 * Call `close()` during gateway shutdown to release the SQLite handle.
 */
export function createA2aHttpHandler(opts: {
  getConfig: () => BitterbotConfig;
  getSkills: () => SkillEntry[];
  getGatewayUrl: () => string;
  getSkillsVersion: () => number;
  /**
   * Fired when an inbound circle message/ask/answer is stored, so the gateway
   * can push a "circles" event to the UI instead of it polling (PLAN-36 Phase
   * 0). Best-effort; must never throw into the request path.
   */
  onCircleInbound?: (info: {
    circleId?: string;
    /** "event" = a ledger append (expense, canvas card, reaction, sandbox move). */
    kind: "message" | "ask" | "answer" | "event";
  }) => void;
  /** Optional pre-opened DB (for tests). */
  taskDb?: DatabaseSync;
}): A2aHttpHandler {
  const { getConfig, getSkills, getGatewayUrl, getSkillsVersion } = opts;
  const db = openA2aTaskDb(opts.taskDb);
  const ownsDb = opts.taskDb === undefined;
  let taskManager: A2aTaskManager | null = null;
  let cachedAgentCard: { json: string; version: number } | null = null;
  let closed = false;

  function getTaskManager(config: BitterbotConfig): A2aTaskManager {
    if (closed) {
      throw new Error("A2A handler has been closed");
    }
    if (!taskManager) {
      taskManager = new A2aTaskManager(db, config);
    }
    return taskManager;
  }

  const handle: A2aHttpHandler["handle"] = async (req, res, authOpts) => {
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
          const memManager = await MemoryIndexManager.get({
            cfg: config,
            agentId: "default",
            purpose: "status",
          });
          const marketplace = memManager?.getMarketplaceEconomics?.();
          if (marketplace) {
            const listings = marketplace.getListableSkills();
            skillPrices = new Map(listings.map((l) => [l.skillCrystalId, l.priceUsdc]));
          }
        } catch {
          /* non-critical */
        }
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

    // Circle and mailbox verbs ride /a2a as circles' HTTP fallback transport
    // (delivery order: P2P dial -> HTTP direct dial -> mailbox, and the
    // mailbox IS HTTP by design), so the endpoint must answer while EITHER
    // surface is enabled. Each verb family is gated on its own flag below:
    // a2a.enabled for the agent-native surface (message/send, tasks/*,
    // forage/*), circles.* for circle/mailbox (adjudicated D-D, PLAN-41).
    const config = getConfig();
    const a2aEnabled = config.a2a?.enabled === true;
    const circlesEnabled = config.circles?.enabled === true;
    if (!a2aEnabled && !circlesEnabled) {
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

    // Browsers attach an Origin header to cross-site POSTs; real A2A peers
    // (CLI agents, daemons, curl) do not send one. An Origin naming anywhere
    // other than this gateway means a browser is being used as a confused
    // deputy (CSRF / DNS rebinding), so reject before reading the body. This
    // also shields the deliberately token-exempt forage/circle/mailbox verbs,
    // which would otherwise be reachable from any web page the operator
    // happens to visit (audit p0-9).
    const originHeader = getHeader(req, "origin");
    if (originHeader !== undefined) {
      const originCheck = checkBrowserOrigin({
        requestHost: getHeader(req, "host"),
        origin: originHeader,
      });
      if (!originCheck.ok) {
        sendJson(res, 403, {
          jsonrpc: "2.0",
          error: { code: A2aErrorCodes.UNAUTHORIZED, message: "Forbidden" },
          id: null,
        });
        return true;
      }
    }

    // Parse JSON-RPC body BEFORE auth: forage/* verbs are served to
    // anonymous hunters (see below), and we cannot route on the method
    // without the body. The read is size-capped, so unauthenticated
    // callers cannot make us buffer more than MAX_A2A_BODY_BYTES.
    const body = await readJsonBodyOrError(req, res, MAX_A2A_BODY_BYTES);
    if (body === undefined) {
      return true; // readJsonBodyOrError already sent the error response.
    }

    const rpcRequest = body as JsonRpcRequest;
    if (typeof rpcRequest.method !== "string" || rpcRequest.method.length === 0) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: A2aErrorCodes.INVALID_REQUEST, message: "Invalid JSON-RPC request" },
        id: (rpcRequest as { id?: unknown })?.id !== undefined ? rpcRequest.id : null,
      });
      return true;
    }

    const isForageVerb = rpcRequest.method.startsWith("forage/");
    const isCircleVerb = rpcRequest.method.startsWith("circle/");
    const isMailboxVerb = rpcRequest.method.startsWith("mailbox/");

    // With a2a off, only circles' transport verbs exist here. Everything
    // else answers METHOD_NOT_FOUND — the same invisible-surface shape as
    // the circles kill switch below — except notifications, which per
    // JSON-RPC get their usual accept-and-discard 204.
    if (!a2aEnabled && !isCircleVerb && !isMailboxVerb) {
      if ((rpcRequest as { id?: unknown }).id === undefined) {
        res.statusCode = 204;
        res.end();
        return true;
      }
      sendJson(res, 404, {
        jsonrpc: "2.0",
        error: { code: A2aErrorCodes.METHOD_NOT_FOUND, message: "Method not found" },
        id: rpcRequest.id,
      });
      return true;
    }

    // Authenticate — bearer token or local loopback. Forage verbs are
    // exempt BY DESIGN (PLAN-29): hunters are anonymous peers with no way
    // to hold our token; admission is gated on funding, claim caps, stake,
    // deliverable size caps, and injection scanning — not identity. The
    // money-bearing surfaces (message/send x402 gate, tasks) stay authed.
    // Circle verbs (PLAN-31 C1) are likewise exempt from the bearer token:
    // they carry their OWN auth — an Ed25519-signed circle/v1 envelope whose
    // author must be an active circle member holding the verb's scope
    // (default-deny, the friend branch), or an invite secret for circle/join.
    // Mailbox verbs carry per-verb Ed25519 proofs (sender for post,
    // recipient for poll/ack) — a mailbox host serves strangers by design.
    if (!isForageVerb && !isCircleVerb && !isMailboxVerb) {
      const authOk = await authorizeA2aRequest(req, config, authOpts);
      if (!authOk.ok) {
        sendGatewayAuthFailure(res, authOk.result);
        return true;
      }
    }

    // JSON-RPC 2.0: a request without `id` is a notification. Per spec the
    // server MUST NOT respond to notifications. A2A's defined methods all
    // expect responses, so we accept-and-discard rather than error so a
    // misbehaving notification client doesn't break later request handling
    // on the same socket.
    const isNotification = (rpcRequest as { id?: unknown }).id === undefined;
    if (isNotification) {
      res.statusCode = 204;
      res.end();
      return true;
    }

    // PLAN-29 Phase 1.2: Forage bounty verbs (claim/deliver/verdict). Served
    // poster-side against the local bounty tables; free (no x402 gate — the
    // money flows the other way, poster -> hunter, at settlement). Handled
    // here rather than in the sync dispatcher because they need the
    // marketplace db, resolved async like the payment gate below.
    if (isForageVerb) {
      const { handleForageMethod } = await import("./forage.js");
      let forageDb: import("node:sqlite").DatabaseSync | undefined;
      try {
        const { MemoryIndexManager } = await import("../../memory/manager.js");
        const memManager = await MemoryIndexManager.get({
          cfg: config,
          agentId: "default",
          purpose: "status",
        });
        forageDb = (
          memManager?.getMarketplaceEconomics?.() as
            | { getDb?: () => import("node:sqlite").DatabaseSync | undefined }
            | null
            | undefined
        )?.getDb?.();
      } catch {
        /* memory manager unavailable */
      }
      if (!forageDb) {
        sendJson(res, 503, {
          jsonrpc: "2.0",
          error: {
            code: A2aErrorCodes.INTERNAL_ERROR,
            message: "Bounty directory unavailable on this node",
          },
          id: rpcRequest.id,
        });
        return true;
      }
      const outcome = handleForageMethod(
        rpcRequest.method as string,
        rpcRequest.params,
        forageDb,
        Date.now(),
        {
          poolsEnabled: config.forage?.pools?.enabled === true,
        },
      );
      sendJson(
        res,
        200,
        outcome.ok
          ? { jsonrpc: "2.0", result: outcome.result, id: rpcRequest.id }
          : { jsonrpc: "2.0", error: outcome.error, id: rpcRequest.id },
      );
      // PLAN-30 G0.1: probabilistic re-observation of accepted check-ins.
      // Runs AFTER the response is sent — the sync handler cannot fetch, and
      // blocking the checkin reply on our audit fetch would both slow honest
      // hunters and leak audit timing. On by default; kill switch
      // forage.audit.enabled=false.
      if (
        rpcRequest.method === "forage/checkin" &&
        outcome.ok &&
        config.forage?.audit?.enabled === true
      ) {
        const claimId = (rpcRequest.params as { claimId?: string } | undefined)?.claimId;
        const auditDb = forageDb;
        if (claimId && auditDb) {
          void import("../../memory/bounty-audit.js")
            .then(({ auditCheckinIfDue }) =>
              auditCheckinIfDue({ db: auditDb, streamId: claimId, fetchImpl: fetch }),
            )
            .catch(() => {
              /* audit is best-effort; the module logs its own outcomes */
            });
        }
      }
      return true;
    }

    // PLAN-31 C1: circle verbs — the friend branch. Kill-switched
    // (circles.enabled, ON by default since the 2026-07-09 red-team phase, §8);
    // explicitly-disabled nodes answer METHOD_NOT_FOUND so the surface is invisible.
    // Auth is per-verb inside handleCircleMethod: signed circle/v1 envelope
    // + active membership + scope (default-deny) + per-member rate limits;
    // circle/join proves possession of the invite secret instead.
    if (isCircleVerb) {
      if (config.circles?.enabled !== true) {
        sendJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: A2aErrorCodes.METHOD_NOT_FOUND, message: "Method not found" },
          id: rpcRequest.id,
        });
        return true;
      }
      const { handleCircleMethod } = await import("./circles.js");
      let circleDb: import("node:sqlite").DatabaseSync | undefined;
      try {
        const { MemoryIndexManager } = await import("../../memory/manager.js");
        const { resolveDefaultAgentId } = await import("../../agents/agent-scope.js");
        const memManager = await MemoryIndexManager.get({
          cfg: config,
          // The RESOLVED default agent (DEFAULT_AGENT_ID = "main"), NOT the
          // literal "default": circle membership/mailbox live in the primary
          // agent's DB, so serving from the wrong DB would reject every peer as
          // a non-member. (Pre-PLAN-36 this used "default" and effectively
          // couldn't receive circle traffic on a multi-agent node.)
          agentId: resolveDefaultAgentId(config),
          purpose: "status",
        });
        // Independent of the marketplace feature (PLAN-36 §7 Phase 0): the
        // circle tables live in the memory DB, so getCirclesDb() returns it
        // even when a2a.marketplace is disabled. Called without optional
        // chaining on the method so a rename fails the build, not silently 503s.
        circleDb = memManager?.getCirclesDb();
      } catch {
        /* memory manager unavailable */
      }
      if (!circleDb) {
        sendJson(res, 503, {
          jsonrpc: "2.0",
          error: {
            code: A2aErrorCodes.INTERNAL_ERROR,
            message: "Circles unavailable on this node",
          },
          id: rpcRequest.id,
        });
        return true;
      }
      const outcome = handleCircleMethod(
        rpcRequest.method,
        rpcRequest.params,
        circleDb,
        Date.now(),
      );
      // Push a "circles" event to the UI on freshly-stored inbound so it
      // appears without waiting for a poll (PLAN-36 Phase 0). Best-effort.
      if (outcome.ok && opts.onCircleInbound) {
        const inboundKind = circleInboundKind(rpcRequest.method);
        if (inboundKind) {
          const circleId = (rpcRequest.params as { envelope?: { circle_id?: string } })?.envelope
            ?.circle_id;
          try {
            opts.onCircleInbound({ circleId, kind: inboundKind });
          } catch {
            /* never let a UI notification break the request path */
          }
        }
      }
      sendJson(
        res,
        200,
        outcome.ok
          ? { jsonrpc: "2.0", result: outcome.result, id: rpcRequest.id }
          : { jsonrpc: "2.0", error: outcome.error, id: rpcRequest.id },
      );
      return true;
    }

    // PLAN-31 C1 §3.2: mailbox host verbs — store-and-forward for peers with
    // asymmetric online windows. Only nodes that opted into serving
    // (circles.mailbox.serve) expose these; blobs are sealed to recipients'
    // box keys, so this host stores what it cannot read.
    if (isMailboxVerb) {
      if (config.circles?.enabled !== true || config.circles?.mailbox?.serve !== true) {
        sendJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: A2aErrorCodes.METHOD_NOT_FOUND, message: "Method not found" },
          id: rpcRequest.id,
        });
        return true;
      }
      const { handleMailboxMethod } = await import("./mailbox.js");
      let mailboxDb: import("node:sqlite").DatabaseSync | undefined;
      try {
        const { MemoryIndexManager } = await import("../../memory/manager.js");
        const { resolveDefaultAgentId } = await import("../../agents/agent-scope.js");
        const memManager = await MemoryIndexManager.get({
          cfg: config,
          // Resolved default agent (see the circle-verb branch above): the
          // hosted mailbox lives in the primary agent's DB.
          agentId: resolveDefaultAgentId(config),
          purpose: "status",
        });
        // Independent of the marketplace feature (PLAN-36 §7 Phase 0), same as
        // the circle-verb branch above (method called without optional chaining
        // so a rename is a compile error, not a silent 503).
        mailboxDb = memManager?.getCirclesDb();
      } catch {
        /* memory manager unavailable */
      }
      if (!mailboxDb) {
        sendJson(res, 503, {
          jsonrpc: "2.0",
          error: {
            code: A2aErrorCodes.INTERNAL_ERROR,
            message: "Mailbox unavailable on this node",
          },
          id: rpcRequest.id,
        });
        return true;
      }
      const outcome = handleMailboxMethod(
        rpcRequest.method,
        rpcRequest.params,
        mailboxDb,
        Date.now(),
      );
      sendJson(
        res,
        200,
        outcome.ok
          ? { jsonrpc: "2.0", result: outcome.result, id: rpcRequest.id }
          : { jsonrpc: "2.0", error: outcome.error, id: rpcRequest.id },
      );
      return true;
    }

    const manager = getTaskManager(config);

    // Task-spawn rate limit: message/send and message/stream each start a
    // sub-agent run. On a publicly-reachable node a burst of peer messages
    // (e.g. repeated "hi") would spin up a session apiece; the payment
    // limiter below only covers the payment path and only when payments are
    // on. Apply a uniform per-client ceiling BEFORE any task is created.
    // tasks/get and other read verbs are not gated.
    if (rpcRequest.method === "message/send" || isStreamingMethod(rpcRequest)) {
      const clientIp = resolveGatewayClientIp({
        remoteAddr: req.socket?.remoteAddress ?? "",
        forwardedFor: getHeader(req, "x-forwarded-for"),
        realIp: getHeader(req, "x-real-ip"),
        trustedProxies: authOpts.trustedProxies,
      });
      if (isTaskCreationRateLimited(clientIp ?? "unknown", config.a2a?.maxTasksPerMinute)) {
        sendJson(res, 429, {
          jsonrpc: "2.0",
          error: {
            code: A2aErrorCodes.INTERNAL_ERROR,
            message: "Too many task requests; slow down",
          },
          id: rpcRequest.id,
        });
        return true;
      }
    }

    // PLAN-43 s3.2b: cap inbound message text BEFORE the payment gate, so
    // an oversize request is refused rather than charged-then-refused.
    if (rpcRequest.method === "message/send" || isStreamingMethod(rpcRequest)) {
      const maxInputChars = Math.min(
        config.a2a?.remoteExecution?.maxInputChars ?? 32_000,
        1_000_000,
      );
      // Measure the exact text the executor would spawn with (part joins
      // included), so per-part accounting can't be gamed with many parts.
      let textChars = 0;
      try {
        textChars = extractTaskText(rpcRequest.params as MessageSendParams).length;
      } catch {
        textChars = 0; // malformed params fail later in the branch's own validation
      }
      if (textChars > maxInputChars) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: {
            code: A2aErrorCodes.INVALID_PARAMS,
            message: `Message text exceeds ${maxInputChars} characters`,
          },
          id: rpcRequest.id,
        });
        return true;
      }
    }

    // Payment gate: if marketplace payments are enabled, verify x402 payment.
    // PLAN-43 s3.2b fix: message/stream spawns the SAME task executor as
    // message/send and previously bypassed this gate entirely.
    if (
      config.a2a?.payment?.enabled &&
      (rpcRequest.method === "message/send" || isStreamingMethod(rpcRequest))
    ) {
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
      let marketplace: import("../../memory/marketplace-economics.js").MarketplaceEconomics | null =
        null;
      try {
        const { MemoryIndexManager } = await import("../../memory/manager.js");
        const memManager = await MemoryIndexManager.get({
          cfg: config,
          agentId: "default",
          purpose: "status",
        });
        marketplace = memManager?.getMarketplaceEconomics?.() ?? null;
      } catch {
        /* memory manager not available */
      }

      const paymentResult = await verifyA2aPayment(
        req,
        config,
        marketplace,
        rpcRequest.params as {
          skillId?: string;
          message?: { parts?: Array<{ type: string; text?: string }> };
        },
      );
      if (!paymentResult.paid) {
        // Plan 8, Phase 6: x402 native payment gate — spec-verified headers
        // x402 v2 uses three headers: PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE
        // All headers contain Base64-encoded JSON strings per x402.org spec.
        //
        // payTo must use the SAME fallback chain as verification
        // (payment.ts:83), otherwise auto-derived-address nodes advertise an
        // empty payTo and buyers have nowhere to send funds. Network + asset
        // must match the network verification will check against — a mainnet
        // asset advertised by a sepolia node makes every payment unverifiable.
        const { getLocalWalletCapability } = await import("../../infra/wallet-discovery.js");
        const payTo =
          config.a2a?.payment?.x402?.address ?? getLocalWalletCapability()?.address ?? "";
        const payNetwork = (config.tools?.wallet?.network ?? "base") as "base" | "base-sepolia";
        const usdcAsset =
          payNetwork === "base-sepolia"
            ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e" // USDC on Base Sepolia
            : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
        const paymentRequirements = {
          scheme: "exact",
          network: payNetwork,
          maxAmountRequired: String(paymentResult.pricing?.priceUsdc ?? "0.01"),
          resource: req.url ?? "/a2a",
          description: "Payment required for skill execution",
          mimeType: "application/json",
          payTo,
          maxTimeoutSeconds: 300,
          asset: usdcAsset,
        };
        const paymentRequiredB64 = Buffer.from(JSON.stringify([paymentRequirements])).toString(
          "base64",
        );
        res.setHeader("PAYMENT-REQUIRED", paymentRequiredB64);

        sendJson(res, 402, {
          jsonrpc: "2.0",
          error: {
            code: A2aErrorCodes.PAYMENT_REQUIRED,
            message: "Payment required for this task",
            data: {
              pricing: paymentResult.pricing,
              payTo: payTo || undefined,
              chain: payNetwork,
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
            } catch {
              /* revenue sharing failure shouldn't block the sale */
            }
          }
        } catch {
          /* non-critical */
        }
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

  return {
    handle,
    close: () => {
      if (closed) return;
      closed = true;
      taskManager = null;
      cachedAgentCard = null;
      if (ownsDb) {
        try {
          db.close();
        } catch {
          // best-effort
        }
      }
    },
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

  // Token-exempt path: genuinely local, direct requests only — loopback
  // socket, local Host, no proxy headers (unless from a trusted proxy). The
  // previous check waived auth for ALL RFC1918/CGNAT sources, which turned
  // bind=lan (the docker-compose default) into tokenless agent execution for
  // anyone on the LAN or tailnet (audit p0-9). Same gate as the HTTP control
  // surfaces (server-http.ts).
  if (isLocalDirectRequest(req, authOpts.trustedProxies)) {
    return { ok: true };
  }

  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, result: { ok: false, reason: "unauthorized" } };
  }

  // Check A2A-specific bearer token first.
  const a2aToken = config.a2a?.authentication?.bearerToken;
  if (a2aToken && safeEqualSecret(token, a2aToken)) {
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
