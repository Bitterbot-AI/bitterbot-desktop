/**
 * Daily health sweep — the alarm that makes doctor's checks actually fire.
 *
 * WHY THIS EXISTS (2026-08-11): three separate silent failures were found in
 * one session, and in every case the check that would have caught them was
 * ALREADY WRITTEN AND CORRECT — `checkVectorIndexCoverage` warns loudly when
 * `chunks_vec` is missing, mode-liveness warns on never-scheduled dream modes,
 * the artifact-liveness section warns on unconsumed lanes. Nobody had run
 * `bitterbot doctor` recently enough, so vector search stayed dead for weeks
 * and an embedding backlog silently rebuilt to 3,003 crystals. Writing more
 * checks was never the gap; running them was.
 *
 * This runs the READ-ONLY data inspectors on a schedule, persists a snapshot,
 * and diffs against the previous run so a NEW problem announces itself at warn
 * level instead of waiting to be discovered. Deliberately excludes doctor's
 * expensive live probes (model round-trip, agent-turn) — those are for
 * interactive runs; a daily job must be free.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { CheckResult } from "../commands/doctor-check.js";
import type { BitterbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/health-sweep");

export type SweepFinding = {
  /** Stable identity for diffing: section + normalized message shape. */
  key: string;
  section: string;
  level: CheckResult["level"];
  message: string;
};

export type SweepResult = {
  at: number;
  findings: SweepFinding[];
  /** Findings that were not present in the previous sweep. */
  newFindings: SweepFinding[];
  /** Findings present previously that are now gone. */
  resolvedFindings: SweepFinding[];
};

/**
 * Numbers change every run ("3,003 crystals", "8 recalls"), so identity must
 * ignore them — otherwise every sweep reports everything as new. Digits are
 * collapsed before hashing.
 */
export function findingKey(section: string, message: string): string {
  const shape = message.replace(/\d[\d,._]*/g, "#").slice(0, 300);
  return crypto.createHash("sha1").update(`${section}::${shape}`).digest("hex").slice(0, 16);
}

function toFindings(section: string, results: readonly CheckResult[]): SweepFinding[] {
  return results
    .filter((r) => r.level === "warn" || r.level === "error")
    .map((r) => ({
      key: findingKey(section, r.message),
      section,
      level: r.level,
      message: r.message,
    }));
}

/**
 * Run every read-only inspector against an open memory DB. Each is wrapped:
 * one throwing inspector must never abort the sweep, or the sweep becomes the
 * next silent failure.
 */
export async function collectHealthFindings(
  db: DatabaseSync,
  cfg: BitterbotConfig,
): Promise<SweepFinding[]> {
  const findings: SweepFinding[] = [];
  const run = async (section: string, fn: () => CheckResult[] | Promise<CheckResult[]>) => {
    try {
      findings.push(...toFindings(section, await fn()));
    } catch (err) {
      log.debug(`health sweep section ${section} failed: ${String(err)}`);
    }
  };

  const [liveness, subsystems, economy, memorySystem] = await Promise.all([
    import("../commands/doctor-liveness.js"),
    import("../commands/doctor-subsystems.js"),
    import("../commands/doctor-economy.js"),
    import("../commands/doctor-memory-system.js"),
  ]);

  await run("Artifact liveness", () => liveness.inspectArtifactLiveness(db));
  await run("Dream utility", () => liveness.inspectDreamUtility(db));
  await run("Dream mode liveness", () => memorySystem.inspectDreamModeLiveness(db, cfg));
  await run("Economy", () => economy.inspectEconomyLedgers(db, true));
  await run("Subsystems", () =>
    subsystems.inspectSubsystems(db, cfg, "memory").flatMap((s) => s.results),
  );
  return findings;
}

/** Persist a sweep and diff it against the previous one. */
export function recordSweep(
  db: DatabaseSync,
  findings: SweepFinding[],
  now = Date.now(),
): SweepResult {
  let previous: SweepFinding[] = [];
  try {
    const row = db
      .prepare(`SELECT findings_json FROM health_sweeps ORDER BY swept_at DESC LIMIT 1`)
      .get() as { findings_json: string } | undefined;
    if (row?.findings_json) {
      previous = JSON.parse(row.findings_json) as SweepFinding[];
    }
  } catch (err) {
    log.debug(`health sweep history unavailable: ${String(err)}`);
  }

  const prevKeys = new Set(previous.map((f) => f.key));
  const nowKeys = new Set(findings.map((f) => f.key));
  const newFindings = findings.filter((f) => !prevKeys.has(f.key));
  const resolvedFindings = previous.filter((f) => !nowKeys.has(f.key));

  try {
    db.prepare(
      `INSERT INTO health_sweeps (id, swept_at, findings_json, new_count, resolved_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      now,
      JSON.stringify(findings),
      newFindings.length,
      resolvedFindings.length,
    );
    // Keep a bounded history; the diff only ever needs the previous row.
    db.prepare(
      `DELETE FROM health_sweeps WHERE id NOT IN
         (SELECT id FROM health_sweeps ORDER BY swept_at DESC LIMIT 30)`,
    ).run();
  } catch (err) {
    log.debug(`health sweep persist failed: ${String(err)}`);
  }

  return { at: now, findings, newFindings, resolvedFindings };
}

/**
 * Full sweep: collect, persist, diff, and SPEAK UP about anything new. New
 * problems log at warn (that is the entire point of this module); resolutions
 * log at info so a fix is visible too.
 */
export async function runHealthSweep(params: {
  db: DatabaseSync;
  cfg: BitterbotConfig;
  now?: number;
}): Promise<SweepResult> {
  const findings = await collectHealthFindings(params.db, params.cfg);
  const result = recordSweep(params.db, findings, params.now);
  if (result.newFindings.length > 0) {
    for (const f of result.newFindings) {
      log.warn(`health sweep — NEW ${f.level}: [${f.section}] ${f.message}`);
    }
  }
  if (result.resolvedFindings.length > 0) {
    log.info(`health sweep: ${result.resolvedFindings.length} issue(s) resolved since last sweep`);
  }
  log.info(
    `health sweep complete: ${findings.length} open issue(s), ` +
      `${result.newFindings.length} new, ${result.resolvedFindings.length} resolved`,
  );
  return result;
}
