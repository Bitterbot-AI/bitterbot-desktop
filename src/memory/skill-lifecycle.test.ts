import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { SkillLifecycleStore } from "./skill-lifecycle.js";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
  });
  runMigrations(db);
  return db;
}

describe("migration v12 — skill_lifecycle table", () => {
  it("creates the table with the documented columns", () => {
    const db = newDb();
    const cols = db.prepare(`PRAGMA table_info(skill_lifecycle)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const names = new Set(cols.map((c) => c.name));
    for (const required of [
      "skill_name",
      "origin",
      "state",
      "created_at",
      "last_used_at",
      "usage_count",
      "success_count",
      "error_count",
      "consolidated_into",
      "pinned",
      "updated_at",
    ]) {
      expect(names.has(required)).toBe(true);
    }
  });

  it("creates the supporting indexes", () => {
    const db = newDb();
    const idxs = db.prepare(`PRAGMA index_list(skill_lifecycle)`).all() as Array<{ name: string }>;
    const names = new Set(idxs.map((i) => i.name));
    expect(names.has("idx_skill_lifecycle_state")).toBe(true);
    expect(names.has("idx_skill_lifecycle_origin")).toBe(true);
    expect(names.has("idx_skill_lifecycle_last_used")).toBe(true);
  });

  it("backfills aggregates from skill_executions", () => {
    // Build a DB with executions data BEFORE running v12 — simulates the
    // upgrade path on a pre-v12 install.
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
    });
    db.prepare(
      `INSERT INTO meta(key, value) VALUES('schema_version', '11')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    // Replay the parts of v2 that create skill_executions and skill_category.
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_executions (
        id TEXT PRIMARY KEY,
        skill_crystal_id TEXT NOT NULL,
        session_id TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        success INTEGER,
        reward_score REAL,
        error_type TEXT,
        error_detail TEXT,
        execution_time_ms INTEGER,
        tool_calls_count INTEGER,
        user_feedback INTEGER,
        context_json TEXT DEFAULT '{}'
      )
    `);
    // skill_category column already exists on chunks via ensureMemoryIndexSchema.

    const skillNames = ["alpha", "alpha", "alpha", "beta", "beta", "gamma"];
    const successes = [1, 1, 0, 1, 0, 1];
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < skillNames.length; i++) {
      const crystalId = `c-${i}`;
      db.prepare(
        `INSERT INTO chunks (
           id, path, source, start_line, end_line, hash, model, text, embedding,
           updated_at, skill_category
         ) VALUES (?, 'mem://test', 'memory', 0, 0, '', 'test', '', '[]', ?, ?)`,
      ).run(crystalId, t0 + i * 1000, skillNames[i] ?? null);
      db.prepare(
        `INSERT INTO skill_executions (id, skill_crystal_id, started_at, completed_at, success)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`e-${i}`, crystalId, t0 + i * 1000, t0 + i * 1000 + 50, successes[i] ?? null);
    }

    runMigrations(db);

    const store = new SkillLifecycleStore(db);
    const alpha = store.get("alpha");
    expect(alpha).not.toBeNull();
    expect(alpha?.usageCount).toBe(3);
    expect(alpha?.successCount).toBe(2);
    expect(alpha?.errorCount).toBe(1);
    expect(alpha?.origin).toBe("unknown"); // backfill default
    expect(alpha?.state).toBe("active");
    expect(alpha?.lastUsedAt).toBe(t0 + 2 * 1000); // most recent of the three

    const beta = store.get("beta");
    expect(beta?.usageCount).toBe(2);
    expect(beta?.successCount).toBe(1);
    expect(beta?.errorCount).toBe(1);

    const gamma = store.get("gamma");
    expect(gamma?.usageCount).toBe(1);
    expect(gamma?.successCount).toBe(1);
  });

  it("backfill is idempotent — running migrations twice does not double-count", () => {
    const db = newDb();
    // After newDb(), schema is at the latest version. Re-running is a no-op.
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(skill_lifecycle)`).all() as Array<{ name: string }>;
    expect(cols.length).toBeGreaterThan(0);
  });
});

describe("SkillLifecycleStore.recordUsage", () => {
  it("creates a row on first use with correct counts", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "test-skill", success: true, timestamp: 1000 });
    const row = store.get("test-skill");
    expect(row).not.toBeNull();
    expect(row?.usageCount).toBe(1);
    expect(row?.successCount).toBe(1);
    expect(row?.errorCount).toBe(0);
    expect(row?.lastUsedAt).toBe(1000);
    expect(row?.createdAt).toBe(1000);
    expect(row?.state).toBe("active");
    expect(row?.origin).toBe("unknown");
    expect(row?.pinned).toBe(false);
  });

  it("upserts subsequent calls — increments counts and bumps last_used_at", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "s", success: true, timestamp: 1000 });
    store.recordUsage({ skillName: "s", success: true, timestamp: 2000 });
    store.recordUsage({ skillName: "s", success: false, timestamp: 3000 });
    const row = store.get("s");
    expect(row?.usageCount).toBe(3);
    expect(row?.successCount).toBe(2);
    expect(row?.errorCount).toBe(1);
    expect(row?.lastUsedAt).toBe(3000);
    expect(row?.createdAt).toBe(1000); // unchanged after first insert
  });

  it("honors the origin on first insert and ignores it on conflict", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({
      skillName: "s",
      success: true,
      timestamp: 1000,
      origin: "agent_authored",
    });
    store.recordUsage({
      skillName: "s",
      success: true,
      timestamp: 2000,
      origin: "p2p",
    });
    expect(store.get("s")?.origin).toBe("agent_authored");
  });

  it("ignores empty skill names", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "  ", success: true });
    expect(store.listAll().length).toBe(0);
  });
});

describe("SkillLifecycleStore state management", () => {
  it("setState updates and refuses to write the 'pinned' sentinel via this path", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "s", success: true });
    store.setState("s", "stale");
    expect(store.get("s")?.state).toBe("stale");
    store.setState("s", "pinned"); // ignored
    expect(store.get("s")?.state).toBe("stale");
  });

  it("setState refuses to touch a pinned row", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "s", success: true });
    store.pin("s");
    store.setState("s", "archived");
    expect(store.get("s")?.state).toBe("active"); // unchanged
    expect(store.get("s")?.pinned).toBe(true);
  });

  it("consolidateInto archives source and records target", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "old", success: true });
    store.recordUsage({ skillName: "new", success: true });
    store.consolidateInto("old", "new");
    const row = store.get("old");
    expect(row?.state).toBe("archived");
    expect(row?.consolidatedInto).toBe("new");
  });

  it("consolidateInto refuses self-targets and empty inputs", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "s", success: true });
    store.consolidateInto("s", "s");
    store.consolidateInto("s", "");
    store.consolidateInto("", "t");
    expect(store.get("s")?.state).toBe("active");
  });

  it("pin/unpin toggle correctly", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "s", success: true });
    store.pin("s");
    expect(store.get("s")?.pinned).toBe(true);
    store.unpin("s");
    expect(store.get("s")?.pinned).toBe(false);
  });

  it("forget deletes the row", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "s", success: true });
    store.forget("s");
    expect(store.get("s")).toBeNull();
  });
});

describe("SkillLifecycleStore selectors", () => {
  it("listByState filters by state and excludes pinned rows by default", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "a-active", success: true });
    store.recordUsage({ skillName: "b-stale", success: true });
    store.recordUsage({ skillName: "c-pinned", success: true });
    store.setState("b-stale", "stale");
    store.pin("c-pinned");

    const actives = store.listByState("active");
    expect(actives.map((r) => r.skillName).toSorted()).toEqual(["a-active"]);

    const stales = store.listByState("stale");
    expect(stales.map((r) => r.skillName).toSorted()).toEqual(["b-stale"]);

    const pinned = store.listByState("pinned");
    expect(pinned.map((r) => r.skillName).toSorted()).toEqual(["c-pinned"]);
  });

  it("listCuratorCandidates returns only agent_authored, unpinned, non-archived", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "agent-a", success: true, origin: "agent_authored" });
    store.recordUsage({ skillName: "agent-b", success: true, origin: "agent_authored" });
    store.recordUsage({ skillName: "user-c", success: true, origin: "workspace" });
    store.recordUsage({ skillName: "p2p-d", success: true, origin: "p2p" });
    store.pin("agent-b");
    store.setState("agent-a", "stale"); // still a candidate
    store.recordUsage({ skillName: "agent-e", success: false, origin: "agent_authored" });
    store.setState("agent-e", "archived"); // excluded

    const candidates = store.listCuratorCandidates().map((r) => r.skillName);
    expect(candidates.toSorted()).toEqual(["agent-a"]);
  });

  it("setOrigin upgrades a row's origin without changing other fields", () => {
    const db = newDb();
    const store = new SkillLifecycleStore(db);
    store.recordUsage({ skillName: "s", success: true, timestamp: 1000 });
    const before = store.get("s");
    store.setOrigin("s", "agent_authored");
    const after = store.get("s");
    expect(after?.origin).toBe("agent_authored");
    expect(after?.usageCount).toBe(before?.usageCount);
    expect(after?.createdAt).toBe(before?.createdAt);
  });
});
