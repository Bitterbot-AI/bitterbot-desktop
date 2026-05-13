/**
 * Behavioural gate for staged skill mutations.
 *
 * Phase 2b of PLAN-15. Every staged SKILL.md goes through this gate before
 * Phase 2c's publish RPC is allowed to promote it to live. The gate is
 * deliberately layered:
 *
 *   1. Schema gate — YAML frontmatter parses; required fields present.
 *   2. Injection gate — re-run scanSkillForInjection on the staged content;
 *      "critical" severity blocks publish, "medium" / "low" surface as
 *      warnings without blocking (the agent might be writing about
 *      adversarial content legitimately).
 *   3. Regression gate — if a live version exists with high empirical
 *      success rate, refuse silent gutting (massive diff vs current live)
 *      unless the caller explicitly passed `acceptHighRiskDiff=true`.
 *
 * Note we deliberately do NOT execute the skill here. Skill "execution" is
 * the LLM choosing to follow its prompt, which is unobservable from disk.
 * The closest available signal is empirical: did the previous version run
 * well? If yes, raise the bar for replacement.
 */

import type { SkillLifecycleStore } from "../../memory/skill-lifecycle.js";
import { parseSkillMarkdown } from "../../memory/skill-curator-judge.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";

export type GateOutcome = "pass" | "warn" | "fail";

export interface GateIssue {
  kind:
    | "missing-frontmatter"
    | "missing-field"
    | "injection-critical"
    | "injection-suspect"
    | "regression-risk"
    | "empty-body";
  detail: string;
  severity: "info" | "warn" | "block";
}

export interface GateResult {
  outcome: GateOutcome;
  issues: GateIssue[];
  /** Empirical success rate of the previous live version (0..1). */
  baselineSuccessRate: number;
  /** Empirical run count behind that success rate. */
  baselineRuns: number;
}

export interface GateInput {
  skillName: string;
  stagedContent: string;
  /** Optional current live content, used for the regression check. */
  liveContent?: string | null;
  /** Lifecycle store, for baseline metrics. */
  lifecycleStore?: SkillLifecycleStore;
  /** When true, accept staged content even on regression-risk warnings. */
  acceptHighRiskDiff?: boolean;
}

const REQUIRED_FRONTMATTER_FIELDS = ["name", "description"] as const;

const REGRESSION_BASELINE_RUNS = 5;
const REGRESSION_BASELINE_SUCCESS = 0.8;
const REGRESSION_DIFF_THRESHOLD = 0.5;

/**
 * Crude line-overlap ratio. 1.0 == identical, 0.0 == disjoint. We use this
 * to detect "the agent rewrote everything" situations.
 */
export function approxOverlapRatio(a: string, b: string): number {
  const linesA = new Set(
    a
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const linesB = new Set(
    b
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  if (linesA.size === 0 && linesB.size === 0) {
    return 1;
  }
  if (linesA.size === 0 || linesB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const l of linesA) {
    if (linesB.has(l)) {
      intersection++;
    }
  }
  return intersection / Math.max(linesA.size, linesB.size);
}

/**
 * Run the staged-content gate. Pure of side effects — the caller decides
 * what to do with the result (typically: updateStagingGateStatus).
 */
export function runSkillGate(input: GateInput): GateResult {
  const issues: GateIssue[] = [];
  let outcome: GateOutcome = "pass";

  // 1. Schema gate.
  const parsed = parseSkillMarkdown(input.stagedContent);
  if (!parsed) {
    issues.push({
      kind: "missing-frontmatter",
      detail: "staged SKILL.md does not have valid YAML frontmatter",
      severity: "block",
    });
    return {
      outcome: "fail",
      issues,
      baselineSuccessRate: 0,
      baselineRuns: 0,
    };
  }
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    const value = parsed.frontmatter[field];
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({
        kind: "missing-field",
        detail: `frontmatter is missing required field "${field}"`,
        severity: "block",
      });
      outcome = "fail";
    }
  }
  if (!parsed.body || parsed.body.trim().length === 0) {
    issues.push({
      kind: "empty-body",
      detail: "skill body is empty; nothing for the agent to follow",
      severity: "block",
    });
    outcome = "fail";
  }
  if (outcome === "fail") {
    return {
      outcome,
      issues,
      baselineSuccessRate: 0,
      baselineRuns: 0,
    };
  }

  // 2. Injection gate.
  const scan = scanSkillForInjection(input.stagedContent);
  if (scan.severity === "critical") {
    issues.push({
      kind: "injection-critical",
      detail: `injection scan severity=critical: ${scan.reason}`,
      severity: "block",
    });
    return {
      outcome: "fail",
      issues,
      baselineSuccessRate: 0,
      baselineRuns: 0,
    };
  }
  if (scan.severity !== "ok") {
    issues.push({
      kind: "injection-suspect",
      detail: `injection scan severity=${scan.severity}: ${scan.reason}`,
      severity: "warn",
    });
    outcome = "warn";
  }

  // 3. Regression gate.
  let baselineSuccessRate = 0;
  let baselineRuns = 0;
  if (input.lifecycleStore) {
    const row = input.lifecycleStore.get(input.skillName);
    if (row && row.usageCount > 0) {
      baselineRuns = row.usageCount;
      baselineSuccessRate = row.successCount / row.usageCount;
    }
  }
  if (
    input.liveContent &&
    baselineRuns >= REGRESSION_BASELINE_RUNS &&
    baselineSuccessRate >= REGRESSION_BASELINE_SUCCESS
  ) {
    const overlap = approxOverlapRatio(input.liveContent, input.stagedContent);
    if (overlap < REGRESSION_DIFF_THRESHOLD) {
      const detail = `staged content shares only ${(overlap * 100).toFixed(0)}% of live lines while live has ${(baselineSuccessRate * 100).toFixed(0)}% success over ${baselineRuns} runs`;
      if (input.acceptHighRiskDiff) {
        issues.push({
          kind: "regression-risk",
          detail: `${detail} (override accepted)`,
          severity: "warn",
        });
        if (outcome === "pass") {
          outcome = "warn";
        }
      } else {
        issues.push({
          kind: "regression-risk",
          detail,
          severity: "block",
        });
        return {
          outcome: "fail",
          issues,
          baselineSuccessRate,
          baselineRuns,
        };
      }
    }
  }

  return { outcome, issues, baselineSuccessRate, baselineRuns };
}

/** Pretty-print gate issues for tool responses. */
export function formatGateSummary(result: GateResult): string {
  const parts: string[] = [`gate: ${result.outcome}`];
  for (const issue of result.issues) {
    parts.push(`  - [${issue.severity}] ${issue.kind}: ${issue.detail}`);
  }
  if (result.baselineRuns > 0) {
    parts.push(
      `  baseline: ${(result.baselineSuccessRate * 100).toFixed(0)}% over ${result.baselineRuns} runs`,
    );
  }
  return parts.join("\n");
}
