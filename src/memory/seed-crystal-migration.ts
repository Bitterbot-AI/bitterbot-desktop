/**
 * Seed Crystal Migration: converts existing MEMORY.md content into
 * high-importance frozen crystals so that the dream engine's RLM
 * working-memory rewriter has a rich starting state.
 *
 * Runs once per database, guarded by a `seed_migration_done` flag in the
 * `meta` table.
 */
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:seed-migration");

const SEED_MIGRATION_KEY = "seed_migration_done";

/**
 * Chunk text into overlapping windows of roughly `maxTokens` tokens.
 * Uses a simple whitespace tokenizer (4 chars ≈ 1 token for Latin scripts;
 * CJK text averages ~2 chars/token, so this over-estimates chunk size for
 * non-Latin content — acceptable since smaller chunks are safe, just less efficient).
 */
function chunkText(text: string, maxTokens: number, overlapTokens: number): string[] {
  const charLimit = maxTokens * 4;
  const overlapChars = overlapTokens * 4;
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = Math.min(offset + charLimit, text.length);
    chunks.push(text.slice(offset, end));
    if (end >= text.length) break;
    offset = end - overlapChars;
  }
  return chunks;
}

export async function runSeedCrystalMigration(params: {
  db: DatabaseSync;
  workspaceDir: string;
}): Promise<void> {
  const { db, workspaceDir } = params;

  // Check if already migrated
  try {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(SEED_MIGRATION_KEY) as { value: string } | undefined;
    if (row?.value === "true") {
      return;
    }
  } catch {
    // meta table might not exist yet in edge cases — skip gracefully
    return;
  }

  const memoryMdPath = path.join(workspaceDir, "MEMORY.md");
  let content: string;
  try {
    content = await fs.readFile(memoryMdPath, "utf-8");
  } catch {
    // No MEMORY.md to migrate — mark done and return
    markDone(db);
    return;
  }

  const trimmed = content.trim();
  if (!trimmed) {
    markDone(db);
    return;
  }

  // Back up the original file
  const backupPath = `${memoryMdPath}.seed-backup`;
  try {
    await fs.writeFile(backupPath, content, "utf-8");
    log.info(`backed up MEMORY.md to ${backupPath}`);
  } catch (err) {
    log.warn(`failed to create seed backup: ${String(err)}`);
    // Continue anyway — the original file is still there
  }

  // Chunk using the standard pipeline parameters (400 tokens, 80 overlap)
  const chunks = chunkText(trimmed, 400, 80);

  const now = Date.now();
  // Note: chunks table requires model + embedding (NOT NULL in the base schema).
  // Insert placeholder values; real embeddings are generated on the next sync backfill.
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO chunks (
      id, path, source, start_line, end_line, text, hash,
      model, embedding,
      importance_score, lifecycle, semantic_type,
      access_count, last_accessed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const id = `seed_${crypto.randomUUID()}`;
    const hash = crypto.createHash("sha256").update(chunk).digest("hex");

    try {
      insertStmt.run(
        id,
        memoryMdPath,
        "memory",
        i * 100, // synthetic line numbers
        (i + 1) * 100,
        chunk,
        hash,
        "pending",       // placeholder model — will be backfilled on next sync
        "[]",            // placeholder embedding — will be backfilled on next sync
        0.75,            // moderately high — natural lifecycle will handle decay
        "consolidated",  // let the dream engine promote or decay naturally
        "general",
        1,               // access_count
        now,
        now,
        now,
      );
      inserted++;
    } catch (err) {
      log.warn(`failed to insert seed crystal ${i}: ${String(err)}`);
    }
  }

  log.info(`seed migration: inserted ${inserted} consolidated crystals from MEMORY.md (${chunks.length} chunks)`);
  markDone(db);
}

function markDone(db: DatabaseSync): void {
  try {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(SEED_MIGRATION_KEY, "true");
  } catch (err) {
    log.warn(`failed to mark seed migration done: ${String(err)}`);
  }
}

// ── Skill Bootstrap ──

const SKILL_BOOTSTRAP_KEY = "skill_bootstrap_done";

/**
 * Bootstrap skill crystals from the `skills/` directory at project root.
 * Each skill folder's SKILL.md is loaded as a frozen skill crystal so that
 * the dream engine's research mode has candidates from the start.
 *
 * Runs once per database, guarded by a `skill_bootstrap_done` flag.
 */
export async function runSkillBootstrap(params: {
  db: DatabaseSync;
  workspaceDir: string;
}): Promise<void> {
  const { db, workspaceDir } = params;

  // Check if already bootstrapped
  try {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(SKILL_BOOTSTRAP_KEY) as { value: string } | undefined;
    if (row?.value === "true") {
      return;
    }
  } catch {
    return;
  }

  const skillsDir = path.join(workspaceDir, "skills");
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(skillsDir, { withFileTypes: true });
    entries = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No skills/ directory — mark done and return
    markBootstrapDone(db);
    return;
  }

  if (entries.length === 0) {
    markBootstrapDone(db);
    return;
  }

  const now = Date.now();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO chunks (
      id, path, source, start_line, end_line, text, hash,
      model, embedding,
      importance_score, lifecycle, semantic_type, memory_type,
      skill_category, stable_skill_id,
      access_count, last_accessed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const folder of entries) {
    // Look for SKILL.md or README.md
    let content: string | null = null;
    for (const filename of ["SKILL.md", "README.md"]) {
      try {
        content = await fs.readFile(path.join(skillsDir, folder, filename), "utf-8");
        break;
      } catch { /* try next */ }
    }
    if (!content?.trim()) continue;

    // Deterministic UUID from folder name for idempotent re-runs
    const stableId = crypto.createHash("sha256").update(`skill:${folder}`).digest("hex").slice(0, 32);
    const deterministicUuid = [
      stableId.slice(0, 8),
      stableId.slice(8, 12),
      "4" + stableId.slice(13, 16),
      stableId.slice(16, 20),
      stableId.slice(20, 32),
    ].join("-");

    const hash = crypto.createHash("sha256").update(content).digest("hex");

    try {
      insertStmt.run(
        `skill_${deterministicUuid}`,
        path.join(skillsDir, folder),
        "skills",
        0,
        0,
        content.trim(),
        hash,
        "bootstrap",       // placeholder model
        "[]",              // placeholder embedding
        0.7,               // moderately high importance
        "frozen",          // frozen = stable, won't decay
        "skill",
        "skill",
        folder,            // skill_category = folder name
        deterministicUuid, // stable_skill_id
        1,
        now,
        now,
        now,
      );
      inserted++;
    } catch (err) {
      log.warn(`failed to bootstrap skill ${folder}: ${String(err)}`);
    }
  }

  if (inserted > 0) {
    log.info(`skill bootstrap: inserted ${inserted} frozen skill crystals from skills/ directory`);
  }
  markBootstrapDone(db);
}

function markBootstrapDone(db: DatabaseSync): void {
  try {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(SKILL_BOOTSTRAP_KEY, "true");
  } catch (err) {
    log.warn(`failed to mark skill bootstrap done: ${String(err)}`);
  }
}
