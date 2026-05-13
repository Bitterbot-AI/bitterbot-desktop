/**
 * Heuristic-first lifecycle transitions for the procedural-memory curator.
 *
 * This module contains pure functions that classify each
 * agent-authored skill into one of:
 *
 *   - `noop`            — leave the row untouched.
 *   - `transition`      — confident enough to write directly (active→stale,
 *                         stale→archived, archived→active reactivation).
 *   - `flag-for-llm`    — heuristic disagreement / borderline; defer the
 *                         decision to the LLM-judge pass (Phase 1c).
 *
 * The A-MAC-style hybrid pattern (arXiv 2603.04549) gates LLM-judge calls on
 * cheap heuristics so the expensive model only sees borderlines. The default
 * thresholds below were chosen to be conservative — better to flag for review
 * than auto-archive prematurely.
 *
 * Pure functions: no I/O, no clock reads, no random sources. The caller
 * supplies `now` and any threshold overrides. This keeps unit tests
 * deterministic and lets the upcoming dream-mode driver freeze time during
 * dry-run reports.
 */

import type { SkillLifecycleRow } from "./skill-lifecycle.js";

export interface CuratorThresholds {
  /** Mark active skills as stale after this many days of zero usage. */
  staleAfterUnusedDays: number;
  /** Mark active skills as stale after this many days since last use. */
  staleAfterLastUsedDays: number;
  /** Archive stale skills after this many days since last use. */
  archiveAfterLastUsedDays: number;
  /**
   * Reactivate an archived skill to 'active' if it was used within this many
   * days. Defends against the consolidation pass clobbering recently-revived
   * skills.
   */
  reactivateIfUsedWithinDays: number;
  /**
   * Skills with executions below this floor are not eligible for error-rate
   * flagging. Avoids penalising a one-shot failure.
   */
  errorRateMinExecutions: number;
  /**
   * Error rate threshold (errors / usage_count) that flags a skill for LLM
   * review. Heuristic alone never archives high-error skills — only the LLM
   * judge can decide whether the errors are systemic or transient.
   */
  errorRateFlagThreshold: number;
  /** A skill with no recorded usage that is younger than this stays 'active'. */
  freshSkillGraceDays: number;
}

