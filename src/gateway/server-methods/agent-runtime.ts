import type { GatewayRequestHandlers } from "./types.js";
import {
  getCompactionBreakerSnapshot,
  listCompactionBreakers,
} from "../../agents/pi-embedded-runner/compaction-circuit-breaker.js";
import { getCacheMetrics, listCacheMetrics } from "../../agents/prompt-cache-monitor.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

/**
 * Live read of agent-runtime in-memory state inside the gateway process.
 * Used by `bitterbot doctor` (when the gateway is up) to surface cache
 * hit ratios and compaction breaker state that aren't accessible from a
 * fresh CLI invocation.
 *
 * Filterable by sessionKey so a long-lived gateway with many sessions
 * doesn't return a 100KB payload by default.
 */
export const agentRuntimeHandlers: GatewayRequestHandlers = {
  "agent.runtime.health": ({ params, respond }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";
    const limitRaw = typeof params?.limit === "number" ? params.limit : 25;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 25;

    if (sessionKey) {
      respond(
        true,
        {
          cache: getCacheMetrics(sessionKey),
          breaker: getCompactionBreakerSnapshot(sessionKey),
        },
        undefined,
      );
      return;
    }

    try {
      const cacheList = listCacheMetrics().slice(0, limit);
      const breakerList = listCompactionBreakers().slice(0, limit);
      respond(
        true,
        {
          cache: cacheList,
          breakers: breakerList,
          truncated: {
            cache: cacheList.length === limit,
            breakers: breakerList.length === limit,
          },
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
