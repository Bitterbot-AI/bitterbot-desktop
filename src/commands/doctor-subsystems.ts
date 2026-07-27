/**
 * Doctor coverage for subsystems that landed after doctor's Q1 baseline and
 * had NO health check: the embedding backlog, knowledge-graph population, the
 * canonical facts ledger, and Circles.
 *
 * These are DEEP checks — they open the agent's memory DB read-only and query
 * real state — but they are all warn/info, never error. Rationale: they report
 * DATA state (an empty graph, an embedding backlog), which is equally true
 * before and after an update, so they must not block the update gate. Only
 * build/boot-health failures (corrupt DB, missing core tables in
 * doctor-memory-system) are error-level. The whole point here is to surface
 * the project's signature "wired-but-dead" failure mode, which doctor was
 * structurally blind to.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { applyCirclesDefaults } from "../config/defaults.js";
import { countMissingEmbeddings } from "../memory/embedding-backfill.js";
import { renderSection as renderDoctorSection } from "./doctor-check.js";

type Level = "ok" | "warn" | "error" | "info";
type CheckResult = { level: Level; message: string };
const ok = (message: string): CheckResult => ({ level: "ok", message });
const warn = (message: string): CheckResult => ({ level: "warn", message });
const info = (message: string): CheckResult => ({ level: "info", message });

function renderSection(title: string, results: CheckResult[]): void {
  renderDoctorSection(title, results);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function count(db: DatabaseSync, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export type SubsystemReport = {
  title: string;
  results: CheckResult[];
}[];

/**
 * Count rows in the vector index without loading sqlite-vec: `chunks_vec` is
 * a vec0 virtual table (COUNT on it throws "no such module" in a process that
 * hasn't loaded the extension), but its `chunks_vec_rowids` shadow table is a
 * plain table with one row per stored vector.
 */
function countVectorIndexRows(db: DatabaseSync): number | null {
  for (const sql of [
    `SELECT COUNT(*) AS c FROM chunks_vec_rowids`,
    `SELECT COUNT(*) AS c FROM chunks_vec`,
  ]) {
    try {
      const row = db.prepare(sql).get() as { c: number } | undefined;
      if (row) return row.c;
    } catch {
      // try the next form
    }
  }
  return null;
}

function checkVectorIndexCoverage(
  db: DatabaseSync,
  embedded: number,
  vectorEnabled: boolean,
): CheckResult[] {
  if (!tableExists(db, "chunks_vec")) {
    if (!vectorEnabled) {
      return [info("Vector search disabled in config — no vector index expected.")];
    }
    return [
      warn(
        `Vector index absent: ${embedded} crystals carry embeddings but the chunks_vec table ` +
          `does not exist — sqlite-vec was unavailable at write time, so vector search finds ` +
          `NOTHING despite "embedded" data. See the Memory search section for the sqlite-vec probe.`,
      ),
    ];
  }
  const indexed = countVectorIndexRows(db);
  if (indexed === null) {
    return [info("Vector index present but not countable from this process — coverage unknown.")];
  }
  if (indexed === 0) {
    return [
      warn(
        `Vector index is EMPTY: ${embedded} crystals carry embeddings but 0 are indexed in ` +
          `chunks_vec — vector search finds nothing (wired-but-dead index).`,
      ),
    ];
  }
  if (indexed < embedded * 0.9) {
    return [
      warn(
        `Vector index covers ${indexed}/${embedded} embedded crystals — ` +
          `${embedded - indexed} are unreachable by vector search until the index is rebuilt.`,
      ),
    ];
  }
  return [ok(`Vector index: ${indexed}/${embedded} embedded crystals indexed.`)];
}

