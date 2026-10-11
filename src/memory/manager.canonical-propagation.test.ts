/**
 * PLAN-55 Phase 2: the memory manager wires the ledger's canonical:changed
 * event onto its event bus and into the propagation consumers, on by
 * default, and memory search tags what the correction superseded.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: async () => [0, 0, 0],
      embedBatch: async () => [],
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

describe("manager canonical:changed wiring", () => {
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-canon-prop-"));
    await fs.mkdir(path.join(workspaceDir, "memory"));
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("forwards the event, marks the stale chunk and tags it in search", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: path.join(workspaceDir, "index.sqlite") },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    const db = (manager as unknown as { db: DatabaseSync }).db;
    const insertChunk = (id: string, text: string, line: number) => {
      db.prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, 'memory/notes.md', 'memory', ?, ?, ?, 'text-embedding-3-small', ?, '[]', 1)`,
      ).run(id, line, line, `h-${id}`, text);
      try {
        db.prepare(
          `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
           VALUES (?, ?, 'memory/notes.md', 'memory', 'text-embedding-3-small', ?, ?)`,
        ).run(text, id, line, line);
      } catch {
        // FTS unavailable on this build: the scan path still marks.
      }
    };
    insertChunk("stale", "The deploy endpoint is api.acme.com", 1);
    insertChunk("fresh", "Deploy notes: the endpoint moved to api2.acme.com", 2);

    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    manager.setEventEmitter((event, data) => events.push({ event, data }));
    const store = manager.canonicalFacts();
    expect(store).not.toBeNull();
    store!.pin({ key: "infra.deploy_endpoint", value: "api.acme.com", source: "extraction" });
    store!.pin({ key: "infra.deploy_endpoint", value: "api2.acme.com", source: "owner" });
    expect(events.map((e) => e.event)).toEqual(["canonical:changed", "canonical:changed"]);
    expect(events[1]!.data).toMatchObject({
      op: "supersede",
      oldValue: "api.acme.com",
      newValue: "api2.acme.com",
    });

    await manager.canonicalPropagationIdle();
    const marks = db.prepare(`SELECT chunk_id FROM chunk_supersessions`).all() as Array<{
      chunk_id: string;
    }>;
    expect(marks.map((m) => m.chunk_id)).toEqual(["stale"]);

    const hits = await manager.search("deploy endpoint");
    const stale = hits.find((h) => h.startLine === 1);
    // Ranked after the current result and tagged, never dropped.
    expect(stale).toBeDefined();
    expect(stale!.snippet.startsWith("[superseded]")).toBe(true);
    expect(stale!.superseded).toEqual([
      { key: "infra.deploy_endpoint", currentValue: "api2.acme.com" },
    ]);
    expect(hits.indexOf(stale!)).toBe(hits.length - 1);
  });
});
