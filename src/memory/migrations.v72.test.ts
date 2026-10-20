/** Migration v72: lifecycle column repair (Agent Memory Atlas review). */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

describe("migration v72: lifecycle column repair", () => {
  it("re-derives expired rows as forgotten and fills NULLs from the other column", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
    const ins = db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
         updated_at, lifecycle, lifecycle_state)
       VALUES (?, 'p', 'memory', 0, 0, 'h', 'm', 't', '[]', 0, ?, ?)`,
    );
    ins.run("expired", "expired", "archived");
    ins.run("state-null", "consolidated", null);
    ins.run("fine-null", null, "forgotten");
    ins.run("untouched", "archived", "forgotten"); // merge loser: valid pair
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run("71");
    runMigrations(db);
    const rows = Object.fromEntries(
      (
        db.prepare(`SELECT id, lifecycle, lifecycle_state FROM chunks`).all() as Array<{
          id: string;
          lifecycle: string;
          lifecycle_state: string;
        }>
      ).map((r) => [r.id, `${r.lifecycle}/${r.lifecycle_state}`]),
    );
    expect(rows).toEqual({
      expired: "expired/forgotten",
      "state-null": "consolidated/consolidated",
      "fine-null": "expired/forgotten",
      untouched: "archived/forgotten",
    });
  });
});
