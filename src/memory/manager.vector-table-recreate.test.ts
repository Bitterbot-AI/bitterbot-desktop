/**
 * Regression: a PERSISTED vectorDims that outlives its table.
 *
 * `memory_index_meta_v1` remembers `vectorDims`, so a manager can boot with
 * `vector.dims` already set while `chunks_vec` is absent from THIS database
 * (a restore, a fresh-start copy, or any past session where sqlite-vec failed
 * to load and the table was never created). `ensureVectorTable` used to early-
 * return on the remembered dimension alone, so `ensureVectorReady()` reported
 * READY against a missing table and every downstream `chunks_vec` prepare
 * threw "no such table: chunks_vec".
 *
 * Live impact when this fired (2026-08-11): the embedding backfill threw on
 * its FIRST statement every single run — which is why the never-embedded
 * crystal backlog never drained (3,003 rows) — and vector search was dead
 * (every recall trace showed vector_hits=0). Both were invisible because the
 * callers log at debug level.
 *
 * Uses the REAL sqlite-vec extension (no mock) so the vec0 table is genuine.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery,
      embedBatch,
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

type BackfillManager = MemoryIndexManager & {
  ingestScratchNote: (text: string, importance: number) => void;
  backfillPendingEmbeddings: (opts?: {
    limit?: number;
  }) => Promise<{ embedded: number; remaining: number }>;
};

function createCfg(workspaceDir: string, indexPath: string) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          // Vectors ENABLED: this regression only exists on the vector path.
          store: { path: indexPath, vector: { enabled: true } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

let fixtureRoot: string | null = null;

afterEach(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

describe("vector table recreation when persisted dims outlive the table", () => {
  it("re-creates chunks_vec instead of throwing 'no such table'", async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-vec-recreate-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const indexPath = path.join(fixtureRoot, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

    // Pass 1: normal operation creates chunks_vec and persists vectorDims.
    const first = await getMemorySearchManager({
      cfg: createCfg(workspaceDir, indexPath),
      agentId: "main",
    });
    const mgr1 = first.manager as unknown as BackfillManager;
    expect(mgr1).not.toBeNull();
    mgr1.ingestScratchNote("vector recreate marker alpha", 0.9);
    const pass1 = await mgr1.backfillPendingEmbeddings();
    expect(pass1.embedded).toBeGreaterThanOrEqual(1);
    await mgr1.close();

    // Reproduce the live node's exact shape: meta REMEMBERS vectorDims (it is
    // written on sync, which this fixture doesn't run) while the table is
    // gone. Seeding the row directly is faithful — the live DB carries
    // precisely this value.
    const probe = new DatabaseSync(indexPath, { allowExtension: true });
    // vec0 is an extension module: a bare connection cannot even DROP the
    // virtual table without loading it first.
    const probeLoad = await loadSqliteVecExtension({ db: probe });
    expect(probeLoad.ok).toBe(true);
    expect(
      probe.prepare(`SELECT name FROM sqlite_master WHERE name = 'chunks_vec'`).get(),
    ).toBeTruthy();
    probe
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(
        "memory_index_meta_v1",
        JSON.stringify({
          model: "text-embedding-3-small",
          provider: "openai",
          chunkTokens: 400,
          chunkOverlap: 80,
          vectorDims: 3,
        }),
      );

    // Simulate the live failure: the table is gone, the remembered dims stay.
    probe.exec(`DROP TABLE chunks_vec`);
    expect(
      probe.prepare(`SELECT name FROM sqlite_master WHERE name = 'chunks_vec'`).get(),
    ).toBeUndefined();
    probe.close();

    // Pass 2: a fresh manager boots with dims from meta and a missing table.
    const second = await getMemorySearchManager({
      cfg: createCfg(workspaceDir, indexPath),
      agentId: "main",
    });
    const mgr2 = second.manager as unknown as BackfillManager;
    expect(mgr2).not.toBeNull();
    mgr2.ingestScratchNote("vector recreate marker beta", 0.9);

    // Before the fix this rejected with "no such table: chunks_vec".
    const pass2 = await mgr2.backfillPendingEmbeddings();
    expect(pass2.embedded).toBeGreaterThanOrEqual(1);
    await mgr2.close();

    // The table is back, so vector search has a surface again.
    const verify = new DatabaseSync(indexPath, { allowExtension: true });
    expect(
      verify.prepare(`SELECT name FROM sqlite_master WHERE name = 'chunks_vec'`).get(),
    ).toBeTruthy();
    verify.close();
  });
});
