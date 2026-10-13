/**
 * memory.*: the owner's controls over what their agent remembers (PLAN-53 G1).
 * Reads need operator.read; changes, export and import are admin-only (not
 * listed in either set), like other irreversible operations. PLAN-55 Phase 3:
 * memory.forgetPreview (read) shows what a forget or an edit would also
 * change; memory.forget / memory.edit take `preview: true` and the
 * previewed `planHash`; memory.exportDownload hands out a one-time download
 * link; memory.import restores an export.
 */

import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemoryIndexManager } from "../../memory/manager.js";
import { MemoryImportRefused, parseMemoryExport } from "../../memory/memory-import.js";
import { OwnerEditRefused } from "../../memory/owner-controls.js";
import { normalizeControlUiBasePath } from "../control-ui-shared.js";
import { mintMemoryExportToken } from "../memory-export-http.js";
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
      err instanceof OwnerEditRefused || err instanceof MemoryImportRefused
        ? ErrorCodes.INVALID_REQUEST
        : ErrorCodes.UNAVAILABLE,
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

  /**
   * Replace a memory's text (PLAN-55 Phase 3: a new memory replaces the old
   * one, with the cascade). `preview: true` returns the plan without
   * changing anything; `planHash` refuses when the plan changed since.
   */
  "memory.edit": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const text = typeof params.text === "string" ? params.text : "";
      if (params.preview === true) {
        respond(true, { preview: true, ...(await m.ownerEditPreview(str(params.id), text)) });
        return;
      }
      respond(
        true,
        await m.ownerEditMemory(str(params.id), text, {
          planHash: str(params.planHash) || undefined,
        }),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Forget a memory with the cascade; `preview` and `planHash` as for memory.edit. */
  "memory.forget": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      if (params.preview === true) {
        respond(true, { preview: true, ...(await m.ownerForgetPreview(str(params.id))) });
        return;
      }
      const result = await m.ownerForgetMemory(str(params.id), {
        planHash: str(params.planHash) || undefined,
      });
      respond(true, { ok: true, ...result });
    } catch (err) {
      fail(respond, err);
    }
  },

  /**
   * PLAN-55 Phase 3: what a forget (or, with `text`, an edit) of this
   * memory would also change: facts retired or kept, graph links closed,
   * insights flagged, and the `planHash` to confirm with. Read-only.
   */
  "memory.forgetPreview": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const id = str(params.id);
      respond(
        true,
        typeof params.text === "string"
          ? await m.ownerEditPreview(id, params.text)
          : await m.ownerForgetPreview(id),
      );
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
          // PLAN-55 Phase 1: where the fact applies and where it came from.
          scope: f.scope,
          evidenceRef: f.evidenceRef,
        })),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  /**
   * Pin a fact as the owner (PLAN-55 Phase 0): the `owner` tier's writer.
   * Supersedes any agent or background belief for the key and brings back a
   * fact the owner had retired. Phase 1: `scope` (`global` | `project:<name>`
   * | `person:<name>`) and `evidence` (a line ref or short quote) are stored
   * on the fact.
   */
  "memory.pinFact": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const result = await m.ownerPinFact({
        key: str(params.key),
        value: str(params.value),
        category: str(params.category) || undefined,
        statement: str(params.statement) || undefined,
        scope: str(params.scope) || undefined,
        evidenceRef: str(params.evidence) || undefined,
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

  /**
   * PLAN-55 Phase 3: a one-time link (`GET <path>`, five minutes) that
   * streams the export (version 2) to the client, plus the path of the raw
   * SQLite database for an owner who wants the file itself.
   */
  "memory.exportDownload": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      const agentId = str(params.agentId) || resolveDefaultAgentId(loadConfig());
      const link = mintMemoryExportToken(agentId);
      // Under the Control UI's base path when one is configured (the gateway
      // serves the download at both).
      const basePath = normalizeControlUiBasePath(loadConfig().gateway?.controlUi?.basePath);
      respond(true, {
        url: `${basePath}${link.path}`,
        expiresAt: link.expiresAt,
        sqlitePath: m.ownerDatabasePath(),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  /**
   * PLAN-55 Phase 3: restore an export (version 1 or 2) as the owner.
   * `data` is the export (an object, or its JSON text); `dryRun: true`
   * returns the counts without writing. Suppressions win, duplicates are
   * skipped, and imported facts never outrank what is already there
   * (memory-import.ts). Facts that were owner-tier in the export import
   * below it (listed as `ownerFactsUnconfirmed`) unless `keepOwnerTier:
   * true` comes with `confirmOwnerTierGrantsHash` equal to the dry run's
   * `ownerTierGrantsHash` (a hash over the exact grants; the dry run also
   * reports their count and `replacesOwnerValues` for display).
   */
  "memory.import": async ({ params, respond }) => {
    try {
      const m = await memoryManager(str(params.agentId));
      if (params.data === undefined || params.data === null) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "data is required"));
        return;
      }
      respond(
        true,
        await m.ownerImportMemories(parseMemoryExport(params.data), {
          dryRun: params.dryRun === true,
          actor: "owner",
          // Rule C: owner-tier facts import below the owner tier unless the
          // owner opts in and confirms the dry run's grants by their hash.
          keepOwnerTier: params.keepOwnerTier === true,
          confirmOwnerTierGrantsHash:
            typeof params.confirmOwnerTierGrantsHash === "string"
              ? params.confirmOwnerTierGrantsHash
              : undefined,
        }),
      );
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
