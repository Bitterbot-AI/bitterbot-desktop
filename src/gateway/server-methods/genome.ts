/**
 * The Temperament offer for existing agents (the Control UI card and
 * `bitterbot genome temperament`). Status is read-only; apply is an owner
 * write to GENOME.md (admin scope), announced to the genome guard and backed
 * up first (src/agents/genome-temperament.ts). Only the Temperament section
 * is ever written.
 */

import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  addTemperament,
  readTemperamentStatus,
  setTemperamentLevel,
} from "../../agents/genome-temperament.js";
import { loadConfig } from "../../config/config.js";
import {
  DEFAULT_TEMPERAMENT_LEVEL,
  isTemperamentLevel,
  TEMPERAMENT_LEVELS,
} from "../../memory/genome-parser.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type Respond = Parameters<GatewayRequestHandlers[string]>[0]["respond"];

function resolveWorkspace(params: Record<string, unknown>, respond: Respond): string | null {
  const cfg = loadConfig();
  const raw = typeof params.agentId === "string" ? params.agentId.trim() : "";
  const agentId = raw ? normalizeAgentId(raw) : resolveDefaultAgentId(cfg);
  if (raw && !listAgentIds(cfg).includes(agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  return resolveAgentWorkspaceDir(cfg, agentId);
}

function readLevel(params: Record<string, unknown>, respond: Respond) {
  const level = params.level ?? undefined;
  if (level === undefined) {
    return { ok: true as const, level: undefined };
  }
  if (!isTemperamentLevel(level)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `level must be one of ${TEMPERAMENT_LEVELS.join(", ")}`,
      ),
    );
    return { ok: false as const };
  }
  return { ok: true as const, level };
}

function fail(respond: Respond, err: unknown) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
  );
}

export const genomeHandlers: GatewayRequestHandlers = {
  /** { present, level?, preview, genomeExists, genomePath, levels } */
  "genome.temperament.status": async ({ params, respond }) => {
    const workspaceDir = resolveWorkspace(params, respond);
    if (!workspaceDir) {
      return;
    }
    const level = readLevel(params, respond);
    if (!level.ok) {
      return;
    }
    try {
      const status = await readTemperamentStatus(workspaceDir, { previewLevel: level.level });
      respond(true, {
        ...status,
        levels: TEMPERAMENT_LEVELS,
        defaultLevel: DEFAULT_TEMPERAMENT_LEVEL,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  /**
   * `{ action: "add", level? }` appends the section to a Genome without one;
   * `{ action: "setLevel", level }` changes the level of an existing one.
   */
  "genome.temperament.apply": async ({ params, respond }) => {
    const workspaceDir = resolveWorkspace(params, respond);
    if (!workspaceDir) {
      return;
    }
    const level = readLevel(params, respond);
    if (!level.ok) {
      return;
    }
    try {
      if (params.action === "add") {
        respond(true, await addTemperament(workspaceDir, level.level));
        return;
      }
      if (params.action === "setLevel") {
        if (!level.level) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "level is required"));
          return;
        }
        respond(true, await setTemperamentLevel(workspaceDir, level.level));
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, 'action must be "add" or "setLevel"'),
      );
    } catch (err) {
      fail(respond, err);
    }
  },
};
