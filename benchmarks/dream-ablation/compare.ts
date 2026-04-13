/**
 * Dream Ablation Comparison Tool
 *
 * Reads evaluated result files from the results/ directory and produces
 * a comparison matrix showing accuracy deltas per variant per question type.
 *
 * Usage:
 *   node --import tsx benchmarks/dream-ablation/compare.ts [--baseline full-bio]
 *
 * Prerequisites:
 *   1. Run runner.ts for each variant to produce JSONL files
 *   2. Run the longmemeval evaluate.ts on each JSONL to produce *_evaluated.json files
 *      OR place pre-evaluated files in results/
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { values: args } = parseArgs({
  options: {
    baseline: { type: "string", default: "full-bio" },
  },
  strict: true,
});

// ── Types ──

interface EvaluatedResult {
  summary: {
    overall: { correct: number; total: number; pct: number };
    byType: Record<string, { correct: number; total: number; pct: number }>;
  };
}

interface DreamMetricsFile {
  variant: string;
  variantName: string;
  description: string;
  expectedImpact: string;
  questionsProcessed: number;
  dreamSummary: Record<string, unknown>;
  memorySummary: Record<string, unknown>;
}

interface VariantSummary {
  overall: { accuracy: number; delta: number };
  byType: Record<string, { accuracy: number; delta: number }>;
  dreamSummary?: Record<string, unknown>;
  memorySummary?: Record<string, unknown>;
}

// ── Main ──

function run() {
  const resultsDir = join(__dirname, "results");
  const baselineId = args.baseline!;

  // Find all evaluated JSON files
  const files = readdirSync(resultsDir).filter((f) => f.endsWith("_evaluated.json"));
  if (files.length === 0) {
    console.error("No evaluated result files found in results/");
    console.error("Run evaluate.ts first on the JSONL files produced by runner.ts");
    process.exit(1);
  }

  // Parse results by variant
  const results = new Map<string, EvaluatedResult>();
  for (const file of files) {
    // Extract variant ID: "full-bio_longmemeval_s_evaluated.json" → "full-bio"
    const variantId = file.replace(/_longmemeval_.*/, "");
    try {
      const data = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as EvaluatedResult;
      results.set(variantId, data);
    } catch (err) {
      console.warn(`  Skipping ${file}: ${String(err)}`);
    }
  }

  // Load dream metrics
  const dreamMetrics = new Map<string, DreamMetricsFile>();
  const metricFiles = readdirSync(resultsDir).filter((f) => f.endsWith("_dream_metrics.json"));
  for (const file of metricFiles) {
    const variantId = file.replace(/_dream_metrics\.json$/, "");
    try {
      const data = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as DreamMetricsFile;
      dreamMetrics.set(variantId, data);
    } catch {
      /* skip */
    }
  }

  // Check baseline exists
  const baseline = results.get(baselineId);
  if (!baseline) {
    console.error(`Baseline variant '${baselineId}' not found in results.`);
    console.error(`Available: ${[...results.keys()].join(", ")}`);
    process.exit(1);
  }

  // Build comparison
  const comparison: Record<string, VariantSummary> = {};
  const allTypes = new Set<string>();

  for (const [variantId, result] of results) {
    const overall = result.summary.overall;
    const baseOverall = baseline.summary.overall;

    const byType: Record<string, { accuracy: number; delta: number }> = {};
    for (const [type, stats] of Object.entries(result.summary.byType)) {
      allTypes.add(type);
      const baseType = baseline.summary.byType[type];
      byType[type] = {
        accuracy: stats.pct,
        delta: baseType ? stats.pct - baseType.pct : 0,
      };
    }

    const dm = dreamMetrics.get(variantId);
    comparison[variantId] = {
      overall: {
        accuracy: overall.pct,
        delta: overall.pct - baseOverall.pct,
      },
      byType,
      dreamSummary: dm?.dreamSummary,
      memorySummary: dm?.memorySummary,
    };
  }

  // Build matrix for table display
  const sortedTypes = [...allTypes].toSorted();
  const header = ["variant", "overall", ...sortedTypes];
  const matrix: (string | number)[][] = [header];

  for (const [variantId, summary] of Object.entries(comparison).toSorted(
    (a, b) => b[1].overall.accuracy - a[1].overall.accuracy,
  )) {
    const row: (string | number)[] = [variantId];
    row.push(summary.overall.accuracy);
    for (const type of sortedTypes) {
      row.push(summary.byType[type]?.accuracy ?? 0);
    }
    matrix.push(row);
  }

  // Output JSON
  const output = {
    baseline: baselineId,
    generatedAt: new Date().toISOString(),
    variantCount: results.size,
    variants: comparison,
    matrix,
  };

  const outPath = join(resultsDir, "ablation_comparison.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Comparison written to ${outPath}\n`);

  // Print table
  console.log("Dream Engine Ablation Results");
  console.log(`Baseline: ${baselineId} (${baseline.summary.overall.pct.toFixed(1)}% overall)\n`);

  // Header
  const colWidth = 14;
  const nameWidth = 22;
  const headerLine =
    "variant".padEnd(nameWidth) +
    header
      .slice(1)
      .map((h) => String(h).padStart(colWidth))
      .join("");
  console.log(headerLine);
  console.log("-".repeat(headerLine.length));

  // Rows
  for (const [variantId, summary] of Object.entries(comparison).toSorted(
    (a, b) => b[1].overall.accuracy - a[1].overall.accuracy,
  )) {
    const isBaseline = variantId === baselineId;
    let line = variantId.padEnd(nameWidth);

    // Overall
    const overallStr = isBaseline
      ? `${summary.overall.accuracy.toFixed(1)}%`
      : `${summary.overall.accuracy.toFixed(1)}% (${summary.overall.delta >= 0 ? "+" : ""}${summary.overall.delta.toFixed(1)})`;
    line += overallStr.padStart(colWidth);

    // Per-type
    for (const type of sortedTypes) {
      const typeData = summary.byType[type];
      if (!typeData) {
        line += "—".padStart(colWidth);
        continue;
      }
      const deltaStr = isBaseline
        ? `${typeData.accuracy.toFixed(1)}%`
        : `${typeData.accuracy.toFixed(1)}% (${typeData.delta >= 0 ? "+" : ""}${typeData.delta.toFixed(1)})`;
      line += deltaStr.padStart(colWidth);
    }

    console.log(line);
  }

  // Dream metrics summary
  console.log("\n\nDream Metrics Summary:");
  console.log("-".repeat(70));
  for (const [variantId, dm] of dreamMetrics) {
    const ds = dm.dreamSummary;
    console.log(
      `  ${variantId}: ${String((ds?.totalInsights as number) ?? 0)} insights, ${String((ds?.totalLlmCalls as number) ?? 0)} LLM calls, modes: ${JSON.stringify(ds?.modeFrequency ?? {})}`,
    );
  }

  console.log(`\nFull comparison: ${outPath}`);
}

run();
