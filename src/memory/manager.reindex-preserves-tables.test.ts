/**
 * A full reindex must not empty the rest of the memory database.
 *
 * Found 2026-10-01 on a live node. An embedding-provider change triggered
 * `runSafeReindex`, which rebuilds the index in an EMPTY database and swaps it
 * in. The chunk carry-over (manager.reindex-preserves-crystals) saved the
 * crystals, but canonical facts, the knowledge graph, dream history, user
 * preferences and Circles keys live in the same file and were all dropped:
 * 113 tables before, 9 with any rows after, and nothing reported it.
 *
 * `reindex-carryover.aux-tables.test.ts` pins the copy. This file pins that a
 * real reindex runs it, and that a failed copy aborts the swap.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const carryOver = vi.hoisted(() => ({ fail: false }));
const guard = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../infra/test-state-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/test-state-guard.js")>();
  return {
    ...actual,
    assertNotRealStateUnderTest: (target: string) => {
      guard.paths.push(target);
      actual.assertNotRealStateUnderTest(target);
    },
  };
});

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

vi.mock("./reindex-carryover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reindex-carryover.js")>();
  return {
    ...actual,
    carryOverAuxiliaryTables: (params: Parameters<typeof actual.carryOverAuxiliaryTables>[0]) => {
      if (carryOver.fail) {
        throw new Error("simulated carry-over failure");
      }
      return actual.carryOverAuxiliaryTables(params);
    },
  };
});

type ReindexManager = MemoryIndexManager & {
  sync: (o?: unknown) => Promise<unknown>;
  db: DatabaseSync;
};

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  carryOver.fail = false;
  guard.paths = [];
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function bootManager() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-reindex-tables-"));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "memory", "note.md"),
    "An ordinary file-derived note about sailing.\n",
    "utf8",
  );
  const dbPath = path.join(root, "idx.sqlite");
  const { manager } = await getMemorySearchManager({
    cfg: {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            sources: ["memory"],
            store: { path: dbPath, vector: { enabled: false } },
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
  return { mgr, root, dbPath };
}

/** Tables the rebuild owns, plus search indexes and their shadow tables. */
const OWNED = new Set(["files", "chunks", "embedding_cache", "meta"]);

/** Row count of every table a reindex has no business touching. */
function auxiliaryCounts(db: DatabaseSync): Record<string, number> {
  const master = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string; sql: string | null }>;
  const virtual = master
    .filter((r) => /^\s*CREATE\s+VIRTUAL/i.test(r.sql ?? ""))
    .map((r) => r.name);
  const counts: Record<string, number> = {};
  for (const { name } of master) {
    if (OWNED.has(name) || name.startsWith("sqlite_")) continue;
    if (virtual.some((v) => name === v || name.startsWith(`${v}_`))) continue;
    counts[name] = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
  }
  return counts;
}

/** State no file can reproduce, in the shapes the live database holds it. */
function seedNonIndexState(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lazily_created_prefs (id TEXT PRIMARY KEY, kind TEXT, body TEXT);
    CREATE INDEX IF NOT EXISTS idx_lazily_created_prefs_kind ON lazily_created_prefs(kind);
    INSERT INTO lazily_created_prefs VALUES ('p1', 'directive', 'PREF_KEEPSAKE');
    INSERT INTO meta (key, value) VALUES ('test_subsystem_flag', 'KEEP');
  `);
}

describe("full reindex preserves the rest of the database", () => {
  it("keeps every non-index table across a forced reindex", async () => {
    const { mgr } = await bootManager();
    await mgr.sync({ force: true });
    seedNonIndexState(mgr.db);
    const before = auxiliaryCounts(mgr.db);
    expect(before.lazily_created_prefs).toBe(1);
    // The schema brings real auxiliary tables of its own; the invariant below
    // has to cover them, not just the one this test created.
    expect(Object.keys(before).length).toBeGreaterThan(1);

    await mgr.sync({ force: true });

    expect(auxiliaryCounts(mgr.db), "a reindex must not drop or empty any table").toEqual(before);
    expect(mgr.db.prepare(`SELECT body FROM lazily_created_prefs`).all()).toEqual([
      { body: "PREF_KEEPSAKE" },
    ]);
    expect(
      mgr.db
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_lazily_created_prefs_kind'`)
        .all(),
    ).toHaveLength(1);
    expect(
      mgr.db.prepare(`SELECT value FROM meta WHERE key = 'test_subsystem_flag'`).get(),
    ).toEqual({ value: "KEEP" });
    // The index itself was still rebuilt from the file.
    expect(
      (
        mgr.db.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE text LIKE '%sailing%'`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });

  it("survives repeated reindexes: nothing erodes run over run", async () => {
    const { mgr } = await bootManager();
    await mgr.sync({ force: true });
    seedNonIndexState(mgr.db);
    const before = auxiliaryCounts(mgr.db);

    await mgr.sync({ force: true });
    await mgr.sync({ force: true });
    await mgr.sync({ force: true });

    expect(auxiliaryCounts(mgr.db)).toEqual(before);
  });

  it("aborts the swap and keeps the original database when the copy fails", async () => {
    const { mgr, root } = await bootManager();
    await mgr.sync({ force: true });
    seedNonIndexState(mgr.db);
    const before = auxiliaryCounts(mgr.db);

    carryOver.fail = true;
    await expect(mgr.sync({ force: true })).rejects.toThrow(/simulated carry-over failure/);

    // Still serving the original database, with everything in it.
    expect(auxiliaryCounts(mgr.db)).toEqual(before);
    expect(mgr.db.prepare(`SELECT body FROM lazily_created_prefs`).all()).toEqual([
      { body: "PREF_KEEPSAKE" },
    ]);
    // And no half-built temp database is left beside it.
    const leftovers = (await fs.readdir(root)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("passes every database it opens, including the reindex temp, through the test-state guard", async () => {
    // The guard is what stops a test process from opening the developer's real
    // memory database (2026-09-30). It only works if no open path skips it.
    const { mgr, dbPath } = await bootManager();
    expect(guard.paths).toContain(dbPath);

    guard.paths = [];
    await mgr.sync({ force: true });

    expect(guard.paths.some((p) => p.startsWith(`${dbPath}.tmp-`))).toBe(true);
    expect(guard.paths).toContain(dbPath);
  });
});
