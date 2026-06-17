#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
/**
 * One-shot additive backfill: populate chunks_vec from already-stored
 * chunks.embedding for chunks that have a valid 1536-dim embedding but no
 * vector-index row (they were written while sqlite-vec was failing to load).
 *
 * Additive only — never deletes chunk content. Mirrors the manager's insert
 * (DELETE+INSERT id, Buffer.from(new Float32Array(embedding).buffer)). Commits
 * in small batches with a busy_timeout so the live gateway is never blocked.
 */
import { DatabaseSync } from "node:sqlite";

const DB = process.env.BB_MEMORY_DB ?? path.join(os.homedir(), ".bitterbot/memory/main.sqlite");
const DIM = 1536;
const BATCH = 400;

const sqliteVec = await import("sqlite-vec");
const db = new DatabaseSync(DB, { allowExtension: true });
db.exec("PRAGMA busy_timeout = 30000");
db.enableLoadExtension(true);
sqliteVec.load(db);

const targets = db
  .prepare(
    `SELECT id, embedding FROM chunks
     WHERE json_array_length(embedding) = ?
       AND id NOT IN (SELECT id FROM chunks_vec)
       AND (lifecycle_state IS NULL OR lifecycle_state <> 'forgotten')
       AND (lifecycle IS NULL OR lifecycle <> 'expired')`,
  )
  .all(DIM);

console.log(`[backfill] candidates: ${targets.length} (dim=${DIM})`);
const del = db.prepare("DELETE FROM chunks_vec WHERE id = ?");
const ins = db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)");

let done = 0;
let skipped = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  const slice = targets.slice(i, i + BATCH);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of slice) {
      const arr = JSON.parse(row.embedding);
      if (!Array.isArray(arr) || arr.length !== DIM) {
        skipped++;
        continue;
      }
      const blob = Buffer.from(new Float32Array(arr).buffer);
      del.run(row.id);
      ins.run(row.id, blob);
      done++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  process.stdout.write(`\r[backfill] indexed ${done}/${targets.length}  `);
}

const finalCount = Number(db.prepare("SELECT count(*) c FROM chunks_vec").get().c);
console.log(
  `\n[backfill] done. inserted=${done} skipped=${skipped} chunks_vec total=${finalCount}`,
);
db.close();
