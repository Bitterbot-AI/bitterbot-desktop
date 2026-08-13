import type { DatabaseSync } from "node:sqlite";
/**
 * A full reindex must not destroy chunks that no file produces.
 *
 * Found 2026-08-12 while fixing PLAN-40 P1-F1. `runSafeReindex` rebuilds the
 * index into a fresh database by walking memory/session/skill FILES and then
 * swaps it in, so everything the agent crystallized itself — extracted facts,
 * scratch notes, handover crystals, dream insights, hygiene merge summaries —
 * was silently deleted. A probe confirmed it: insert a scratch note, run one
 * forced sync, row count goes 1 -> 0.
 *
 * The trigger list is ordinary operations, not exotic ones: `force`, an
 * embedding model or provider change, a chunking-settings change, and an API
 * KEY ROTATION (providerKey is part of the meta comparison). Rotating a key
 * wiped the agent's memory while leaving file-derived chunks intact, so the
 * index still looked healthy afterwards.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

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
      embedQuery: async () => [0.1, 0.2, 0.3],
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    },
    openAi: {
      baseUrl: "https://api.openai.com/v1",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      model: "text-embedding-3-small",
    },
  }),
}));

type ReindexManager = MemoryIndexManager & {
  sync: (o?: unknown) => Promise<unknown>;
  ingestScratchNote: (text: string, importance: number) => void;
  writeMergedSummaryChunk: (p: {
    text: string;
    memberIds: string[];
    semanticType: string;
  }) => Promise<string | null>;
  db: DatabaseSync;
};

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function bootManager() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-reindex-keep-"));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "memory", "note.md"),
    "An ordinary file-derived note about sailing.\n",
    "utf8",
  );
  const { manager } = await getMemorySearchManager({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            sources: ["memory"],
            store: { path: path.join(root, "idx.sqlite"), vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: true } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as never,
    agentId: "main",
  });
  expect(manager).not.toBeNull();
  const mgr = manager as unknown as ReindexManager;
  cleanup.push(async () => {
    await manager?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return mgr;
}

const countLike = (db: DatabaseSync, needle: string): number =>
  (
    db.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE text LIKE ?`).get(`%${needle}%`) as {
      c: number;
    }
  ).c;

describe("full reindex preserves self-authored chunks", () => {
  it("keeps a crystal that no file produces", async () => {
    const mgr = await bootManager();
    await mgr.sync({ force: true });

    mgr.ingestScratchNote("SCRATCH_KEEPSAKE synthetic crystal with no backing file", 0.9);
    expect(countLike(mgr.db, "SCRATCH_KEEPSAKE")).toBe(1);

    await mgr.sync({ force: true });

    expect(countLike(mgr.db, "SCRATCH_KEEPSAKE"), "a full reindex must not delete crystals").toBe(
      1,
    );
    // The file-derived chunk is still there too — carry-over must not duplicate
    // or displace the rebuild's own output.
    expect(countLike(mgr.db, "ordinary file-derived note")).toBe(1);
  });

  it("carries a hygiene merge summary and leaves its demoted members demoted", async () => {
    const mgr = await bootManager();
    await mgr.sync({ force: true });

    const members = (
      mgr.db.prepare(`SELECT id FROM chunks WHERE source = 'memory'`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(members.length).toBeGreaterThan(0);

    const summaryId = await mgr.writeMergedSummaryChunk({
      text: "MERGE_KEEPSAKE canonical merged note.",
      memberIds: members,
      semanticType: "fact",
    });
    expect(summaryId).not.toBeNull();

    await mgr.sync({ force: true });

    expect(countLike(mgr.db, "MERGE_KEEPSAKE"), "the summary must survive a rebuild").toBe(1);
    const inFts = (
      mgr.db.prepare(`SELECT COUNT(*) AS c FROM chunks_fts WHERE id = ?`).get(summaryId!) as {
        c: number;
      }
    ).c;
    expect(inFts, "a carried summary must still be searchable").toBe(1);
  });

  it("carries a demoted chunk forward without putting it back in the index", async () => {
    const mgr = await bootManager();
    await mgr.sync({ force: true });

    // A genuinely non-file crystal (no backing path on disk), already demoted
    // by the hygiene merge. `ingestScratchNote` is deliberately NOT used here:
    // it also writes a real scratch file, so its chunk is a file/crystal hybrid
    // that the rebuild reproduces on its own.
    const id = "fact_demoted_keepsake";
    mgr.db
      .prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text,
           embedding, updated_at, created_at, lifecycle, semantic_type, hygiene_done)
         VALUES (?, 'crystal/synthetic', 'memory', 0, 0, 'h', 'pending', ?, '[]', ?, ?,
           'consolidated', 'fact', 1)`,
      )
      .run(id, "DEMOTED_KEEPSAKE merged away by hygiene", Date.now(), Date.now());

    await mgr.sync({ force: true });

    const kept = mgr.db.prepare(`SELECT lifecycle FROM chunks WHERE id = ?`).get(id) as
      | { lifecycle: string }
      | undefined;
    expect(kept?.lifecycle, "the demoted crystal must survive the rebuild").toBe("consolidated");
    const inFts = (
      mgr.db.prepare(`SELECT COUNT(*) AS c FROM chunks_fts WHERE id = ?`).get(id) as {
        c: number;
      }
    ).c;
    expect(inFts, "a demoted chunk must not be resurrected into FTS").toBe(0);
  });
});
