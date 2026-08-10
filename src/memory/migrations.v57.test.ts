/**
 * v57 (audit F12): backfill skill_category on peer/dream skill crystals.
 *
 * The derivation logic itself is covered in skill-category.test.ts; this
 * exercises the real migration path — rows present before the migration
 * runs get healed, and the migration only fills NULLs.
 */

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";

function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

/** v57 is data-only (no DDL), so a version rewind alone replays the real path. */
function downgradeToV56(db: DatabaseSync): void {
  db.prepare(`UPDATE meta SET value = '56' WHERE key = 'schema_version'`).run();
}

function insertSkillChunk(
  db: DatabaseSync,
  opts: {
    id: string;
    text: string;
    path: string;
    model: string;
    parentId?: string | null;
    skillCategory?: string | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (
      id, path, source, start_line, end_line, text, hash, model, embedding,
      updated_at, created_at, lifecycle_state, lifecycle, semantic_type,
      parent_id, skill_category
    ) VALUES (?, ?, 'skills', 0, 0, ?, ?, ?, '[]', ?, ?, 'active', 'generated', 'skill', ?, ?)`,
  ).run(
    opts.id,
    opts.path,
    opts.text,
    crypto.randomUUID(),
    opts.model,
    now,
    now,
    opts.parentId ?? null,
    opts.skillCategory ?? null,
  );
}

describe("migration v57: skill_category backfill", () => {
  it("heals pre-existing NULL categories via frontmatter and parent chains", () => {
    const db = openTestDb();
    downgradeToV56(db);

    // The live-node shapes: a peer crystal with a frontmatter name, a forage
    // response wrapper, and a dream mutation whose only link is parent_id.
    insertSkillChunk(db, {
      id: "peer-1",
      text: "---\nname: skill-f5e70aa9\ndescription: Dream-generated skill crystal\n---\nbody",
      path: "peer/skill-f5e70aa9",
      model: "peer",
    });
    insertSkillChunk(db, {
      id: "peer-2",
      text: "---\nname: response-705702b7-skill-f5e70aa9\n---\nbody",
      path: "peer/response-705702b7-skill-f5e70aa9",
      model: "peer",
    });
    insertSkillChunk(db, {
      id: "dream-1",
      text: "This composite skill combines capabilities without any frontmatter.",
      path: "dream/mutation/peer-1",
      model: "dream",
      parentId: "peer-1",
    });
    // Already-categorized row must be untouched.
    insertSkillChunk(db, {
      id: "boot-1",
      text: "---\nname: other-name\n---\n",
      path: "/skills/web-search",
      model: "bootstrap",
      skillCategory: "web-search",
    });

    const result = runMigrations(db);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);

    const cat = (id: string) =>
      (
        db.prepare(`SELECT skill_category FROM chunks WHERE id = ?`).get(id) as {
          skill_category: string | null;
        }
      ).skill_category;

    expect(cat("peer-1")).toBe("skill-f5e70aa9");
    expect(cat("peer-2")).toBe("skill-f5e70aa9");
    expect(cat("dream-1")).toBe("skill-f5e70aa9");
    expect(cat("boot-1")).toBe("web-search");

    const nulls = db
      .prepare(
        `SELECT COUNT(*) AS c FROM chunks
         WHERE semantic_type = 'skill' AND skill_category IS NULL`,
      )
      .get() as { c: number };
    expect(nulls.c).toBe(0);
  });
});
