/**
 * PLAN-44 Phase 1 (I3): the heuristic labeler is calibrated against a
 * labeled fixture set built from the STRUCTURAL shapes of real journal runs
 * (tool sequences, error classes, lifecycle outcomes; 842 complete
 * tool-bearing runs, 2026-09-04) with all content replaced by synthetic
 * text. Precision per class must stay >= 0.85; a rule change that trades
 * env-fail for fail (or vice versa) fails here before it reaches the wiki.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReconstructedTrace, TraceLabel } from "./types.js";
import { labelHeuristic } from "./labeler.js";

interface FixtureRow {
  id: string;
  expected: TraceLabel;
  note: string;
  trace: {
    steps: Array<{ name: string; isError: boolean; result: string }>;
    endedWithError: boolean;
    errorText: string | null;
    completedExplicitly: boolean;
    isComplete: boolean;
    task: ReconstructedTrace["task"] | null;
  };
}

const FIXTURE = path.resolve(process.cwd(), "benchmarks/skill-evolution/labeled-traces.jsonl");
export const MIN_PRECISION = 0.85;
export const MIN_RECALL = 0.75;

function loadFixture(): FixtureRow[] {
  return fs
    .readFileSync(FIXTURE, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FixtureRow);
}

function toTrace(row: FixtureRow): ReconstructedTrace {
  const steps = row.trace.steps.map((s) => ({
    kind: "tool" as const,
    name: s.name,
    args: "{}",
    result: s.result,
    isError: s.isError,
  }));
  return {
    runId: row.id,
    taskId: null,
    task: row.trace.task ?? null,
    sessionKey: "agent:main:main",
    startedAt: 1,
    endedAt: 2,
    steps,
    endedWithError: row.trace.endedWithError,
    errorText: row.trace.errorText,
    completedExplicitly: row.trace.completedExplicitly,
    isComplete: row.trace.isComplete,
    toolCallCount: steps.length,
    toolErrorCount: steps.filter((s) => s.isError).length,
    lastSeq: 1,
  };
}

describe("labeler calibration against benchmarks/skill-evolution/labeled-traces.jsonl", () => {
  const rows = loadFixture();

  it("has at least 40 rows covering every class", () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const classes = new Set(rows.map((r) => r.expected));
    expect([...classes].toSorted()).toEqual(["env-fail", "fail", "pass", "unknown"]);
    expect(rows.filter((r) => r.expected === "env-fail").length).toBeGreaterThanOrEqual(10);
  });

  it("meets per-class precision >= 0.85 and recall >= 0.75 (pass / fail / env-fail)", () => {
    const predicted = rows.map((r) => ({ row: r, got: labelHeuristic(toTrace(r)).label }));
    const report: Record<string, { precision: number; recall: number; wrong: string[] }> = {};
    for (const cls of ["pass", "fail", "env-fail"] as const) {
      const tp = predicted.filter((p) => p.got === cls && p.row.expected === cls).length;
      const fp = predicted.filter((p) => p.got === cls && p.row.expected !== cls);
      const fn = predicted.filter((p) => p.got !== cls && p.row.expected === cls);
      const precision = tp + fp.length === 0 ? 1 : tp / (tp + fp.length);
      const recall = tp + fn.length === 0 ? 1 : tp / (tp + fn.length);
      report[cls] = {
        precision,
        recall,
        wrong: [...fp, ...fn].map((p) => `${p.row.id}: expected ${p.row.expected}, got ${p.got}`),
      };
    }
    for (const [cls, r] of Object.entries(report)) {
      expect(r.precision, `${cls} precision; wrong: ${r.wrong.join("; ")}`).toBeGreaterThanOrEqual(
        MIN_PRECISION,
      );
      expect(r.recall, `${cls} recall; wrong: ${r.wrong.join("; ")}`).toBeGreaterThanOrEqual(
        MIN_RECALL,
      );
    }
  });

  it("never labels an env-fail row as an agent fail (the wiki-pollution direction)", () => {
    const leaks = rows
      .filter((r) => r.expected === "env-fail")
      .map((r) => ({ id: r.id, got: labelHeuristic(toTrace(r)).label }))
      .filter((p) => p.got === "fail");
    expect(leaks).toEqual([]);
  });
});
