/**
 * PLAN-29 Phase 3: Forage spectator RPCs.
 *
 * forage.tape  — recent bounty lifecycle events (The Tape), newest first.
 * forage.stats — the honest scoreboard: DPSV (7d + all-time, self-loops
 *                surfaced as excluded wash volume), open bounties, fill
 *                rate, median time-to-fill, distinct earners, stream
 *                check totals. Deliberately NO raw GMV number.
 *
 * Read-only pass-throughs over src/memory/bounty-tape.ts against the
 * marketplace db, same shape as memory.retrievalHealth (PLAN-28 B4).
 *
 * PLAN-29 §4.1: forage.post — the operator posting path. Behind gateway
 * auth (it commits this node's money); the bounty itself clears the same
 * funding sweep as any stranger's before hunters ever see it as 'open'.
 */

import type { DatabaseSync } from "node:sqlite";
import type { OracleSpec } from "../../memory/bounty-oracle.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getLocalWalletCapability } from "../../infra/wallet-discovery.js";
import { postForageBounty } from "../../memory/bounty-post.js";
import { getForageStats, getTape } from "../../memory/bounty-tape.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

type EconomicsLike = {
  getDb?: () => DatabaseSync | undefined;
  queueRevenuePayment?: (p: {
    skillCrystalId: string;
    purchaseId: string;
    recipientPeerId: string;
    amountUsdc: number;
    role: string;
  }) => void;
};

async function getBountyEconomics(): Promise<{
  db: DatabaseSync;
  economics: EconomicsLike;
} | null> {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) return null;
  const economics = (
    manager as unknown as { getMarketplaceEconomics?: () => EconomicsLike | null }
  ).getMarketplaceEconomics?.();
  const db = economics?.getDb?.();
  return db && economics ? { db, economics } : null;
}

async function getBountyDb(): Promise<DatabaseSync | null> {
  return (await getBountyEconomics())?.db ?? null;
}

const ORACLE_TYPES = new Set(["json", "contains", "regex", "judge"]);

function asOracleSpec(value: unknown): OracleSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const spec = value as { v?: unknown; type?: unknown; salt?: unknown };
  if (spec.v !== 1 || typeof spec.type !== "string" || !ORACLE_TYPES.has(spec.type)) return null;
  if (typeof spec.salt !== "string" || spec.salt.length === 0) return null;
  return value as OracleSpec;
}

async function resolveLocalWalletAddress(): Promise<string | null> {
  const advertised = getLocalWalletCapability()?.address;
  if (advertised) return advertised;
  // Capability advertising starts ~10s after boot; fall back to the wallet
  // service directly so posting works immediately.
  try {
    const cfg = loadConfig();
    const { createWalletService } = await import("../../services/wallet-service.js");
    return await createWalletService(cfg.tools?.wallet ?? {}).getAddress();
  } catch {
    return null;
  }
}

export const forageHandlers: GatewayRequestHandlers = {
  "forage.post": async ({ params, respond, context }) => {
    try {
      const bridge = context.orchestratorBridge;
      if (!bridge) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "orchestrator not connected; cannot gossip bounty"),
        );
        return;
      }
      const db = await getBountyDb();
      if (!db) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "bounty directory unavailable"),
        );
        return;
      }
      const wallet = await resolveLocalWalletAddress();
      if (!wallet) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "no wallet configured; a funded wallet is required"),
        );
        return;
      }
      const oracleSpec = asOracleSpec(params.oracleSpec);
      if (!oracleSpec) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "oracleSpec must be a v1 spec: {v:1, type:json|contains|regex|judge, salt, ...}",
          ),
        );
        return;
      }
      const kind = params.kind === "heartbeat" ? "heartbeat" : "oneshot";
      const expiresAt =
        typeof params.expiresAt === "number"
          ? params.expiresAt
          : typeof params.expiresInHours === "number"
            ? Date.now() + params.expiresInHours * 3_600_000
            : 0;

      let posterPeerId: string | undefined;
      try {
        posterPeerId = (await bridge.getIdentity()).peerId;
      } catch {
        /* identity optional on the local row */
      }

      const result = await postForageBounty({
        db,
        publish: (bounty) => bridge.publishBounty(bounty),
        posterPubkey: wallet,
        posterPeerId,
        posterWallet: wallet,
        input: {
          kind,
          category: typeof params.category === "string" ? params.category : "",
          specPublic: typeof params.specPublic === "string" ? params.specPublic : "",
          oracleSpec,
          rewardUsdc: typeof params.rewardUsdc === "number" ? params.rewardUsdc : 0,
          claimStakeUsdc:
            typeof params.claimStakeUsdc === "number" ? params.claimStakeUsdc : undefined,
          maxClaims: typeof params.maxClaims === "number" ? params.maxClaims : undefined,
          deadline: typeof params.deadline === "number" ? params.deadline : undefined,
          expiresAt,
        },
      });
      if (!result.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
        return;
      }
      respond(true, {
        bountyId: result.bountyId,
        oracleCommitment: result.oracleCommitment,
        fundingProof: result.fundingProof,
        posterWallet: wallet,
        status: "unverified",
        note: "promotes to 'open' on the next funding sweep if the wallet covers the reward",
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "forage.tape": async ({ params, respond }) => {
    try {
      const db = await getBountyDb();
      if (!db) {
        respond(true, { available: false, events: [] });
        return;
      }
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      respond(true, { available: true, events: getTape(db, { limit }) });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "forage.stats": async ({ respond }) => {
    try {
      const db = await getBountyDb();
      if (!db) {
        respond(true, { available: false });
        return;
      }
      respond(true, { available: true, ...getForageStats(db) });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  // PLAN-30 G0.5: operator surface for judge-capped settlements. A judge
  // pass above the unilateral cap parks money at 'held_review'; these two
  // verbs are how it finally moves (or doesn't). Behind gateway auth like
  // forage.post — releasing commits this node's money.
  "forage.review": async ({ respond }) => {
    try {
      const db = await getBountyDb();
      if (!db) {
        respond(true, { available: false, held: [] });
        return;
      }
      const held = db
        .prepare(
          `SELECT id, bounty_id, claim_id, hunter_pubkey, hunter_wallet, amount_usdc, created_at
             FROM bounty_settlements WHERE status = 'held_review' ORDER BY created_at`,
        )
        .all();
      respond(true, { available: true, held });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "forage.reviewRelease": async ({ params, respond }) => {
    try {
      const handle = await getBountyEconomics();
      if (!handle) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "bounty ledger unavailable"));
        return;
      }
      const settlementId = typeof params.settlementId === "string" ? params.settlementId : "";
      const approve = params.approve === true;
      if (!settlementId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "settlementId required; approve: true|false"),
        );
        return;
      }
      const { resolveHeldReview } = await import("../../memory/bounty-oracle.js");
      const outcome = resolveHeldReview(
        handle.db,
        {
          queueRevenuePayment: (p) => handle.economics.queueRevenuePayment?.(p),
        },
        settlementId,
        approve,
      );
      if (!outcome.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, outcome.error));
        return;
      }
      respond(true, {
        settlementId,
        status: outcome.status,
        amountUsdc: outcome.amountUsdc,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
