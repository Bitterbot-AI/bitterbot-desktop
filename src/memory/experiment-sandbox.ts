/**
 * ExperimentSandbox: paired LLM judge for harness-evolve (PLAN-25).
 *
 * PLAN-45 Phase 1 retired the PLAN-21 skill-mutation validation gate that
 * this module used to implement (faithfulness gate, cold-start legacy
 * scenario path, `evaluate()`, `MutationVerdict`). What remains exists ONLY
 * for harness-evolve's policy comparison: `scoreVersionPair` asks one LLM
 * judge to predict, for each held-out past execution context, whether
 * version A and version B of a text would each have produced a successful
 * outcome, and `bootstrapPairedCI` turns those paired predictions into a
 * bootstrap CI on the per-trial delta.
 *
 * Its "trials" are LLM-predicted pass/fail over past execution contexts,
 * not re-executions. This module must never gate a skill: it compares two
 * harness policies against a fixed, reproducible trace set and nothing else.
 */

import type { DatabaseSync } from "node:sqlite";
import type { HeldOutExecution } from "./skill-execution-selection.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/experiment-sandbox");

/** Number of bootstrap resamples for the paired CI. Trades stability vs cost. */
const BOOTSTRAP_ITERATIONS = 2000;

/** Maximum chars per context_json blob in the judge prompt. */
const MAX_CONTEXT_CHARS = 400;

export interface StatisticalResult {
  /** Mean per-trial delta (`bPass` − `aPass`), in [-1, 1]. */
  delta: number;
  /** Lower bound of the 95% CI on the per-trial delta. */
  ci95Low: number;
  /** Upper bound of the 95% CI on the per-trial delta. */
  ci95High: number;
  /** Number of paired trials feeding the bootstrap. */
  nPaired: number;
}

/**
 * Judge signature shared by harness-evolve and its gate/slow-update
 * helpers. `textA` / `textB` map to the prompt's "ORIGINAL" / "MUTATED"
 * slots; callers pass the baseline as `textA` and the candidate as `textB`.
 */
export type ScorePairFn = (
  textA: string,
  textB: string,
  selectionSet: ReadonlyArray<HeldOutExecution>,
) => Promise<ReadonlyArray<{ taskId: string; aPassed: boolean; bPassed: boolean }>>;

export class ExperimentSandbox {
  constructor(
    private readonly db: DatabaseSync,
    private readonly llmCall: (prompt: string) => Promise<string>,
  ) {
    // `db` is retained for parity with the harness-evolve call sites; the
    // judge itself reads nothing from it.
    void this.db;
  }

  /**
   * Score one pair of texts against a fixed selection set, producing
   * per-task paired predicted pass/fail. Returns the empty array when the
   * LLM judge response is unparseable or the selection set is empty.
   */
  async scoreVersionPair(
    textA: string,
    textB: string,
    selectionSet: ReadonlyArray<HeldOutExecution>,
  ): Promise<ReadonlyArray<{ taskId: string; aPassed: boolean; bPassed: boolean }>> {
    if (selectionSet.length === 0) {
      return [];
    }
    let paired: ReadonlyArray<PairedOutcome>;
    try {
      paired = await this.runPerformanceGate(textA, textB, selectionSet);
    } catch (err) {
      log.debug(`scoreVersionPair runPerformanceGate failed: ${String(err)}`);
      return [];
    }
    return paired.map((p) => ({
      taskId: p.executionId,
      aPassed: p.originalPassed,
      bPassed: p.mutatedPassed,
    }));
  }

  // ── Paired judge ──────────────────────────────────────────────────────────

  private async runPerformanceGate(
    originalText: string,
    mutatedText: string,
    selectionSet: ReadonlyArray<HeldOutExecution>,
  ): Promise<ReadonlyArray<PairedOutcome>> {
    const prompt = this.buildPerformancePrompt(originalText, mutatedText, selectionSet);
    const raw = await this.llmCall(prompt);
    const parsed = parsePerformanceResponse(raw);
    if (!parsed) {
      return [];
    }

    // Pair the judge's per-trial scores back to the selection set rows by
    // 1-based index. Ignore any rows the judge skipped.
    const paired: PairedOutcome[] = [];
    for (const trial of parsed.trials) {
      const idx = trial.index - 1;
      const source = selectionSet[idx];
      if (!source) {
        continue;
      }
      paired.push({
        executionId: source.id,
        originalPassed: trial.originalPassed,
        mutatedPassed: trial.mutatedPassed,
      });
    }
    return paired;
  }

