/**
 * Regression: a transient embedding failure during sync must leave the file's
 * chunks pending for the backfill drainer, not abort the sync. The graceful
 * degradation path returned `[]` for the failed items, but serializing an empty
 * Float32Array through `Buffer.from(...buffer)` bound as NULL in node:sqlite
 * and tripped `chunks.embedding NOT NULL`, so the whole file was lost (seen on
 * the LongMemEval baseline, 2026-10-27).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));
vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));
vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: { id: "openai", model: "text-embedding-3-small", embedQuery, embedBatch },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

type Manager = MemoryIndexManager & {
  sync: (opts?: { reason?: string }) => Promise<void>;
  backfillPendingEmbeddings: (opts?: {
    limit?: number;
  }) => Promise<{ embedded: number; remaining: number }>;
};

describe("sync when an embedding batch fails", () => {
  let root: string;
  let indexPath: string;
  let manager: Manager | null = null;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-embedfail-"));
    const workspaceDir = path.join(root, "workspace");
    indexPath = path.join(root, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "notes.md"),
      "# Notes\n\nThe zephyr lighthouse keeper repainted the lantern room in cobalt.\n",
    );
    const result = await getMemorySearchManager({
      cfg: {
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              provider: "openai",
              model: "text-embedding-3-small",
              store: { path: indexPath, vector: { enabled: false } },
              sync: { watch: false, onSessionStart: false, onSearch: false, onStartup: false },
              query: { minScore: 0, hybrid: { enabled: false } },
              cache: { enabled: false },
            },
          },
          list: [{ id: "main", default: true }],
        },
      },
      agentId: "main",
    });
    expect(result.manager).not.toBeNull();
    manager = result.manager as unknown as Manager;
  });

  afterAll(async () => {
    await manager?.close();
    manager = null;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves the chunks pending instead of failing the NOT NULL constraint, and the backfill reclaims them", async () => {
    const mgr = manager!;
    // Every attempt fails with the transport error the live run produced.
    embedBatch.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(mgr.sync({ reason: "test-embed-failure" })).resolves.not.toThrow();

    const db = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT model, typeof(embedding) AS kind, length(embedding) AS len FROM chunks WHERE path LIKE '%notes.md'`,
        )
        .all() as Array<{ model: string; kind: string; len: number }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.model).toBe("pending");
        expect(row.kind).not.toBe("null");
        expect(row.len).toBe(0);
      }
    } finally {
      db.close();
    }

    // The provider recovers: the drainer embeds the pending rows.
    embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
    const drained = await mgr.backfillPendingEmbeddings({ limit: 50 });
    expect(drained.embedded).toBeGreaterThan(0);
    const db2 = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const pending = db2
        .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE model = 'pending'`)
        .get() as {
        n: number;
      };
      expect(pending.n).toBe(0);
    } finally {
      db2.close();
    }
  });
});
