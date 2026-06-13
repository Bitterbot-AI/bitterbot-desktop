/**
 * PLAN-24 HORMA Phase 2: contrastive partition of an H-vs-H' run.
 *
 * H  = full raw transcript stuffed into the prompt (no memory construction).
 * H' = the real ingest → construct → retrieve → answer memory pipeline.
 *
 * Judging both against the gold answer and diffing the outcomes is HORMA's
 * D_exo / D_end split:
 *   - D_exo (exogenous): H right, H' wrong → memory CONSTRUCTION lost something
 *     the raw history had. This is the signal the architect loop (Phase 3) learns
 *     from.
 *   - D_end (endogenous): H' right, H wrong → structured memory beat raw-history
 *     overload (lost-in-the-middle), evidence the organization helps.
 *
 * Pure functions only — no I/O — so the orchestrating runner stays thin and this
 * is unit-testable.
 */

export type ContrastiveRecord = {
  questionId: string;
  questionType: string;
  /** Full-context baseline judged correct. */
  hRight: boolean;
  /** Memory-pipeline judged correct. */
  hpRight: boolean;
  /** Context tokens fed to the baseline (full transcript). */
  hTokens: number;
  /** Context tokens fed to the memory pipeline (retrieved chunks). */
  hpTokens: number;
  question?: string;
  expected?: string;
  hypH?: string;
  hypHp?: string;
};

export type ContrastiveBucket = "d_exo" | "d_end" | "both_right" | "both_wrong";

export function bucketOf(r: { hRight: boolean; hpRight: boolean }): ContrastiveBucket {
  if (r.hRight && !r.hpRight) {
    return "d_exo";
  }
  if (!r.hRight && r.hpRight) {
    return "d_end";
  }
  if (r.hRight && r.hpRight) {
    return "both_right";
  }
  return "both_wrong";
}

export type TypeBreakdown = {
  n: number;
  hAcc: number;
  hpAcc: number;
  dExo: number;
  dEnd: number;
};

export type ContrastiveSummary = {
  n: number;
  hAccuracy: number;
  hpAccuracy: number;
  buckets: Record<ContrastiveBucket, number>;
  byType: Record<string, TypeBreakdown>;
  tokens: { hMean: number; hpMean: number; hpFractionOfH: number };
};

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function summarize(records: ContrastiveRecord[]): ContrastiveSummary {
  const n = records.length;
  const buckets: Record<ContrastiveBucket, number> = {
    d_exo: 0,
    d_end: 0,
    both_right: 0,
    both_wrong: 0,
  };
  const byType: Record<string, TypeBreakdown & { _hRight: number; _hpRight: number }> = {};

  for (const r of records) {
    buckets[bucketOf(r)]++;
    const t = (byType[r.questionType] ??= {
      n: 0,
      hAcc: 0,
      hpAcc: 0,
      dExo: 0,
      dEnd: 0,
      _hRight: 0,
      _hpRight: 0,
    });
    t.n++;
    if (r.hRight) {
      t._hRight++;
    }
    if (r.hpRight) {
      t._hpRight++;
    }
    const b = bucketOf(r);
    if (b === "d_exo") {
      t.dExo++;
    } else if (b === "d_end") {
      t.dEnd++;
    }
  }

  const byTypeOut: Record<string, TypeBreakdown> = {};
  for (const [type, t] of Object.entries(byType)) {
    byTypeOut[type] = {
      n: t.n,
      hAcc: t.n === 0 ? 0 : t._hRight / t.n,
      hpAcc: t.n === 0 ? 0 : t._hpRight / t.n,
      dExo: t.dExo,
      dEnd: t.dEnd,
    };
  }

  const hMean = mean(records.map((r) => r.hTokens));
  const hpMean = mean(records.map((r) => r.hpTokens));

  return {
    n,
    hAccuracy: n === 0 ? 0 : records.filter((r) => r.hRight).length / n,
    hpAccuracy: n === 0 ? 0 : records.filter((r) => r.hpRight).length / n,
    buckets,
    byType: byTypeOut,
    tokens: { hMean, hpMean, hpFractionOfH: hMean === 0 ? 0 : hpMean / hMean },
  };
}

/**
 * HORMA D.6-style construction_feedback record, emitted for every D_exo case so
 * Phase 3's textual-gradient architect loop has a corpus to learn from.
 */
export type ConstructionFeedback = {
  task_id: string;
  task_category: string;
  comparison_type: "exogenous";
  winning_method: "baseline_full_raw_history";
  losing_method: "ours_memory_pipeline";
  question: string;
  expected: string;
  baseline_answer: string;
  memory_answer: string;
  root_cause_summary: string;
};

export function constructionFeedback(records: ContrastiveRecord[]): ConstructionFeedback[] {
  return records
    .filter((r) => bucketOf(r) === "d_exo")
    .map((r) => ({
      task_id: r.questionId,
      task_category: r.questionType,
      comparison_type: "exogenous" as const,
      winning_method: "baseline_full_raw_history" as const,
      losing_method: "ours_memory_pipeline" as const,
      question: r.question ?? "",
      expected: r.expected ?? "",
      baseline_answer: r.hypH ?? "",
      memory_answer: r.hypHp ?? "",
      root_cause_summary:
        "Full raw history answered correctly but the memory pipeline did not: the fact was lost or distorted during construction/retrieval. Candidate construction-rule fix: preserve this fact class more faithfully during extraction.",
    }));
}
