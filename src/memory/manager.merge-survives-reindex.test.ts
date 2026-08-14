import type { DatabaseSync } from "node:sqlite";
/**
 * PLAN-40 Lane 2, P1-F1 regression (phase adversarial pass, 2026-08-12).
 *
 * Demotion state must survive re-indexing. Re-indexing deleted every chunk row
 * for a file and re-inserted it as a fresh `generated` chunk with parent_id
 * NULL, hygiene_done 0 and brand-new FTS/vec rows — silently erasing
 * demotions. In the live DB 8 of 14 merge summaries had lost every member this
 * way, and one demoted chunk was back in full retrieval 14 hours after being
 * merged away.
 *
 * Chunk ids are content-derived, so an unchanged chunk comes back with the same
 * id: the demotion must be carried across the delete/re-insert. A chunk whose
 * text genuinely changed gets a new id and must be indexed fresh.
 *
 * The merge itself was deleted 2026-08-14 (failed its D2 gate), but its ~19
 * summaries and their demoted members are live data, and OTHER writers still
 * produce `consolidated` chunks (compression). The fixture below writes the
 * exact rows the merge used to write.
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
  db: DatabaseSync;
};

/**
 * Reproduce the rows the (now deleted) hygiene merge wrote: a summary chunk
 * (hygiene_done=1, indexed) and its members demoted out of the search surface
 * (lifecycle='consolidated', parent_id=summary, hygiene_done=1, FTS rows
 * removed). This is exactly the on-disk shape the ~19 live summaries have.
 */
function applyMergeFixture(db: DatabaseSync, summaryText: string, memberIds: string[]): string {
  const id = `hygiene_merge_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       importance_score, lifecycle, semantic_type, hygiene_done, access_count, created_at, updated_at)
     VALUES (?, ?, 'memory', 0, 0, ?, ?, 'test-model', '[]', 0.6, 'activated', 'fact', 1, 0, ?, ?)`,
  ).run(id, `hygiene/merge/${id}`, summaryText, `h-${id}`, now, now);
  db.prepare(
    `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
     VALUES (?, ?, ?, 'memory', 'test-model', 0, 0)`,
  ).run(summaryText, id, `hygiene/merge/${id}`);
  const demote = db.prepare(
    `UPDATE chunks SET lifecycle = 'consolidated', parent_id = ?, hygiene_done = 1, updated_at = ?
      WHERE id = ?`,
  );
  for (const memberId of memberIds) {
    demote.run(id, now, memberId);
    db.prepare(`DELETE FROM chunks_fts WHERE id = ?`).run(memberId);
  }
  db.exec("COMMIT");
  return id;
}

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

    const summaryId = applyMergeFixture(mgr.db, "Victor lives in Miami, Florida.", memberIds);

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
    const summaryId = applyMergeFixture(
      mgr.db,
      "Merged.",
      before.map((r) => r.id),
    );
    void summaryId;

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
