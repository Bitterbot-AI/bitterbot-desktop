/**
 * Graceful-degradation tests for the embedding path.
 *
 * Previously a single embedding-batch timeout threw straight out of the sync,
 * which (a) aborted the whole sync before the pending-embedding backfill drainer
 * could run and (b) left chunks persisted with silent blank embeddings. The
 * hardened path bisects a failing batch down to a floor and leaves still-failing
 * items explicitly pending instead of throwing — but a genuinely non-degradable
 * error (auth/4xx) is still rethrown so the provider-fallback path can activate.
 *
 * These exercise that behavior through `backfillPendingEmbeddings`, which routes
 * through the same `embedChunksInBatches` → `embedBatchResilient` path.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type DegradationManager = MemoryIndexManager & {
  ingestScratchNote: (text: string, importance: number) => void;
  backfillPendingEmbeddings: (opts?: {
    limit?: number;
  }) => Promise<{ embedded: number; remaining: number }>;
};

describe("embedding graceful degradation", () => {
  let fixtureRoot: string;
  let manager: DegradationManager;

  function createCfg(workspaceDir: string, indexPath: string) {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  beforeEach(async () => {
    embedBatch.mockReset();
    embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
    embedQuery.mockReset();
    embedQuery.mockImplementation(async () => [0.1, 0.2, 0.3]);
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-degrade-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    const result = await getMemorySearchManager({
      cfg: createCfg(workspaceDir, path.join(fixtureRoot, "index.sqlite")),
      agentId: "main",
    });
    expect(result.manager).not.toBeNull();
    manager = result.manager as unknown as DegradationManager;
  });

  afterEach(async () => {
    await manager?.close();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("bisects an oversized failing batch and still embeds every chunk", async () => {
    // Provider fails for large batches (simulated timeout) but succeeds once the
    // batch is bisected to <= 20 items.
    embedBatch.mockImplementation(async (texts: string[]) => {
      if (texts.length > 20) {
        throw new Error("simulated request timed out");
      }
      return texts.map(() => [0.1, 0.2, 0.3]);
    });

    for (let i = 0; i < 40; i += 1) {
      manager.ingestScratchNote(`degrade-bisect marker crystal number ${i}`, 0.5);
    }

    // Drains the whole backlog across passes without throwing.
    let embedded = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      const pass = await manager.backfillPendingEmbeddings();
      embedded += pass.embedded;
      if (pass.embedded === 0) {
        break;
      }
    }
    expect(embedded).toBe(40);

    // A large batch was attempted (and failed) at least once, proving bisection.
    expect(embedBatch.mock.calls.some((c) => c[0].length > 20)).toBe(true);
  });

  it("leaves chunks pending instead of throwing when embeddings keep failing", async () => {
    embedBatch.mockImplementation(async () => {
      throw new Error("simulated request timed out");
    });

    for (let i = 0; i < 5; i += 1) {
      manager.ingestScratchNote(`degrade-pending marker crystal ${i}`, 0.5);
    }

    // Must resolve (not reject): a transient failure is degraded, not fatal.
    const pass = await manager.backfillPendingEmbeddings();
    expect(pass.embedded).toBe(0);
    expect(pass.remaining).toBeGreaterThanOrEqual(5);
    expect(embedBatch).toHaveBeenCalled();
  });

  it("rethrows a non-degradable (auth) error so provider fallback can trigger", async () => {
    embedBatch.mockImplementation(async () => {
      throw new Error("401 Unauthorized: invalid_api_key");
    });

    manager.ingestScratchNote("degrade-auth marker crystal", 0.5);

    await expect(manager.backfillPendingEmbeddings()).rejects.toThrow(
      /unauthorized|invalid_api_key/i,
    );
  });
});
