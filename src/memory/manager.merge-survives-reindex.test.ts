import type { DatabaseSync } from "node:sqlite";
/**
 * PLAN-40 Lane 2, P1-F1 regression (phase adversarial pass, 2026-08-12).
 *
 * The hygiene merge's whole value is that it REMOVES the near-duplicates it
 * replaces from the retrieval surface. Re-indexing deleted every chunk row for
 * a file and re-inserted it as a fresh `generated` chunk with parent_id NULL,
 * hygiene_done 0 and brand-new FTS/vec rows — silently undoing the merge. In
 * the live DB 8 of 14 merge summaries had lost every member this way, and one
 * demoted chunk was back in full retrieval 14 hours after being merged away.
 *
 * Chunk ids are content-derived, so an unchanged chunk comes back with the same
 * id: the demotion must be carried across the delete/re-insert. A chunk whose
 * text genuinely changed gets a new id and must be indexed fresh.
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

type MergeManager = MemoryIndexManager & {
  sync: (o?: unknown) => Promise<unknown>;
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

async function bootManager(memoryFiles: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-merge-reindex-"));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  for (const [name, body] of Object.entries(memoryFiles)) {
    await fs.writeFile(path.join(workspaceDir, "memory", name), body, "utf8");
  }
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
  const mgr = manager as unknown as MergeManager;
  cleanup.push(async () => {
    await manager?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { mgr, workspaceDir };
}

const inFts = (db: DatabaseSync, id: string): boolean =>
  ((db.prepare(`SELECT COUNT(*) AS c FROM chunks_fts WHERE id = ?`).get(id) as { c: number }).c ??
    0) > 0;

describe("hygiene merge survives re-indexing", () => {
  it("keeps members demoted and out of FTS when the file is re-indexed unchanged", async () => {
    const body = "Victor lives in Miami, Florida and has done so for years.\n";
    const { mgr } = await bootManager({ "note.md": body });
    await mgr.sync({ force: true });

    const members = mgr.db.prepare(`SELECT id FROM chunks WHERE source = 'memory'`).all() as Array<{
      id: string;
    }>;
    expect(members.length).toBeGreaterThan(0);
    const memberIds = members.map((m) => m.id);

    const summaryId = await mgr.writeMergedSummaryChunk({
      text: "Victor lives in Miami, Florida.",
      memberIds,
      semanticType: "fact",
    });
    expect(summaryId).not.toBeNull();

    // Demoted: consolidated, parented to the summary, and out of the index.
    for (const id of memberIds) {
      const row = mgr.db
        .prepare(`SELECT lifecycle, parent_id, hygiene_done FROM chunks WHERE id = ?`)
        .get(id) as { lifecycle: string; parent_id: string; hygiene_done: number };
      expect(row.lifecycle).toBe("consolidated");
      expect(row.parent_id).toBe(summaryId);
      expect(inFts(mgr.db, id)).toBe(false);
    }

    // The event that used to undo all of it.
    await mgr.sync({ force: true });

    for (const id of memberIds) {
      const row = mgr.db
        .prepare(`SELECT lifecycle, parent_id, hygiene_done FROM chunks WHERE id = ?`)
        .get(id) as
        | { lifecycle: string; parent_id: string | null; hygiene_done: number }
        | undefined;
      expect(row, "member row must survive the re-index").toBeDefined();
      expect(row!.lifecycle).toBe("consolidated");
      expect(row!.parent_id).toBe(summaryId);
      expect(row!.hygiene_done).toBe(1);
      expect(inFts(mgr.db, id), "a merged-away member must not return to FTS").toBe(false);
    }
  });

  it("indexes genuinely changed content fresh instead of preserving a stale demotion", async () => {
    const { mgr, workspaceDir } = await bootManager({
      "note.md": "The original sentence about Miami.\n",
    });
    await mgr.sync({ force: true });
    const before = mgr.db.prepare(`SELECT id FROM chunks WHERE source = 'memory'`).all() as Array<{
      id: string;
    }>;
    const summaryId = await mgr.writeMergedSummaryChunk({
      text: "Merged.",
      memberIds: before.map((r) => r.id),
      semanticType: "fact",
    });
    expect(summaryId).not.toBeNull();

    // Rewrite the file with different text: new content, new id, new chunk.
    await fs.writeFile(
      path.join(workspaceDir, "memory", "note.md"),
      "A completely different sentence about Lisbon and sailing.\n",
      "utf8",
    );
    await mgr.sync({ force: true });

    const fresh = mgr.db
      .prepare(
        `SELECT id, lifecycle FROM chunks
          WHERE source = 'memory' AND COALESCE(hygiene_done, 0) = 0 AND text LIKE '%Lisbon%'`,
      )
      .all() as Array<{ id: string; lifecycle: string }>;
    expect(fresh.length).toBeGreaterThan(0);
    for (const row of fresh) {
      expect(row.lifecycle).toBe("generated");
      expect(inFts(mgr.db, row.id), "new content must be searchable").toBe(true);
    }
  });
});
