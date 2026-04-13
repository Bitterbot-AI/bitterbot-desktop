/**
 * Doctor checks for the biological memory architecture:
 * workspace identity files, GENOME.md, MEMORY.md schema, SQLite DB health,
 * dream engine, hormonal system, and curiosity engine (GCCRF).
 *
 * P2P state (orchestrator binary, DNS bootstrap, peer reachability,
 * live peer count) is reported by the separate top-level P2P Network
 * doctor section — see src/commands/doctor-p2p.ts.
 *
 * Reads the database directly (read-only) — does NOT require the gateway.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BitterbotConfig } from "../config/config.js";
import { DEFAULT_GCCRF_CONFIG } from "../memory/gccrf-reward.js";
import { parseGenomeHomeostasis, parsePhenotypeConstraints } from "../memory/genome-parser.js";
import { WORKING_MEMORY_SECTIONS } from "../memory/working-memory-prompt.js";
import { note } from "../terminal/note.js";

// ── Types ──

type CheckLevel = "ok" | "warn" | "error" | "info";

type DoctorCheckResult = {
  level: CheckLevel;
  message: string;
};

// ── Helpers ──

function ok(message: string): DoctorCheckResult {
  return { level: "ok", message };
}
function warn(message: string): DoctorCheckResult {
  return { level: "warn", message };
}
function error(message: string): DoctorCheckResult {
  return { level: "error", message };
}
function info(message: string): DoctorCheckResult {
  return { level: "info", message };
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(tableName) as { name: string } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

function formatLevel(result: DoctorCheckResult): string {
  switch (result.level) {
    case "ok":
      return `\u2714 ${result.message}`;
    case "warn":
      return `\u26A0 ${result.message}`;
    case "error":
      return `\u2718 ${result.message}`;
    case "info":
      return `\u2139 ${result.message}`;
  }
}

// ── Check Groups ──

function checkWorkspaceIdentityFiles(workspaceDir: string): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];
  const requiredFiles = ["GENOME.md", "PROTOCOLS.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];

  for (const file of requiredFiles) {
    const filePath = path.join(workspaceDir, file);
    if (fs.existsSync(filePath)) {
      results.push(ok(`${file} exists`));
    } else {
      results.push(warn(`${file} missing — run \`bitterbot onboard\` to create it`));
    }
  }

  return results;
}

function checkGenomeStructure(workspaceDir: string): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];
  const genomePath = path.join(workspaceDir, "GENOME.md");

  if (!fs.existsSync(genomePath)) {
    results.push(error("GENOME.md not found — cannot validate structure"));
    return results;
  }

  try {
    const content = fs.readFileSync(genomePath, "utf-8");

    // Safety Axioms
    if (/## Safety Axioms/.test(content)) {
      const section = content.match(/## Safety Axioms[\s\S]*?\n([\s\S]*?)(?=\n## |$)/);
      if (section?.[1]?.trim()) {
        results.push(ok("Safety Axioms section present"));
      } else {
        results.push(warn("Safety Axioms section is empty"));
      }
    } else {
      results.push(warn("Missing ## Safety Axioms section"));
    }

    // Hormonal Homeostasis
    if (/## Hormonal Homeostasis/.test(content)) {
      const homeostasis = parseGenomeHomeostasis(content);
      if (homeostasis) {
        const { dopamine, cortisol, oxytocin } = homeostasis;
        const valid =
          dopamine !== undefined &&
          dopamine >= 0 &&
          dopamine <= 1 &&
          cortisol !== undefined &&
          cortisol >= 0 &&
          cortisol <= 1 &&
          oxytocin !== undefined &&
          oxytocin >= 0 &&
          oxytocin <= 1;
        if (valid) {
          results.push(
            ok(
              `Hormonal Homeostasis: dopamine=${dopamine} cortisol=${cortisol} oxytocin=${oxytocin}`,
            ),
          );
        } else {
          results.push(
            warn("Hormonal Homeostasis YAML has missing or out-of-range values (expected 0-1)"),
          );
        }
      } else {
        results.push(warn("Hormonal Homeostasis section exists but YAML could not be parsed"));
      }
    } else {
      results.push(warn("Missing ## Hormonal Homeostasis section"));
    }

    // Phenotype Constraints
    if (/## Phenotype Constraints/.test(content)) {
      const constraints = parsePhenotypeConstraints(content);
      if (constraints.length > 0) {
        results.push(ok(`Phenotype Constraints: ${constraints.length} constraint(s)`));
      } else {
        results.push(warn("Phenotype Constraints section is empty"));
      }
    } else {
      results.push(warn("Missing ## Phenotype Constraints section"));
    }

    // Core Values
    if (/## Core Values/.test(content)) {
      results.push(ok("Core Values section present"));
    } else {
      results.push(warn("Missing ## Core Values section"));
    }
  } catch (err) {
    results.push(error(`Failed to read GENOME.md: ${String(err)}`));
  }

  return results;
}

function checkMemorySchema(workspaceDir: string): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];
  const memoryPath = path.join(workspaceDir, "MEMORY.md");

  if (!fs.existsSync(memoryPath)) {
    results.push(warn("MEMORY.md not found — dream engine has not synthesized working memory yet"));
    return results;
  }

  try {
    const content = fs.readFileSync(memoryPath, "utf-8");

    // Check header
    if (/# Working Memory State/.test(content)) {
      results.push(ok("Working Memory State header present"));
    } else {
      results.push(warn("Missing '# Working Memory State' header"));
    }

    // Check all 7 sections
    let presentCount = 0;
    for (const section of WORKING_MEMORY_SECTIONS) {
      if (content.includes(`## ${section}`)) {
        presentCount++;
      } else {
        results.push(warn(`Missing section: ## ${section}`));
      }
    }
    if (presentCount === WORKING_MEMORY_SECTIONS.length) {
      results.push(ok(`All ${WORKING_MEMORY_SECTIONS.length} working memory sections present`));
    } else {
      results.push(
        info(
          `${presentCount}/${WORKING_MEMORY_SECTIONS.length} sections present (nascent agent may not have all yet)`,
        ),
      );
    }
  } catch (err) {
    results.push(error(`Failed to read MEMORY.md: ${String(err)}`));
  }

  return results;
}

function checkMemoryDatabase(dbPath: string): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  if (!fs.existsSync(dbPath)) {
    results.push(warn(`Database not found at ${dbPath} — memory system has not been initialized`));
    return results;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });

    // Integrity check — quick_check skips index consistency (fast on large DBs)
    try {
      const integrity = db.prepare(`PRAGMA quick_check`).get() as
        | { quick_check: string }
        | undefined;
      if (integrity?.quick_check === "ok") {
        results.push(ok("Database integrity check passed"));
      } else {
        results.push(
          error(`Database integrity check failed: ${integrity?.quick_check ?? "unknown"}`),
        );
      }
    } catch (err) {
      results.push(error(`Integrity check failed: ${String(err)}`));
    }

    // Schema version
    try {
      const versionRow = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      const version = versionRow ? parseInt(versionRow.value, 10) : 0;
      if (version === 4) {
        results.push(ok(`Schema version: ${version} (current)`));
      } else if (version > 0) {
        results.push(
          warn(`Schema version: ${version} (expected 4 — run gateway to trigger migration)`),
        );
      } else {
        results.push(warn("Schema version not found in meta table"));
      }
    } catch {
      results.push(warn("meta table not found — database may be pre-migration"));
    }

    // Core tables
    const coreTables = ["chunks", "dream_cycles", "dream_insights"];
    for (const table of coreTables) {
      if (tableExists(db, table)) {
        results.push(ok(`Table '${table}' exists`));
      } else {
        results.push(error(`Table '${table}' missing`));
      }
    }

    // Optional tables (may not exist for new installs)
    const optionalTables = ["curiosity_targets", "peer_reputation", "skill_executions"];
    for (const table of optionalTables) {
      if (tableExists(db, table)) {
        results.push(ok(`Table '${table}' exists`));
      } else {
        results.push(info(`Table '${table}' not found (created on first use)`));
      }
    }

    // Crystal count
    if (tableExists(db, "chunks")) {
      try {
        const countRow = db.prepare(`SELECT COUNT(*) as c FROM chunks`).get() as { c: number };
        if (countRow.c === 0) {
          results.push(warn("No crystals indexed yet — memory is empty"));
        } else {
          results.push(ok(`Crystal count: ${countRow.c}`));
        }

        // Lifecycle distribution
        try {
          const rows = db
            .prepare(
              `SELECT lifecycle, COUNT(*) as c FROM chunks GROUP BY lifecycle ORDER BY c DESC`,
            )
            .all() as Array<{ lifecycle: string | null; c: number }>;
          if (rows.length > 0) {
            const dist = rows.map((r) => `${r.lifecycle ?? "null"}=${r.c}`).join(", ");
            results.push(info(`Lifecycle distribution: ${dist}`));
          }
        } catch {
          // lifecycle column may not exist on very old schemas
        }
      } catch (err) {
        results.push(warn(`Could not query chunks table: ${String(err)}`));
      }
    }
  } catch (err) {
    results.push(error(`Failed to open database: ${String(err)}`));
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }

  return results;
}

function checkDreamEngine(dbPath: string, isGatewayRunning: boolean): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  if (!fs.existsSync(dbPath)) {
    results.push(info("Database not found — dream engine status unavailable"));
    return results;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });

    if (!tableExists(db, "dream_cycles")) {
      results.push(warn("dream_cycles table not found — dream engine has not run"));
      return results;
    }

    // Total dream cycles
    const totalRow = db
      .prepare(`SELECT COUNT(*) as c FROM dream_cycles WHERE completed_at IS NOT NULL`)
      .get() as { c: number };
    results.push(info(`Dream cycles completed: ${totalRow.c}`));

    if (totalRow.c === 0) {
      results.push(warn("Dream engine has not run yet"));
      return results;
    }

    // Last dream cycle
    try {
      const lastRow = db
        .prepare(
          `SELECT started_at, duration_ms, insights_generated, modes_used, error
           FROM dream_cycles ORDER BY started_at DESC LIMIT 1`,
        )
        .get() as
        | {
            started_at: number;
            duration_ms: number | null;
            insights_generated: number;
            modes_used: string | null;
            error: string | null;
          }
        | undefined;

      if (lastRow) {
        const agoMs = Date.now() - lastRow.started_at;
        const agoHours = (agoMs / (60 * 60_000)).toFixed(1);
        const durationSec = lastRow.duration_ms ? (lastRow.duration_ms / 1000).toFixed(1) : "?";
        results.push(
          info(
            `Last dream: ${agoHours}h ago, ${durationSec}s duration, ${lastRow.insights_generated} insights`,
          ),
        );

        if (lastRow.modes_used) {
          try {
            const modes = JSON.parse(lastRow.modes_used) as string[];
            if (modes.length > 0) {
              results.push(info(`Modes used: ${modes.join(", ")}`));
            }
          } catch {
            // ignore parse errors
          }
        }

        if (lastRow.error) {
          results.push(warn(`Last dream had error: ${lastRow.error}`));
        }

        // Stale dream warning (only if gateway is running)
        if (isGatewayRunning && agoMs > 4 * 60 * 60_000) {
          results.push(warn("Dream engine may be stalled — last cycle was >4 hours ago"));
        }
      }
    } catch (err) {
      results.push(warn(`Could not query last dream cycle: ${String(err)}`));
    }

    // Latest DQS from dream_outcomes
    if (tableExists(db, "dream_outcomes")) {
      try {
        const dqsRow = db
          .prepare(`SELECT dqs FROM dream_outcomes ORDER BY timestamp DESC LIMIT 1`)
          .get() as { dqs: number } | undefined;
        if (dqsRow) {
          results.push(info(`Latest Dream Quality Score (DQS): ${dqsRow.dqs.toFixed(3)}`));
        }
      } catch {
        // table may exist but be empty
      }
    }
  } catch (err) {
    results.push(error(`Dream engine check failed: ${String(err)}`));
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  return results;
}

function checkHormonalSystem(cfg: BitterbotConfig, workspaceDir: string): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  const hormonalEnabled = cfg.memory?.emotional?.hormonal?.enabled !== false;
  if (!hormonalEnabled) {
    results.push(info("Hormonal system is disabled in config"));
    return results;
  }
  results.push(ok("Hormonal system enabled"));

  // Validate GENOME.md homeostasis baselines
  const genomePath = path.join(workspaceDir, "GENOME.md");
  if (fs.existsSync(genomePath)) {
    try {
      const content = fs.readFileSync(genomePath, "utf-8");
      const homeostasis = parseGenomeHomeostasis(content);
      if (homeostasis) {
        const { dopamine, cortisol, oxytocin } = homeostasis;
        const allValid = dopamine !== undefined && cortisol !== undefined && oxytocin !== undefined;
        if (allValid) {
          results.push(ok(`Homeostasis baselines: D=${dopamine} C=${cortisol} O=${oxytocin}`));
        } else {
          results.push(
            warn("Homeostasis baselines incomplete — some hormones missing from GENOME.md"),
          );
        }
      } else {
        results.push(warn("Could not parse homeostasis baselines from GENOME.md"));
      }
    } catch {
      results.push(warn("Could not read GENOME.md for homeostasis check"));
    }
  }

  return results;
}

function checkCuriosityEngine(cfg: BitterbotConfig, dbPath: string): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  const curiosityEnabled = cfg.memory?.curiosity?.enabled !== false;
  if (!curiosityEnabled) {
    results.push(info("Curiosity engine is disabled in config"));
    return results;
  }
  results.push(ok("Curiosity engine enabled"));

  if (!fs.existsSync(dbPath)) {
    results.push(info("Database not found — GCCRF status unavailable"));
    return results;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });

    // Compute maturity from dream cycles + crystal count + age (same logic as GCCRFRewardFunction.getMaturity)
    const expectedMatureCycles =
      cfg.memory?.gccrf?.expectedMatureCycles ?? DEFAULT_GCCRF_CONFIG.expectedMatureCycles;
    const alphaStart = cfg.memory?.gccrf?.alphaStart ?? DEFAULT_GCCRF_CONFIG.alphaStart;
    const alphaEnd = cfg.memory?.gccrf?.alphaEnd ?? DEFAULT_GCCRF_CONFIG.alphaEnd;

    let cycleMat = 0;
    let crystalMat = 0;
    let ageMat = 0;

    if (tableExists(db, "dream_cycles")) {
      try {
        const row = db
          .prepare(`SELECT COUNT(*) as c FROM dream_cycles WHERE completed_at IS NOT NULL`)
          .get() as { c: number };
        cycleMat = row.c / expectedMatureCycles;
      } catch {
        // ignore
      }
    }

    if (tableExists(db, "chunks")) {
      try {
        const countRow = db
          .prepare(
            `SELECT COUNT(*) as c FROM chunks WHERE COALESCE(lifecycle_state, 'active') = 'active'`,
          )
          .get() as { c: number };
        crystalMat = countRow.c / 500;

        const ageRow = db.prepare(`SELECT MIN(created_at) as earliest FROM chunks`).get() as {
          earliest: number | null;
        };
        if (ageRow?.earliest) {
          ageMat = Math.max(0, (Date.now() - ageRow.earliest) / (24 * 60 * 60_000)) / 30;
        }
      } catch {
        // ignore
      }
    }

    const maturity = Math.min(1, Math.max(cycleMat, crystalMat, ageMat));
    const alpha = alphaStart + (alphaEnd - alphaStart) * maturity;

    // Developmental stage
    let stage: string;
    if (maturity < 0.15) {
      stage = "Nascent";
    } else if (maturity < 0.5) {
      stage = "Developing";
    } else if (maturity < 0.85) {
      stage = "Maturing";
    } else {
      stage = "Mature";
    }

    results.push(info(`GCCRF maturity: ${maturity.toFixed(3)} (${stage})`));
    results.push(info(`Current alpha: ${alpha.toFixed(3)} (range: ${alphaStart} to ${alphaEnd})`));

    // Active exploration targets
    if (tableExists(db, "curiosity_targets")) {
      try {
        const targetRow = db
          .prepare(`SELECT COUNT(*) as c FROM curiosity_targets WHERE resolved_at IS NULL`)
          .get() as { c: number };
        results.push(info(`Active exploration targets: ${targetRow.c}`));
      } catch {
        // ignore
      }
    }

    // Knowledge regions
    if (tableExists(db, "curiosity_regions")) {
      try {
        const regionRow = db.prepare(`SELECT COUNT(*) as c FROM curiosity_regions`).get() as {
          c: number;
        };
        results.push(info(`Knowledge regions: ${regionRow.c}`));
      } catch {
        // ignore
      }
    }
  } catch (err) {
    results.push(error(`Curiosity engine check failed: ${String(err)}`));
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  return results;
}

// The previous P2P orchestrator subsection has moved to its own
// top-level doctor section in src/commands/doctor-p2p.ts. Memory
// system checks below no longer reference P2P state — orchestrator
// availability, DNS bootstrap, fallback peer reachability, and live
// peer counts are all reported in the "P2P Network" section now.

// ── Section Renderer ──

function renderSection(title: string, results: DoctorCheckResult[]): void {
  if (results.length === 0) {
    return;
  }
  const lines = results.map(formatLevel);
  note(lines.join("\n"), title);
}

// ── Main Export ──

export async function runMemorySystemChecks(params: {
  config: BitterbotConfig;
  stateDir: string;
  workspaceDir: string;
  dbPath: string;
  isGatewayRunning: boolean;
}): Promise<void> {
  const { config, workspaceDir, dbPath, isGatewayRunning } = params;

  // 1. Workspace Identity Files
  renderSection("Workspace Identity Files", checkWorkspaceIdentityFiles(workspaceDir));

  // 2. GENOME.md Structure
  renderSection("GENOME.md", checkGenomeStructure(workspaceDir));

  // 3. MEMORY.md Schema
  renderSection("Working Memory (MEMORY.md)", checkMemorySchema(workspaceDir));

  // 4. Memory Database
  renderSection("Memory Database", checkMemoryDatabase(dbPath));

  // 5. Dream Engine
  renderSection("Dream Engine", checkDreamEngine(dbPath, isGatewayRunning));

  // 6. Hormonal System
  renderSection("Hormonal System", checkHormonalSystem(config, workspaceDir));

  // 7. Curiosity Engine
  renderSection("Curiosity Engine", checkCuriosityEngine(config, dbPath));

  // (P2P Network is now a top-level doctor section — see doctor-p2p.ts)
}
