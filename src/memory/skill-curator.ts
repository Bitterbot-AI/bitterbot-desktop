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
import {
  applyPatchDecision,
  type JudgeDecision,
  judgeBorderline,
  type JudgeSkillResult,
  type LlmCall,
  parseSkillMarkdown,
  readSkillMarkdownFromRoots,
} from "./skill-curator-judge.js";
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

export interface JudgeOutcome {
  skillName: string;
  decision: JudgeDecision | null;
  applied: boolean;
  notes: string;
  rawOnFailure?: string;
}

export interface FullCuratorPassResult {
  heuristicReport: HeuristicPassReport;
  judgeOutcomes: JudgeOutcome[];
  reportPath: string | null;
}

export interface FullCuratorPassOptions extends CuratorPassOptions {
  /**
   * LLM call used for the borderline judge pass. When omitted, the judge
   * step is skipped entirely (heuristic-only pass, same as
   * runHeuristicCuratorPass).
   */
  llmCall?: LlmCall;
  /**
   * Roots to search for SKILL.md content. Defaults to `[CONFIG_DIR/skills]`
   * — the managed skill root. Workspace skills are not included in the
   * default search because the curator only operates on `agent_authored`
   * provenance, which today lives in the managed root.
   */
  skillRoots?: ReadonlyArray<string>;
  /**
   * Cap on the number of borderlines the judge inspects per pass. Defaults
   * to 10 to keep token cost bounded. Borderlines beyond the cap remain
   * flagged in the next pass.
   */
  maxJudgeCalls?: number;
}

const DEFAULT_MAX_JUDGE_CALLS = 10;