function checkFtsIndexCoverage(
  db: DatabaseSync,
  embedded: number,
  total: number,
  ftsEnabled: boolean,
): CheckResult[] {
  if (!tableExists(db, "chunks_fts")) {
    if (!ftsEnabled) {
      return [info("Hybrid keyword search disabled in config — no FTS index expected.")];
    }
    return [
      warn(
        `Keyword (FTS) index absent with ${total} crystals present — keyword search finds nothing.`,
      ),
    ];
  }
  let indexed: number | null = null;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM chunks_fts`).get() as
      | { c: number }
      | undefined;
    indexed = row?.c ?? null;
  } catch {
    return [info("FTS index present but not countable from this process — coverage unknown.")];
  }
  if (indexed === null) {
    return [info("FTS index present but not countable from this process — coverage unknown.")];
  }
  if (indexed === 0) {
    return [
      warn(
        `Keyword (FTS) index is EMPTY: ${embedded} embedded crystals but 0 rows in chunks_fts — ` +
          `keyword search finds nothing (wired-but-dead index).`,
      ),
    ];
  }
  if (indexed < embedded * 0.9) {
    return [
      warn(
        `Keyword (FTS) index has ${indexed} rows vs ${embedded} embedded crystals — ` +
          `a large share of memory may be unreachable by keyword search until the index is rebuilt.`,
      ),
    ];
  }
  return [ok(`Keyword (FTS) index: ${indexed} rows for ${embedded} embedded crystals.`)];
}

/**
 * Pure inspection of an already-open DB. Exported for tests so the checks can
 * be verified against a real migrated schema without config resolution.
 */
export function inspectSubsystems(
  db: DatabaseSync,
  cfg: BitterbotConfig,
  dbLabel: string,
): SubsystemReport {
  const report: SubsystemReport = [];
  const totalChunks = tableExists(db, "chunks") ? count(db, `SELECT COUNT(*) AS c FROM chunks`) : 0;

  // ── Embedding backlog ── (the ~7.3k unembedded-crystal blind spot)
  const embedding: CheckResult[] = [];
  if (tableExists(db, "chunks")) {
    const missing = countMissingEmbeddings(db);
    const worstMissing = Math.max(...Object.values(missing));
    const semanticMissing = missing.semantic;
    if (totalChunks === 0) {
      embedding.push(info("No crystals yet — nothing to embed."));
    } else if (semanticMissing === 0 && worstMissing === 0) {
      embedding.push(ok(`All ${totalChunks} crystals embedded across every perspective.`));
    } else {
      const pct = Math.round((semanticMissing / totalChunks) * 100);
      embedding.push(
        warn(
          `Embedding backlog: ${semanticMissing}/${totalChunks} crystals (${pct}%) lack a semantic embedding ` +
            `(worst perspective: ${worstMissing}). Semantic recall is degraded until backfill runs. ` +
            `Details per perspective: ${JSON.stringify(missing)}.`,
        ),
      );
    }
    // Search-index coverage. The embedding COLUMN being populated proves
    // nothing about searchability: chunks_vec/chunks_fts rows are only written
    // when sqlite-vec/FTS were available at write time, so a node can report
    // "all embedded" while vector search finds nothing (the 2026-06 sqlite-vec
    // incident). Compare indexed rows against chunks that actually carry an
    // embedding.
    // json_valid guard first: '' is a first-class "unembedded" state and
    // json_array_length THROWS on it, which would abort the count and silently
    // skip the coverage checks on exactly the degraded DBs they exist for.
    const embedded = count(
      db,
      `SELECT COUNT(*) AS c FROM chunks
        WHERE model IS NOT NULL AND model <> 'pending'
          AND json_valid(embedding) AND json_array_length(embedding) > 0
          AND (lifecycle_state IS NULL OR lifecycle_state <> 'forgotten')
          AND (lifecycle IS NULL OR lifecycle <> 'expired')`,
    );
    const memCfg = resolveMemorySearchConfig(cfg, resolveDefaultAgentId(cfg));
    if (embedded > 0 && memCfg) {
      const vectorEnabled = memCfg.store.vector.enabled;
      const ftsEnabled = memCfg.query.hybrid.enabled;
      embedding.push(...checkVectorIndexCoverage(db, embedded, vectorEnabled));
      embedding.push(...checkFtsIndexCoverage(db, embedded, totalChunks, ftsEnabled));
    }
  }
  report.push({ title: "Memory Embeddings", results: embedding });

  // ── Knowledge-graph population ── (the recurring wired-but-dead empty table)
  const graph: CheckResult[] = [];
  if (tableExists(db, "entities") && tableExists(db, "relationships")) {
    const entities = count(db, `SELECT COUNT(*) AS c FROM entities`);
    const relationships = count(db, `SELECT COUNT(*) AS c FROM relationships`);
    if (entities === 0 && relationships === 0) {
      if (totalChunks > 50) {
        graph.push(
          warn(
            `Knowledge graph is empty (0 entities, 0 relationships) despite ${totalChunks} crystals — ` +
              `graph extraction may be wired-but-dead. Check the relationship-mining dream mode.`,
          ),
        );
      } else {
        graph.push(info("Knowledge graph empty (few crystals yet — expected early)."));
      }
    } else if (relationships === 0 && entities > 0) {
      graph.push(
        warn(
          `Knowledge graph has ${entities} entities but 0 relationships — relationship extraction may be dead.`,
        ),
      );
    } else {
      graph.push(ok(`Knowledge graph: ${entities} entities, ${relationships} relationships.`));
    }
  } else {
    graph.push(info("Knowledge-graph tables absent (pre-graph DB or not yet migrated)."));
  }
  report.push({ title: "Knowledge Graph", results: graph });

  // ── Canonical facts ledger ──
  const canonical: CheckResult[] = [];
  if (tableExists(db, "canonical_facts")) {
    const active = count(db, `SELECT COUNT(*) AS c FROM canonical_facts WHERE valid_until IS NULL`);
    const superseded = count(
      db,
      `SELECT COUNT(*) AS c FROM canonical_facts WHERE valid_until IS NOT NULL`,
    );
    canonical.push(
      active === 0 && totalChunks > 100
        ? warn(
            `Canonical facts ledger is empty despite ${totalChunks} crystals — ` +
              `auto-pinning of ground-truth facts may not be running.`,
          )
        : ok(`Canonical ledger: ${active} active fact(s), ${superseded} superseded.`),
    );
  } else {
    canonical.push(info("Canonical facts table absent (pre-PLAN-33 DB or not yet migrated)."));
  }
  report.push({ title: "Canonical Facts Ledger", results: canonical });

  // ── Circles ── config resolution + the right-DB check
  const circles: CheckResult[] = [];
  const circlesCfg = applyCirclesDefaults(cfg).circles;
  if (circlesCfg?.enabled === false) {
    circles.push(info("Circles disabled (circles.enabled = false)."));
  } else {
    circles.push(ok("Circles enabled (default)."));
    // The wrong-agent-DB bug: circles must live on THIS agent's DB. doctor
    // resolved the DB via resolveDefaultAgentId, so finding the tables here is
    // the check that they are not orphaned on a stray default.sqlite.
    const hasCircleTables = tableExists(db, "circles") && tableExists(db, "circle_members");
    if (!hasCircleTables) {
      circles.push(
        warn(
          `Circles enabled but its tables are absent on the agent DB (${dbLabel}). ` +
            `Either the gateway has not initialized them yet, or they were created on a different ` +
            `agent DB (the "default" vs resolved-agent split). Start the gateway once and re-check.`,
        ),
      );
    } else {
      const circleCount = count(db, `SELECT COUNT(*) AS c FROM circles WHERE status = 'active'`);
      circles.push(ok(`Circles tables present on the agent DB; ${circleCount} active circle(s).`));
    }
    if (!circlesCfg?.mailbox?.url) {
      circles.push(warn("No circles.mailbox.url — offline delivery to sleeping peers will fail."));
    }
    if (!circlesCfg?.a2aPublicUrl) {
      circles.push(
        info("No circles.a2aPublicUrl — direct dial unavailable; relies on the mailbox relay."),
      );
    }
  }
  report.push({ title: "Circles", results: circles });

  return report;
}

/**
 * Health checks for post-Q1 subsystems. Opens the agent memory DB read-only;
 * needs no running gateway. Safe to run standalone or inside the update gate.
 */
export function runSubsystemChecks(params: { config: BitterbotConfig }): void {
  const cfg = params.config;
  const agentId = resolveDefaultAgentId(cfg);
  const dbPath = resolveMemorySearchConfig(cfg, agentId)?.store?.path ?? "";

  if (!dbPath || !fs.existsSync(dbPath)) {
    renderSection("Subsystems", [
      info("Memory DB not initialized yet — subsystem checks skipped until first run."),
    ]);
    return;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch (err) {
    renderSection("Subsystems", [warn(`Could not open memory DB read-only: ${String(err)}`)]);
    return;
  }

  try {
    for (const section of inspectSubsystems(db, cfg, dbPath)) {
      renderSection(section.title, section.results);
    }
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
