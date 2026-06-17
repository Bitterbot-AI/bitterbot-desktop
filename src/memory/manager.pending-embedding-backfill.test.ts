/**
 * Regression test for backfillPendingEmbeddings().
 *
 * Crystals inserted directly (extracted facts, scratch notes, handover briefs)
 * land with model='pending' and embedding='[]', and historically nothing ever
 * embedded them — leaving them invisible to both vector and FTS search. This
 * verifies the backfill pass embeds them, indexes them into FTS so they become
 * searchable, and is idempotent once the backlog is clear.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("backfillPendingEmbeddings", () => {
  let fixtureRoot: string;
  let manager: BackfillManager | null = null;

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

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-backfill-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const indexPath = path.join(fixtureRoot, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    const result = await getMemorySearchManager({
      cfg: createCfg(workspaceDir, indexPath),
      agentId: "main",
    });
    expect(result.manager).not.toBeNull();
    manager = result.manager as unknown as BackfillManager;
  });

  afterAll(async () => {
    await manager?.close();
    manager = null;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    embedBatch.mockClear();
    embedQuery.mockClear();
  });

  it("embeds a placeholder crystal and makes it searchable, then no-ops", async () => {
    const mgr = manager!;
    const needle = "quetzalcoatl orbital mechanics backfill marker";

    // A scratch note is inserted with model='pending' + embedding='[]'.
    mgr.ingestScratchNote(needle, 0.9);

    // Before backfill it is in neither FTS nor vector -> not searchable.
    const before = await mgr.search(needle, { maxResults: 5 });
    expect(before.some((r) => r.snippet.includes(needle))).toBe(false);

    // Backfill embeds it and indexes it into FTS.
    const first = await mgr.backfillPendingEmbeddings();
    expect(first.embedded).toBeGreaterThanOrEqual(1);
    expect(embedBatch).toHaveBeenCalled();

    // Now it is searchable.
    const after = await mgr.search(needle, { maxResults: 5 });
    expect(after.some((r) => r.snippet.includes(needle))).toBe(true);

    // Second pass is a no-op: nothing pending remains.
    embedBatch.mockClear();
    const second = await mgr.backfillPendingEmbeddings();
    expect(second.embedded).toBe(0);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it("respects the per-pass limit", async () => {
    const mgr = manager!;
    for (let i = 0; i < 3; i += 1) {
      mgr.ingestScratchNote(`limit-marker crystal number ${i} unique-${Math.floor(i)}`, 0.5);
    }
    const pass = await mgr.backfillPendingEmbeddings({ limit: 2 });
    expect(pass.embedded).toBeLessThanOrEqual(2);
    expect(pass.remaining).toBeGreaterThanOrEqual(1);

    // Drain the rest so later runs of the suite start clean.
    let guard = 0;
    for (;;) {
      const r = await mgr.backfillPendingEmbeddings();
      if (r.embedded === 0 || guard > 10) {
        break;
      }
      guard += 1;
    }
  });
});