  private buildPerformancePrompt(
    originalText: string,
    mutatedText: string,
    selectionSet: ReadonlyArray<HeldOutExecution>,
  ): string {
    const trialsBlock = selectionSet
      .map((exec, i) => {
        const context = (exec.contextJson ?? "{}").slice(0, MAX_CONTEXT_CHARS);
        const errorTag = exec.errorType ? ` (original error_type=${exec.errorType})` : "";
        return `[${i + 1}] originalSucceeded=${exec.success}${errorTag}\n    context: ${context}`;
      })
      .join("\n");

    return (
      `You are scoring whether each version of a skill would have produced a successful ` +
      `outcome given a past execution context. The ORIGINAL skill actually ran on each ` +
      `context; we want to know if the MUTATED version would have done at least as well.\n\n` +
      `ORIGINAL SKILL:\n${originalText.slice(0, 1000)}\n\n` +
      `MUTATED SKILL:\n${mutatedText.slice(0, 1000)}\n\n` +
      `Past execution contexts:\n${trialsBlock}\n\n` +
      `Respond with a JSON object:\n` +
      `{\n` +
      `  "trials": [\n` +
      `    { "index": 1, "originalPassed": true/false, "mutatedPassed": true/false }\n` +
      `  ]\n` +
      `}\n\n` +
      `Include one entry per past context. Respond ONLY with the JSON object.`
    );
  }
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

export interface PairedOutcome {
  executionId: string;
  originalPassed: boolean;
  mutatedPassed: boolean;
}

interface ParsedPerformance {
  trials: Array<{ index: number; originalPassed: boolean; mutatedPassed: boolean }>;
}

function stripFences(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return cleaned;
}

function parsePerformanceResponse(raw: string): ParsedPerformance | null {
  try {
    const parsed = JSON.parse(stripFences(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const trialsRaw = (parsed as { trials?: unknown }).trials;
    if (!Array.isArray(trialsRaw)) {
      return null;
    }
    const trials: Array<{ index: number; originalPassed: boolean; mutatedPassed: boolean }> = [];
    for (const entry of trialsRaw) {
      if (entry && typeof entry === "object") {
        const index = Number((entry as { index?: unknown }).index);
        const originalPassed = Boolean((entry as { originalPassed?: unknown }).originalPassed);
        const mutatedPassed = Boolean((entry as { mutatedPassed?: unknown }).mutatedPassed);
        if (Number.isFinite(index) && index >= 1) {
          trials.push({ index, originalPassed, mutatedPassed });
        }
      }
    }
    if (trials.length === 0) {
      return null;
    }
    return { trials };
  } catch {
    return null;
  }
}

// ── Bootstrap CI ────────────────────────────────────────────────────────────

/**
 * Paired bootstrap on per-trial deltas. Returns the mean delta and the 95%
 * percentile CI. Pure given a seeded RNG, so tests can pin determinism.
 */
export function bootstrapPairedCI(
  paired: ReadonlyArray<PairedOutcome>,
  iterations: number = BOOTSTRAP_ITERATIONS,
  random: () => number = Math.random,
): StatisticalResult {
  const n = paired.length;
  if (n === 0) {
    return { delta: 0, ci95Low: 0, ci95High: 0, nPaired: 0 };
  }
  const deltas = paired.map((p) => (p.mutatedPassed ? 1 : 0) - (p.originalPassed ? 1 : 0));
  const observed = mean(deltas);
  const resampleMeans: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.min(n - 1, Math.floor(random() * n));
      sum += deltas[idx]!;
    }
    resampleMeans.push(sum / n);
  }
  resampleMeans.sort((a, b) => a - b);
  const lowIdx = Math.floor(0.025 * iterations);
  const highIdx = Math.min(iterations - 1, Math.floor(0.975 * iterations));
  return {
    delta: observed,
    ci95Low: resampleMeans[lowIdx] ?? observed,
    ci95High: resampleMeans[highIdx] ?? observed,
    nPaired: n,
  };
}

// ── Misc ───────────────────────────────────────────────────────────────────

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) {
    return 0;
  }
  let s = 0;
  for (const v of values) {
    s += v;
  }
  return s / values.length;
}

export const __testing = {
  bootstrapPairedCI,
  parsePerformanceResponse,
};
