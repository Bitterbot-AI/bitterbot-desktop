/**
 * Procedural-memory curator driver.
 *
 * Reads candidate lifecycle rows from the SkillLifecycleStore, runs the
 * heuristic classifier (see skill-curator-heuristics.ts), optionally applies
 * the proposed transitions, and writes a REPORT.md to a timestamped directory
 * under CONFIG_DIR/curator-reports.
 *
 * The dream-engine integration (Phase 1c) will call `runHeuristicCuratorPass`
 * inside a new dream mode. Outside that path, the same entry point is safe to
 * use from a CLI flag for operator-driven dry-runs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import {
  type CuratorThresholds,
  DEFAULT_THRESHOLDS,
  formatReportMarkdown,
  type HeuristicPassReport,
  runHeuristicPass,
} from "./skill-curator-heuristics.js";
import { SkillLifecycleStore } from "./skill-lifecycle.js";

const log = createSubsystemLogger("memory/skill-curator");

const REPORTS_SUBDIR = "curator-reports";

export interface CuratorPassOptions {
  /** Wall-clock for the pass. Pass a fixed time in tests for determinism. */
  now?: number;
  /** Override the default A-MAC-style thresholds. */
  thresholds?: CuratorThresholds;
  /**
   * When true, skip the SkillLifecycleStore mutations and only produce a
   * report. Use for the operator-facing preview before a live consolidation.
   */
  dryRun?: boolean;
  /**
   * When true, write the report to disk under
   * `CONFIG_DIR/curator-reports/<ts>/REPORT.md`. Defaults to true for live
   * passes and to the caller's discretion for dry-runs.
   */
  writeReport?: boolean;
  /** Override the report root directory (testing only). */
  reportsDir?: string;
}

export interface CuratorPassResult {
  report: HeuristicPassReport;
  /** Where the report was written, or null when writeReport was false. */
  reportPath: string | null;
}

/**
 * Produce a timestamped report-directory name. Replaces characters that are
 * filesystem-fragile on Windows (`:`) with hyphens.
 */
function reportDirNameFor(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

async function writeReportFile(params: {
  reportsRoot: string;
  now: number;
  report: HeuristicPassReport;
}): Promise<string> {
  const dir = path.join(params.reportsRoot, reportDirNameFor(params.now));
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, "REPORT.md");
  const tmpPath = `${fullPath}.tmp-${process.pid}`;
  // Atomic write: temp + rename, so partial writes never leave a half-baked
  // REPORT.md visible to operators.
  await fs.writeFile(tmpPath, formatReportMarkdown(params.report), "utf-8");
  await fs.rename(tmpPath, fullPath);
  return fullPath;
}

/**
 * Apply the heuristic transitions to the store. Returns the number of rows
 * mutated (transitions only — borderlines and noops are not applied).
 */
function applyTransitions(store: SkillLifecycleStore, report: HeuristicPassReport): number {
  let applied = 0;
  for (const proposal of report.transitions) {
    if (!proposal.toState) {
      continue;
    }
    if (proposal.toState === "pinned") {
      // Should never happen — heuristics never propose 'pinned'.
      continue;
    }
    store.setState(proposal.skillName, proposal.toState);
    applied++;
  }
  return applied;
}

/**
 * Run a heuristic-only curator pass. The LLM-judge borderline pass is added
 * by Phase 1c; this function is its prerequisite and is also the entry point
 * for dry-run operator previews.
 */
export async function runHeuristicCuratorPass(
  store: SkillLifecycleStore,
  options: CuratorPassOptions = {},
): Promise<CuratorPassResult> {
  const now = options.now ?? Date.now();
  const candidates = store.listCuratorCandidates();
  const pinned = store.listByState("pinned");

  // Heuristic classification — pure function, no I/O.
  const draftReport = runHeuristicPass({
    candidates,
    pinned,
    now,
    thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    dryRun: options.dryRun ?? false,
    appliedWrites: false,
  });

  let appliedWrites = false;
  let appliedCount = 0;
  if (!options.dryRun && draftReport.transitions.length > 0) {
    appliedCount = applyTransitions(store, draftReport);
    appliedWrites = appliedCount > 0;
  }

  const report: HeuristicPassReport = {
    ...draftReport,
    appliedWrites,
  };

  const shouldWrite = options.writeReport ?? !options.dryRun;
  let reportPath: string | null = null;
  if (shouldWrite) {
    const reportsRoot = options.reportsDir ?? path.join(CONFIG_DIR, REPORTS_SUBDIR);
    try {
      reportPath = await writeReportFile({ reportsRoot, now, report });
    } catch (err) {
      log.warn(`failed to write curator report: ${String(err)}`);
    }
  }

  log.debug(
    `curator pass complete: ${report.totalCandidates} candidates, ` +
      `${report.transitions.length} transitions ` +
      `(${appliedCount} applied, dryRun=${options.dryRun ?? false}), ` +
      `${report.borderlineCandidates.length} borderlines`,
  );

  return { report, reportPath };
}
