import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { runSeedCrystalMigration } from "./seed-crystal-migration.js";

describe("seed-crystal-migration", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seed-migration-test-"));
    db = new DatabaseSync(":memory:");
    // Set up schema matching the production chunks table (memory-schema.ts).
    // model + embedding are NOT NULL in the base schema — seed migration must
    // provide placeholder values to avoid silent INSERT OR IGNORE skips.
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        importance_score REAL DEFAULT 0.5,
        lifecycle TEXT DEFAULT 'generated',
        semantic_type TEXT DEFAULT 'general',
        access_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
  });

  it("should skip migration when no MEMORY.md exists", async () => {
    await runSeedCrystalMigration({ db, workspaceDir: tmpDir });

    const flag = db.prepare(`SELECT value FROM meta WHERE key = ?`).get("seed_migration_done") as
      | { value: string }
      | undefined;
    expect(flag?.value).toBe("true");

    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("should migrate MEMORY.md content into consolidated crystals", async () => {
    const content =
      "# My Memory\n\nSome important information about the project.\n\nMore details here.";
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), content, "utf-8");

    await runSeedCrystalMigration({ db, workspaceDir: tmpDir });

    const flag = db.prepare(`SELECT value FROM meta WHERE key = ?`).get("seed_migration_done") as
      | { value: string }
      | undefined;
    expect(flag?.value).toBe("true");

    const rows = db.prepare(`SELECT * FROM chunks`).all() as Array<{
      id: string;
      importance_score: number;
      lifecycle: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.importance_score).toBe(0.75);
    expect(rows[0]!.lifecycle).toBe("consolidated");
  });

  it("should create a backup file", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "test content", "utf-8");

    await runSeedCrystalMigration({ db, workspaceDir: tmpDir });

    const backupPath = path.join(tmpDir, "MEMORY.md.seed-backup");
    const backupContent = await fs.readFile(backupPath, "utf-8");
    expect(backupContent).toBe("test content");
  });

  it("should not run twice (idempotent)", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "test content", "utf-8");

    await runSeedCrystalMigration({ db, workspaceDir: tmpDir });
    const countAfterFirst = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number })
      .c;

    await runSeedCrystalMigration({ db, workspaceDir: tmpDir });
    const countAfterSecond = (db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number })
      .c;

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("should skip empty MEMORY.md", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "   \n\n  ", "utf-8");

    await runSeedCrystalMigration({ db, workspaceDir: tmpDir });

    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("should chunk large content into multiple crystals", async () => {
    // Create content larger than one chunk (~1600 chars = 400 tokens)
    const content = "Important fact. ".repeat(200);
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), content, "utf-8");

    await runSeedCrystalMigration({ db, workspaceDir: tmpDir });

    const count = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
    expect(count.c).toBeGreaterThan(1);
  });
});