function appendJudgeReportSection(report: HeuristicPassReport, outcomes: JudgeOutcome[]): string {
  const md = formatReportMarkdown(report);
  if (outcomes.length === 0) {
    return md;
  }
  const lines: string[] = [md.trimEnd(), "", "## LLM-judge decisions", ""];
  for (const o of outcomes) {
    if (o.decision == null) {
      lines.push(`- \`${o.skillName}\` — **parse failure** (${o.notes})`);
      if (o.rawOnFailure) {
        lines.push("", "  ```text", `  ${o.rawOnFailure.replace(/\n/g, "\n  ")}`, "  ```", "");
      }
      continue;
    }
    const decision = o.decision;
    const status = o.applied ? "applied" : "noted";
    if (decision.action === "consolidate") {
      lines.push(
        `- \`${o.skillName}\` → **consolidate** into \`${decision.into}\` (${status}) — ${decision.reason}`,
      );
    } else if (decision.action === "patch") {
      lines.push(`- \`${o.skillName}\` → **patch description** (${status}) — ${decision.reason}`);
    } else if (decision.action === "archive") {
      lines.push(`- \`${o.skillName}\` → **archive** (${status}) — ${decision.reason}`);
    } else {
      lines.push(`- \`${o.skillName}\` → **keep** (${status}) — ${decision.reason}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Run the heuristic pass and (when an llmCall is supplied) the LLM-judge
 * borderline pass. Each judge decision is mapped to a SkillLifecycleStore
 * mutation or, for `patch` decisions, a SKILL.md rewrite via the
 * applyPatchDecision helper.
 *
 * Dry-run skips every mutation (heuristic transitions AND judge decisions)
 * but still calls the LLM to produce the previewed report.
 */
export async function runFullCuratorPass(
  store: SkillLifecycleStore,
  options: FullCuratorPassOptions = {},
): Promise<FullCuratorPassResult> {
  const now = options.now ?? Date.now();
  const heuristic = await runHeuristicCuratorPass(store, {
    ...options,
    // Suppress the heuristic-only report write — we want one unified report
    // at the end that includes judge outcomes.
    writeReport: false,
    now,
  });

  const outcomes: JudgeOutcome[] = [];

  if (options.llmCall && heuristic.report.borderlineCandidates.length > 0) {
    const skillRoots = options.skillRoots ?? [path.join(CONFIG_DIR, "skills")];
    const cap = options.maxJudgeCalls ?? DEFAULT_MAX_JUDGE_CALLS;
    const borderlines = heuristic.report.borderlineCandidates.slice(0, cap);

    // Build a peer list ONCE per pass — active agent_authored skills minus
    // the borderline itself. Keeps prompt budget predictable.
    const peerCandidates = store.listByState("active");
    const peerLookups = await Promise.all(
      peerCandidates.map(async (peer) => {
        const file = await readSkillMarkdownFromRoots({
          skillName: peer.skillName,
          roots: skillRoots,
        });
        const parsed = file ? parseSkillMarkdown(file.content) : null;
        const description =
          parsed && typeof parsed.frontmatter.description === "string"
            ? parsed.frontmatter.description
            : "";
        return { name: peer.skillName, description };
      }),
    );
    const allPeers = peerLookups.filter((p) => p.description);

    for (const borderline of borderlines) {
      const lifecycle = store.get(borderline.skillName);
      if (!lifecycle) {
        outcomes.push({
          skillName: borderline.skillName,
          decision: null,
          applied: false,
          notes: "lifecycle row vanished mid-pass",
        });
        continue;
      }
      const file = await readSkillMarkdownFromRoots({
        skillName: borderline.skillName,
        roots: skillRoots,
      });
      if (!file) {
        outcomes.push({
          skillName: borderline.skillName,
          decision: null,
          applied: false,
          notes: "SKILL.md not found in configured roots",
        });
        continue;
      }
      const judged: JudgeSkillResult = await judgeBorderline(
        {
          borderline,
          lifecycle,
          skillMarkdown: file.content,
          peerSkills: allPeers.filter((p) => p.name !== borderline.skillName),
        },
        options.llmCall,
      );
      if (!judged.decision) {
        outcomes.push({
          skillName: borderline.skillName,
          decision: null,
          applied: false,
          notes: "judge returned unparseable response",
          ...(judged.rawOnFailure ? { rawOnFailure: judged.rawOnFailure } : {}),
        });
        continue;
      }
      const outcome = await applyJudgeDecision({
        skillName: borderline.skillName,
        decision: judged.decision,
        filePath: file.filePath,
        store,
        dryRun: options.dryRun === true,
      });
      outcomes.push(outcome);
    }
  }

  const shouldWrite = options.writeReport ?? !options.dryRun;
  let reportPath: string | null = null;
  if (shouldWrite) {
    const reportsRoot = options.reportsDir ?? path.join(CONFIG_DIR, REPORTS_SUBDIR);
    try {
      reportPath = await writeUnifiedReport({
        reportsRoot,
        now,
        report: heuristic.report,
        outcomes,
      });
    } catch (err) {
      log.warn(`failed to write full curator report: ${String(err)}`);
    }
  }

  return {
    heuristicReport: heuristic.report,
    judgeOutcomes: outcomes,
    reportPath,
  };
}

async function applyJudgeDecision(params: {
  skillName: string;
  decision: JudgeDecision;
  filePath: string;
  store: SkillLifecycleStore;
  dryRun: boolean;
}): Promise<JudgeOutcome> {
  const { skillName, decision, filePath, store, dryRun } = params;
  if (dryRun) {
    return {
      skillName,
      decision,
      applied: false,
      notes: "dry-run; decision not applied",
    };
  }
  if (decision.action === "keep") {
    return { skillName, decision, applied: true, notes: "no mutation needed" };
  }
  if (decision.action === "archive") {
    store.setState(skillName, "archived");
    return { skillName, decision, applied: true, notes: "lifecycle state set to archived" };
  }
  if (decision.action === "consolidate") {
    const target = store.get(decision.into);
    if (!target) {
      return {
        skillName,
        decision,
        applied: false,
        notes: `consolidation target "${decision.into}" not found in lifecycle store`,
      };
    }
    store.consolidateInto(skillName, decision.into);
    return {
      skillName,
      decision,
      applied: true,
      notes: `archived in favour of ${decision.into}`,
    };
  }
  // patch
  const ok = await applyPatchDecision({
    filePath,
    newDescription: decision.newDescription,
  });
  return {
    skillName,
    decision,
    applied: ok,
    notes: ok ? "frontmatter description rewritten" : "patch write failed",
  };
}

async function writeUnifiedReport(params: {
  reportsRoot: string;
  now: number;
  report: HeuristicPassReport;
  outcomes: JudgeOutcome[];
}): Promise<string> {
  const dir = path.join(params.reportsRoot, reportDirNameFor(params.now));
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, "REPORT.md");
  const tmpPath = `${fullPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, appendJudgeReportSection(params.report, params.outcomes), "utf-8");
  await fs.rename(tmpPath, fullPath);
  return fullPath;
}
