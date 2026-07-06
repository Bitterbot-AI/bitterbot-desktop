/**
 * PLAN-29 §4.1 follow-up: the `forage` agent tool — the conversational half
 * of bounty discovery. Night Shift hunts autonomously and the dashboard
 * serves humans, but until this tool, an agent asked "are there any bounties
 * on the network?" had no way to look: it would web-search or grep docs and
 * honestly conclude it had no live feed (observed in the wild on day one).
 *
 * Read-only BY DESIGN. Posting commits the node's money and stays behind the
 * operator-authed forage.post gateway RPC; hunting stays with Night Shift's
 * capped autonomous sweep. This tool only answers questions.
 */

import type { DatabaseSync } from "node:sqlite";
import { Type } from "@sinclair/typebox";
import type { BitterbotConfig } from "../../config/types.bitterbot.js";
import type { AnyAgentTool } from "./common.js";
import { getForageStats } from "../../memory/bounty-tape.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ForageSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("stats"),
    Type.Literal("mine"),
    Type.Literal("hunts"),
  ]),
  limit: Type.Optional(Type.Number()),
});

async function getBountyDb(cfg: BitterbotConfig, agentId: string): Promise<DatabaseSync | null> {
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) return null;
  const economics = (
    manager as unknown as {
      getMarketplaceEconomics?: () => { getDb?: () => DatabaseSync | undefined } | null;
    }
  ).getMarketplaceEconomics?.();
  return economics?.getDb?.() ?? null;
}

/** Strip the machine block (heartbeat terms JSON) so spec excerpts read as prose. */
function specExcerpt(specPublic: string): string {
  const brace = specPublic.indexOf("{");
  const prose = brace > 0 ? specPublic.slice(0, brace) : specPublic;
  const trimmed = prose.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function listOpenBounties(db: DatabaseSync, limit: number, now: number) {
  const rows = db
    .prepare(
      `SELECT bounty_id, kind, category, reward_usdc, claim_stake_usdc, max_claims,
              is_local, spec_public, deadline, expires_at, poster_pubkey
         FROM bounty_posts
        WHERE status = 'open' AND expires_at > ?
        ORDER BY reward_usdc DESC, created_at DESC LIMIT ?`,
    )
    .all(now, limit) as unknown as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    bountyId: r.bounty_id,
    kind: r.kind,
    category: r.category,
    rewardUsdc: r.reward_usdc,
    claimStakeUsdc: r.claim_stake_usdc,
    maxClaims: r.max_claims,
    postedByThisNode: r.is_local === 1,
    spec: specExcerpt(String(r.spec_public)),
    expiresAt: new Date(Number(r.expires_at)).toISOString(),
  }));
}

function listMine(db: DatabaseSync, limit: number) {
  const rows = db
    .prepare(
      `SELECT b.bounty_id, b.kind, b.category, b.reward_usdc, b.status, b.expires_at,
              (SELECT COUNT(*) FROM bounty_claims c WHERE c.bounty_id = b.bounty_id) AS claims,
              (SELECT COUNT(*) FROM bounty_settlements s
                WHERE s.bounty_id = b.bounty_id AND s.oracle_verdict = 'pass') AS settlements,
              (SELECT COALESCE(SUM(st.checks_total), 0) FROM bounty_streams st
                WHERE st.bounty_id = b.bounty_id) AS streamChecks
         FROM bounty_posts b WHERE b.is_local = 1
        ORDER BY b.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    bountyId: r.bounty_id,
    kind: r.kind,
    category: r.category,
    rewardUsdc: r.reward_usdc,
    status: r.status,
    claims: r.claims,
    settlements: r.settlements,
    streamChecks: r.streamChecks,
    expiresAt: new Date(Number(r.expires_at)).toISOString(),
  }));
}

function listHunts(db: DatabaseSync, limit: number) {
  const rows = db
    .prepare(
      `SELECT bounty_id, category, kind, status, checks_sent, earned_usdc,
              reward_usdc, claimed_at, last_action_at
         FROM forage_hunts ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, string | number>>;
  const totals = db
    .prepare(`SELECT COALESCE(SUM(earned_usdc), 0) AS earned, COUNT(*) AS hunts FROM forage_hunts`)
    .get() as { earned: number; hunts: number };
  return {
    totalEarnedUsdc: totals.earned,
    totalHunts: totals.hunts,
    hunts: rows.map((r) => ({
      bountyId: r.bounty_id,
      category: r.category,
      kind: r.kind,
      status: r.status,
      checksSent: r.checks_sent,
      earnedUsdc: r.earned_usdc,
      claimedAt: new Date(Number(r.claimed_at)).toISOString(),
    })),
  };
}

export function createForageTool(options: {
  config?: BitterbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return {
    label: "Forage",
    name: "forage",
    description:
      "Query the Forage P2P bounty economy (sometimes misheard as 'forge'). " +
      "action=list: open USDC bounties on the mesh available to hunt. " +
      "action=stats: the honest scoreboard (DPSV, open bounties, fill rate, distinct earners). " +
      "action=mine: bounties this node posted and their claim/settlement state. " +
      "action=hunts: what this node's Night Shift has claimed and earned. " +
      "Read-only; always use this instead of guessing when asked about bounties, " +
      "agent earnings, or the agent economy.",
    parameters: ForageSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      const limit = Math.min(Math.max(readNumberParam(params, "limit") ?? 20, 1), 100);
      const db = await getBountyDb(cfg, agentId);
      if (!db) {
        return jsonResult({
          available: false,
          error: "bounty directory unavailable (marketplace db not initialized on this node)",
        });
      }
      try {
        const now = Date.now();
        switch (action) {
          case "list": {
            const bounties = listOpenBounties(db, limit, now);
            return jsonResult({
              available: true,
              openBounties: bounties.length,
              bounties,
              note:
                bounties.length === 0
                  ? "No open bounties in this node's directory right now. New bounties " +
                    "arrive via mesh gossip and open after their funding check passes."
                  : "Hunting is autonomous (Night Shift) for heartbeat/monitoring bounties " +
                    "within caps; this list is for answering questions, not for claiming.",
            });
          }
          case "stats":
            return jsonResult({ available: true, ...getForageStats(db) });
          case "mine":
            return jsonResult({ available: true, posted: listMine(db, limit) });
          case "hunts":
            return jsonResult({ available: true, ...listHunts(db, limit) });
          default:
            return jsonResult({
              error: `unknown action '${action}' (expected list | stats | mine | hunts)`,
            });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ available: false, error: message });
      }
    },
  };
}
