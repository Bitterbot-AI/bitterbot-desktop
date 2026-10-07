/**
 * PLAN-54: the curiosity loop's control surface. The agent researches its own
 * questions without asking; the owner can see all of it here and stop it.
 * Owner-only like the memory controls (same manager, same agent scope).
 */

import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemoryIndexManager } from "../../memory/manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

async function memoryManager(agentId?: string): Promise<MemoryIndexManager> {
  const cfg = loadConfig();
  const { manager, error } = await getMemorySearchManager({
    cfg,
    agentId: agentId?.trim() || resolveDefaultAgentId(cfg),
  });
  if (!manager) {
    throw new Error(error ?? "memory is not available");
  }
  return manager as unknown as MemoryIndexManager;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function fail(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"], err: unknown) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
  );
}

export const curiosityHandlers: GatewayRequestHandlers = {
  "curiosity.status": async ({ params, respond }) => {
    try {
      respond(true, await (await memoryManager(str(params.agentId))).curiosityStatus());
    } catch (err) {
      fail(respond, err);
    }
  },

  "curiosity.list": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      respond(
        true,
        await m.curiosityList(typeof params.limit === "number" ? params.limit : undefined),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  "curiosity.pause": async ({ params, respond }) => {
    try {
      await (await memoryManager(str(params.agentId))).curiosityPause(true);
      respond(true, { paused: true });
    } catch (err) {
      fail(respond, err);
    }
  },

  "curiosity.resume": async ({ params, respond }) => {
    try {
      await (await memoryManager(str(params.agentId))).curiosityPause(false);
      respond(true, { paused: false });
    } catch (err) {
      fail(respond, err);
    }
  },

  "curiosity.dismiss": async ({ params, respond }) => {
    try {
      const id = str(params.id);
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
        return;
      }
      respond(true, {
        dismissed: await (await memoryManager(str(params.agentId))).curiosityDismiss(id),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "curiosity.ask": async ({ params, respond }) => {
    try {
      const question = str(params.question).slice(0, 300);
      if (question.length < 8) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "question too short"));
        return;
      }
      const id = await (await memoryManager(str(params.agentId))).curiosityAsk(question);
      respond(true, { id, queued: id !== null });
    } catch (err) {
      fail(respond, err);
    }
  },

  "curiosity.runNow": async ({ params, respond }) => {
    try {
      respond(true, (await memoryManager(str(params.agentId))).curiosityRunNow());
    } catch (err) {
      fail(respond, err);
    }
  },
};