export const DEFAULT_THRESHOLDS: CuratorThresholds = {
  staleAfterUnusedDays: 14,
  staleAfterLastUsedDays: 60,
  archiveAfterLastUsedDays: 120,
  reactivateIfUsedWithinDays: 7,
  errorRateMinExecutions: 5,
  errorRateFlagThreshold: 0.5,
  freshSkillGraceDays: 3,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type TransitionKind = "noop" | "stale" | "archived" | "reactivate" | "flag-for-llm";

export interface TransitionProposal {
  skillName: string;
  fromState: SkillLifecycleRow["state"];
  toState: SkillLifecycleRow["state"] | null;
  kind: TransitionKind;
  reason: string;
}

/**
 * Classify a single lifecycle row. Returns a `noop` proposal when the row
 * does not warrant any change. Pinned and non-agent-authored skills are
 * always noop here — the caller is responsible for not feeding them in.
 */
export function classifyTransition(
  row: SkillLifecycleRow,
  now: number,
  thresholds: CuratorThresholds = DEFAULT_THRESHOLDS,
): TransitionProposal {
  // Defensive: the caller should pre-filter, but no harm in double-checking.
  if (row.pinned || row.origin !== "agent_authored") {
    return {
      skillName: row.skillName,
      fromState: row.state,
      toState: null,
      kind: "noop",
      reason: row.pinned ? "skill is pinned" : `origin=${row.origin} is not curator-eligible`,
    };
  }

  const ageMs = now - row.createdAt;
  const idleMs = row.lastUsedAt == null ? Infinity : now - row.lastUsedAt;
  const errorRate = row.usageCount > 0 ? row.errorCount / row.usageCount : 0;
  const ageDays = ageMs / DAY_MS;
  const idleDays = idleMs / DAY_MS;

  // Reactivation: an archived skill that has been used within the grace
  // window flips back to active. Lets manually-restored skills out of the
  // archive without operator intervention.
  if (
    row.state === "archived" &&
    idleMs !== Infinity &&
    idleDays <= thresholds.reactivateIfUsedWithinDays
  ) {
    return {
      skillName: row.skillName,
      fromState: row.state,
      toState: "active",
      kind: "reactivate",
      reason: `used within ${idleDays.toFixed(1)}d of an archived state (grace ${thresholds.reactivateIfUsedWithinDays}d)`,
    };
  }

  // Archived rows beyond reactivation grace stay archived.
  if (row.state === "archived") {
    return {
      skillName: row.skillName,
      fromState: row.state,
      toState: null,
      kind: "noop",
      reason: "already archived",
    };
  }

  // Stale → Archived after a long idle period.
  if (row.state === "stale" && idleDays >= thresholds.archiveAfterLastUsedDays) {
    return {
      skillName: row.skillName,
      fromState: row.state,
      toState: "archived",
      kind: "archived",
      reason: `stale and idle ${idleDays.toFixed(1)}d ≥ ${thresholds.archiveAfterLastUsedDays}d`,
    };
  }

  // Active → Stale by either of two paths (zero-usage age, or long idle).
  // The unused-age branch is gated by the fresh-skill grace window so we
  // don't auto-stale brand-new skills that haven't had a chance to run; the
  // idle-since-last-use branch is naturally bounded by recency.
  if (row.state === "active") {
    if (
      row.usageCount === 0 &&
      ageDays >= thresholds.staleAfterUnusedDays &&
      ageDays >= thresholds.freshSkillGraceDays
    ) {
      return {
        skillName: row.skillName,
        fromState: row.state,
        toState: "stale",
        kind: "stale",
        reason: `unused for ${ageDays.toFixed(1)}d ≥ ${thresholds.staleAfterUnusedDays}d`,
      };
    }
    if (row.lastUsedAt != null && idleDays >= thresholds.staleAfterLastUsedDays) {
      return {
        skillName: row.skillName,
        fromState: row.state,
        toState: "stale",
        kind: "stale",
        reason: `idle for ${idleDays.toFixed(1)}d ≥ ${thresholds.staleAfterLastUsedDays}d since last use`,
      };
    }
  }

  // Error-rate flag: cross-cuts every state and bypasses the fresh-skill
  // grace. Surfaces high-failure skills to the LLM judge regardless of
  // recency. Heuristic does NOT auto-archive — only the judge decides
  // whether the failures are systemic.
  if (
    row.usageCount >= thresholds.errorRateMinExecutions &&
    errorRate >= thresholds.errorRateFlagThreshold
  ) {
    return {
      skillName: row.skillName,
      fromState: row.state,
      toState: null,
      kind: "flag-for-llm",
      reason: `error rate ${(errorRate * 100).toFixed(0)}% over ${row.usageCount} runs ≥ ${(thresholds.errorRateFlagThreshold * 100).toFixed(0)}% flag floor`,
    };
  }

  // No transition needed, including the implicit fresh-skill grace fallthrough.
  if (row.state === "active" && ageDays < thresholds.freshSkillGraceDays) {
    return {
      skillName: row.skillName,
      fromState: row.state,
      toState: null,
      kind: "noop",
      reason: `within fresh-skill grace (${ageDays.toFixed(1)}d < ${thresholds.freshSkillGraceDays}d)`,
    };
  }

  return {
    skillName: row.skillName,
    fromState: row.state,
    toState: null,
    kind: "noop",
    reason: "no transition needed",
  };
}

export interface HeuristicPassReport {
  generatedAt: number;
  totalCandidates: number;
  proposals: TransitionProposal[];
  /** Subset of proposals with `kind === 'flag-for-llm'`. */
  borderlineCandidates: TransitionProposal[];
  /** Subset that produced an actionable state change. */
  transitions: TransitionProposal[];
  /** Subset that did nothing. */
  noops: TransitionProposal[];
  /** Names of pinned skills found while scanning. */
  pinnedSkipped: string[];
  /** True when the pass was simulated (no DB writes). */
  dryRun: boolean;
  /** True when this report came from real DB writes; false on dry-run. */
  appliedWrites: boolean;
}

/**
 * Run the heuristic pass over an iterable of candidate rows. Pure: no DB
 * access, no clock reads. The caller decides whether to apply the resulting
 * transitions.
 */
export function runHeuristicPass(params: {
  candidates: Iterable<SkillLifecycleRow>;
  pinned?: Iterable<SkillLifecycleRow>;
  now: number;
  thresholds?: CuratorThresholds;
  dryRun?: boolean;
  appliedWrites?: boolean;
}): HeuristicPassReport {
  const thresholds = params.thresholds ?? DEFAULT_THRESHOLDS;
  const proposals: TransitionProposal[] = [];
  const borderlines: TransitionProposal[] = [];
  const transitions: TransitionProposal[] = [];
  const noops: TransitionProposal[] = [];

  for (const row of params.candidates) {
    const proposal = classifyTransition(row, params.now, thresholds);
    proposals.push(proposal);
    if (proposal.kind === "flag-for-llm") {
      borderlines.push(proposal);
    } else if (proposal.toState != null) {
      transitions.push(proposal);
    } else {
      noops.push(proposal);
    }
  }

  const pinnedSkipped: string[] = [];
  if (params.pinned) {
    for (const row of params.pinned) {
      pinnedSkipped.push(row.skillName);
    }
  }

  return {
    generatedAt: params.now,
    totalCandidates: proposals.length,
    proposals,
    borderlineCandidates: borderlines,
    transitions,
    noops,
    pinnedSkipped,
    dryRun: params.dryRun ?? false,
    appliedWrites: params.appliedWrites ?? false,
  };
}

/**
 * Render the report as a human-readable markdown document. Used for the
 * REPORT.md emitted under ~/.bitterbot/curator-reports/<ts>/.
 */
export function formatReportMarkdown(report: HeuristicPassReport): string {
  const ts = new Date(report.generatedAt).toISOString();
  const lines: string[] = [];
  lines.push(`# Skill Curator Report — ${ts}`, "");
  lines.push(
    `**Mode:** ${report.dryRun ? "dry-run (no writes)" : report.appliedWrites ? "live (writes applied)" : "preview (writes pending)"}`,
    `**Candidates scanned:** ${report.totalCandidates}`,
    `**Transitions proposed:** ${report.transitions.length}`,
    `**Borderlines flagged for LLM:** ${report.borderlineCandidates.length}`,
    `**Pinned skipped:** ${report.pinnedSkipped.length}`,
    "",
  );

  if (report.transitions.length > 0) {
    lines.push("## Transitions", "");
    for (const t of report.transitions) {
      lines.push(`- \`${t.skillName}\` ${t.fromState} → ${t.toState ?? "?"} — ${t.reason}`);
    }
    lines.push("");
  }

  if (report.borderlineCandidates.length > 0) {
    lines.push("## Borderline (LLM-judge required)", "");
    for (const b of report.borderlineCandidates) {
      lines.push(`- \`${b.skillName}\` (currently \`${b.fromState}\`) — ${b.reason}`);
    }
    lines.push("");
  }

  if (report.pinnedSkipped.length > 0) {
    lines.push("## Pinned (skipped)", "");
    for (const name of report.pinnedSkipped) {
      lines.push(`- \`${name}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}
