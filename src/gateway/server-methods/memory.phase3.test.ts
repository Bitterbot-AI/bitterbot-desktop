/**
 * PLAN-55 Phase 3 handlers: memory.forgetPreview, memory.forget / memory.edit
 * with preview and planHash, memory.exportDownload, memory.import, and the
 * scope gate for each (closes G10 for these methods). The manager is mocked
 * with the real owner-controls functions over an in-memory database.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalFactsStore } from "../../memory/canonical-facts.js";
import { ensureDreamSchema } from "../../memory/dream-schema.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { writeMemoryExport } from "../../memory/memory-export.js";
import { importMemories } from "../../memory/memory-import.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import {
  editMemory,
  forgetMemory,
  previewEdit,
  previewForget,
} from "../../memory/owner-controls.js";
import { UserModelManager } from "../../memory/user-model.js";
import { consumeMemoryExportToken, resetMemoryExportTokensForTest } from "../memory-export-http.js";
import { ErrorCodes } from "../protocol/index.js";
import { memoryHandlers } from "./memory.js";

vi.mock("../../memory/index.js", () => ({ getMemorySearchManager: vi.fn() }));
vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../../agents/agent-scope.js", () => ({ resolveDefaultAgentId: () => "main" }));

type Call = { ok: boolean; payload?: unknown; error?: { code?: string; message?: string } };
type Handler = (typeof memoryHandlers)[string];

async function call(method: string, params: Record<string, unknown>): Promise<Call> {
  const calls: Call[] = [];
  const handler = memoryHandlers[method] as Handler;
  await handler({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) =>
      calls.push({ ok, payload, error: error as Call["error"] }),
  } as unknown as Parameters<Handler>[0]);
  return calls[0]!;
}

const TABLES = { ftsTable: null, vectorTable: null };
let db: DatabaseSync;
let store: CanonicalFactsStore;

function insertChunk(id: string, text: string, extra: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    path: `memory/${id}`,
    source: "memory",
    start_line: 0,
    end_line: 0,
    hash: id,
    model: "m",
    text,
    embedding: "[]",
    updated_at: 1,
    lifecycle: "generated",
    created_at: 1,
    ...extra,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO chunks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...(Object.values(row) as Array<string | number>));
}

beforeEach(() => {
  resetMemoryExportTokensForTest();
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "e",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureDreamSchema(db);
  new UserModelManager(db);
  store = new CanonicalFactsStore(db);
  insertChunk("fact_a", "The deploy endpoint is api.acme.com.");
  store.pin({
    key: "infra.deploy_endpoint",
    value: "api.acme.com",
    source: "extraction",
    evidenceChunkIds: ["fact_a"],
  });
  const manager = {
    ownerForgetPreview: (id: string) => previewForget(db, id),
    ownerEditPreview: (id: string, text: string) => previewEdit(db, id, text),
    ownerForgetMemory: (id: string, opts?: { planHash?: string }) =>
      forgetMemory(db, id, TABLES, { store, ...opts }),
    ownerEditMemory: (id: string, text: string, opts?: { planHash?: string }) =>
      editMemory(db, id, text, TABLES, { store, ...opts }),
    ownerDatabasePath: () => "/home/u/.bitterbot/memory/main.sqlite",
    ownerImportMemories: (input: unknown, opts: { dryRun?: boolean; actor?: "owner" }) =>
      importMemories(db, input, {
        actor: opts.actor ?? "owner",
        dryRun: opts.dryRun,
        store,
        tables: TABLES,
      }),
    ownerExportTo: (sink: (p: string) => void) => writeMemoryExport(db, sink, { agentId: "main" }),
  };
  vi.mocked(getMemorySearchManager).mockResolvedValue({ manager, error: null } as never);
});

describe("memory.forgetPreview / memory.forget / memory.edit (PLAN-55 Phase 3)", () => {
  it("previews the cascade without changing anything", async () => {
    const res = await call("memory.forgetPreview", { id: "fact_a" });
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({
      mode: "forget",
      factsRetired: [{ key: "infra.deploy_endpoint", value: "api.acme.com" }],
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(store.get("infra.deploy_endpoint")?.status).toBe("active");
    const viaForget = await call("memory.forget", { id: "fact_a", preview: true });
    expect(viaForget.payload).toMatchObject({
      preview: true,
      planHash: (res.payload as { planHash: string }).planHash,
    });
  });

  it("forgets with the previewed plan and refuses a stale one", async () => {
    const stale = await call("memory.forget", { id: "fact_a", planHash: "0".repeat(64) });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(stale.error?.message).toMatch(/Preview again/);

    const { planHash } = (await call("memory.forgetPreview", { id: "fact_a" })).payload as {
      planHash: string;
    };
    const res = await call("memory.forget", { id: "fact_a", planHash });
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({
      ok: true,
      retiredFacts: [{ key: "infra.deploy_endpoint", value: "api.acme.com" }],
    });
    expect(store.get("infra.deploy_endpoint")?.status).toBe("retired");
  });

  it("edits: preview with text, then the new memory replaces the old one", async () => {
    const preview = await call("memory.forgetPreview", {
      id: "fact_a",
      text: "The deploy endpoint is api.acme.com behind the VPN.",
    });
    expect(preview.payload).toMatchObject({
      mode: "edit",
      factsRelinked: [{ key: "infra.deploy_endpoint" }],
      newId: expect.stringMatching(/^fact_/),
    });
    const res = await call("memory.edit", {
      id: "fact_a",
      text: "The deploy endpoint is api.acme.com behind the VPN.",
      planHash: (preview.payload as { planHash: string }).planHash,
    });
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({
      previousId: "fact_a",
      id: (preview.payload as { newId: string }).newId,
    });
    expect(store.get("infra.deploy_endpoint")?.status).toBe("active");
  });

  it("refuses a file memory with INVALID_REQUEST", async () => {
    insertChunk("filechunk", "line", { path: "MEMORY.md" });
    const res = await call("memory.forget", { id: "filechunk" });
    expect(res.error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(res.error?.message).toMatch(/change the file instead/);
  });
});

describe("memory.exportDownload / memory.import", () => {
  it("mints a one-time download link and returns the database path", async () => {
    const res = await call("memory.exportDownload", {});
    expect(res.ok).toBe(true);
    const payload = res.payload as { url: string; sqlitePath: string; expiresAt: number };
    expect(payload.url).toMatch(/^\/api\/memory\/export\/[A-Za-z0-9_-]{40,}$/);
    expect(payload.sqlitePath).toBe("/home/u/.bitterbot/memory/main.sqlite");
    const token = payload.url.split("/").pop()!;
    expect(consumeMemoryExportToken(token)).toMatchObject({ agentId: "main" });
    expect(consumeMemoryExportToken(token)).toBeNull();
  });

  it("imports an export (dry run first), and refuses bad input", async () => {
    const doc = {
      version: 2,
      memories: [{ id: "note_new", text: "Imported note about Lisbon." }],
      facts: [{ key: "project.repo", value: "bitterbot-desktop", source: "extraction" }],
      preferences: [],
    };
    const dry = await call("memory.import", { data: JSON.stringify(doc), dryRun: true });
    expect(dry.payload).toMatchObject({ dryRun: true, memories: { imported: 1 } });
    expect(db.prepare(`SELECT 1 FROM chunks WHERE id = 'note_new'`).get()).toBeUndefined();

    const res = await call("memory.import", { data: doc });
    expect(res.payload).toMatchObject({
      dryRun: false,
      memories: { imported: 1 },
      facts: { imported: 1 },
    });
    expect(store.get("project.repo")?.source).toBe("import");

    expect((await call("memory.import", {})).error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect((await call("memory.import", { data: "{nope" })).error?.code).toBe(
      ErrorCodes.INVALID_REQUEST,
    );
    expect((await call("memory.import", { data: { hello: 1 } })).error?.code).toBe(
      ErrorCodes.INVALID_REQUEST,
    );
  });
});
