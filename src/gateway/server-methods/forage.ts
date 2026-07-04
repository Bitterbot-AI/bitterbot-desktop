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
 */

import type { DatabaseSync } from "node:sqlite";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getForageStats, getTape } from "../../memory/bounty-tape.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

async function getBountyDb(): Promise<DatabaseSync | null> {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const { manager } = await getMemorySearchManager({ cfg, agentId });
  if (!manager) return null;
  const economics = (
    manager as unknown as {
      getMarketplaceEconomics?: () => { getDb?: () => DatabaseSync | undefined } | null;
    }
  ).getMarketplaceEconomics?.();
  return economics?.getDb?.() ?? null;
}

export const forageHandlers: GatewayRequestHandlers = {
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
};
