/**
 * memory.*: the owner's controls over what their agent remembers (PLAN-53 G1).
 * Reads need operator.read; changes and export are admin-only (not listed in
 * either set), like other irreversible operations.
 */

import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemoryIndexManager } from "../../memory/manager.js";
import { OwnerEditRefused } from "../../memory/owner-controls.js";
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
  const message = err instanceof Error ? err.message : String(err);
  respond(
    false,
    undefined,
    errorShape(
      err instanceof OwnerEditRefused ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      message,
    ),
  );
}

export const memoryHandlers: GatewayRequestHandlers = {
  "memory.list": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const kind = params.kind === "file" || params.kind === "all" ? params.kind : "own";
      respond(
        true,
        m.ownerListMemories({
          kind,
          q: str(params.q) || undefined,
          semanticType: str(params.semanticType) || undefined,
          cursor: typeof params.cursor === "number" ? params.cursor : undefined,
          limit: typeof params.limit === "number" ? params.limit : undefined,
        }),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  "memory.get": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const memory = m.ownerGetMemory(str(params.id));
      if (!memory) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no memory with that id"));
        return;
      }
      respond(true, memory);
    } catch (err) {
      fail(respond, err);
    }
  },

  "memory.edit": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      respond(
        true,
        await m.ownerEditMemory(str(params.id), typeof params.text === "string" ? params.text : ""),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  "memory.forget": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      await m.ownerForgetMemory(str(params.id));
      respond(true, { ok: true });
    } catch (err) {
      fail(respond, err);
    }
  },

  "memory.preferences": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      respond(true, { preferences: m.ownerListPreferences() });
    } catch (err) {
      fail(respond, err);
    }
  },

  "memory.forgetPreference": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      respond(true, { ok: await m.ownerDeletePreference(str(params.category), str(params.key)) });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** What happened to memories, newest first: forgotten, merged, edited (PLAN-53 G2). */
  "memory.audit": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      respond(true, {
        entries: m.ownerAuditLog({
          limit: num(params.limit),
          before: num(params.before),
          event: str(params.event),
        }),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  /**
   * The facts the agent treats as settled (the pinned ledger). `status`
   * (PLAN-55 Phase 0): "active" (default), "retired" (retired, owner_retired
   * and unconfirmed current rows) or "all".
   */
  "memory.facts": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const store = m.canonicalFacts();
      const status =
        params.status === "retired" || params.status === "all" ? params.status : "active";
      const facts = !store
        ? []
        : status === "active"
          ? store.listActive()
          : [
              ...(status === "all" ? store.listActive() : []),
              ...store.listByStatus(["retired", "owner_retired", "unconfirmed"]),
            ];
      respond(true, {
        facts: facts.map((f) => ({
          key: f.key,
          value: f.value,
          statement: f.statement,
          category: f.category,
          confidence: f.confidence,
          source: f.source,
          status: f.status,
        })),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  /**
   * Pin a fact as the owner (PLAN-55 Phase 0): the `owner` tier's writer.
   * Supersedes any agent or background belief for the key and brings back a
   * fact the owner had retired. `scope` is accepted and ignored until Phase 1
   * adds the column.
   */
  "memory.pinFact": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const result = await m.ownerPinFact({
        key: str(params.key),
        value: str(params.value),
        category: str(params.category) || undefined,
        statement: str(params.statement) || undefined,
      });
      if (!result.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.reason));
        return;
      }
      respond(true, result);
    } catch (err) {
      fail(respond, err);
    }
  },

  /**
   * Stop treating a fact as settled. Kept in its history. The owner's retire
   * is sticky (PLAN-55 Phase 0): extraction and the agent cannot bring the
   * same value back; memory.unretireFact or an owner pin can.
   */
  "memory.retireFact": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      respond(true, { ok: await m.ownerRetireFact(str(params.key)) });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Take a fact back out of retirement, whoever retired it. */
  "memory.unretireFact": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      respond(true, { ok: await m.ownerUnretireFact(str(params.key)) });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Everything the agent remembers, to a JSON file on this machine. */
  "memory.export": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(os.homedir(), ".bitterbot", "exports", `memory-${stamp}.json`);
      respond(true, await m.ownerExportMemories(file));
    } catch (err) {
      fail(respond, err);
    }
  },
};
