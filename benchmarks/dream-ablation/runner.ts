/**
 * Dream Engine Ablation Runner
 *
 * Runs LongMemEval questions under a specific ablation variant (or all variants),
 * capturing both accuracy and dream-specific metrics per variant.
 *
 * Usage:
 *   node --import tsx benchmarks/dream-ablation/runner.ts --variant full-bio [--limit N] [--oracle]
 *   node --import tsx benchmarks/dream-ablation/runner.ts --variant all [--limit N]
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  type LongMemEvalItem,
  type LongMemEvalResult,
  type MemoryChunk,
  loadDataset,
  sessionToMarkdown,
  buildAnswerPrompt,
  writeResults,
  cleanWorkDir,
} from "../longmemeval/adapter.js";
import {
  createAblationBridge,
  type AblationBridge,
  type AggregatedDreamMetrics,
  type MemoryMetrics,
} from "./bridge.js";
import { VARIANTS, VARIANT_IDS, type VariantConfig } from "./variants.js";

// ── CLI Args ──

const { values: args } = parseArgs({
  options: {
    variant: { type: "string", default: "full-bio" },
    oracle: { type: "boolean", default: false },
    limit: { type: "string", default: "0" },
    model: { type: "string", default: "anthropic/claude-opus-4-6" },
    "max-results": { type: "string", default: "15" },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

// ── Per-question metrics ──

interface QuestionMetrics {
  questionId: string;
  questionType: string;
  dreamMetrics: AggregatedDreamMetrics;
  memoryMetrics: MemoryMetrics;
}

// ── Single variant runner ──

async function runVariant(
  variant: VariantConfig,
  items: LongMemEvalItem[],
  model: string,
  maxResults: number,
  verbose: boolean,
): Promise<{ results: LongMemEvalResult[]; questionMetrics: QuestionMetrics[] }> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  VARIANT: ${variant.id} — ${variant.name}`);
  console.log(`  ${variant.description}`);
  console.log(`  Expected impact: ${variant.expectedImpact}`);
  console.log(`${"=".repeat(70)}\n`);

  const bridge = await createAblationBridge(variant, { model });
  const results: LongMemEvalResult[] = [];
  const questionMetrics: QuestionMetrics[] = [];
  const workDir = join(__dirname, ".work", variant.id);
  const typeCounters: Record<string, { total: number; processed: number }> = {};

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const progress = `[${i + 1}/${items.length}]`;

    if (!typeCounters[item.question_type]) {
      typeCounters[item.question_type] = { total: 0, processed: 0 };
    }
    typeCounters[item.question_type].total++;

    if (verbose) {
      console.log(`\n${progress} ${item.question_id} (${item.question_type})`);
    } else if (i % 10 === 0) {
      console.log(`${progress} Processing...`);
    }

    try {
      await bridge.reset();

      // Ingest sessions chronologically
      const indexed = item.haystack_sessions.map((session, si) => ({
        session,
        date: item.haystack_dates[si] ?? "unknown",
        id: item.haystack_session_ids[si] ?? `session_${si}`,
      }));
      indexed.sort((a, b) => a.date.localeCompare(b.date));

      const itemWorkDir = join(workDir, item.question_id);
      mkdirSync(itemWorkDir, { recursive: true });

      for (const { session, date, id } of indexed) {
        const md = sessionToMarkdown(session, date, id);
        const filepath = join(itemWorkDir, `${id}.md`);
        writeFileSync(filepath, md, "utf-8");
        await bridge.ingestFile(filepath);
        bridge.stimulate(session.map((t) => t.content).join(" "));
      }

      // Consolidation
      bridge.consolidate();

      // Dream
      const dreamResult = await bridge.dream();
      if (verbose && dreamResult) {
        console.log(
          `   Dream: ${dreamResult.insightsGenerated} insights, modes=[${dreamResult.modesRun.join(",")}]`,
        );
      }

      // Search
      await new Promise((r) => setTimeout(r, 500));
      const searchQuery = buildSearchQuery(item);
      const chunks = await bridge.search(searchQuery, { maxResults });

      if (verbose) {
        console.log(`   Retrieved ${chunks.length} chunks`);
      }

      // Answer
      const prompt = buildAnswerPrompt(
        item.question,
        item.question_date,
        item.question_type,
        chunks,
      );
      const hypothesis = await bridge.complete({ model, prompt, maxTokens: 256 });

      results.push({ question_id: item.question_id, hypothesis: hypothesis.trim() });

      // Capture metrics
      questionMetrics.push({
        questionId: item.question_id,
        questionType: item.question_type,
        dreamMetrics: bridge.getDreamMetrics(),
        memoryMetrics: bridge.getMemoryMetrics(),
      });

      typeCounters[item.question_type].processed++;

      if (verbose) {
        console.log(`   A: ${hypothesis.trim().slice(0, 100)}...`);
      }

      rmSync(itemWorkDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`   Error on ${item.question_id}:`, err);
      results.push({ question_id: item.question_id, hypothesis: "[ERROR]" });
    }
  }

  // Summary
  console.log(`\n  ${variant.id} — Summary by question type:`);
  for (const [type, counts] of Object.entries(typeCounters)) {
    console.log(`    ${type}: ${counts.processed}/${counts.total}`);
  }

  cleanWorkDir(workDir);
  await bridge.cleanup();

  return { results, questionMetrics };
}

// ── Main ──

async function run() {
  const dataDir = join(dirname(__dirname), "longmemeval", "data");
  const dataFile = args.oracle
    ? join(dataDir, "longmemeval_oracle.json")
    : join(dataDir, "longmemeval_s.json");

  if (!existsSync(dataFile)) {
    console.error(`Data file not found: ${dataFile}`);
    console.error("   Run: pnpm benchmark:longmemeval:download");
    process.exit(1);
  }

  const outputDir = join(__dirname, "results");
  mkdirSync(outputDir, { recursive: true });

  const limit = parseInt(args.limit!, 10) || 0;
  const maxResults = parseInt(args["max-results"]!, 10);
  const model = args.model!;
  const verbose = args.verbose!;
  const variantArg = args.variant!;

  // Determine which variants to run
  const variantsToRun: VariantConfig[] = [];
  if (variantArg === "all") {
    variantsToRun.push(...VARIANT_IDS.map((id) => VARIANTS[id]!));
  } else {
    const variant = VARIANTS[variantArg];
    if (!variant) {
      console.error(`Unknown variant: ${variantArg}`);
      console.error(`Available variants: ${VARIANT_IDS.join(", ")}`);
      process.exit(1);
    }
    variantsToRun.push(variant);
  }

  console.log("Dream Engine Ablation Suite");
  console.log(`  Data: ${dataFile}`);
  console.log(`  Model: ${model}`);
  console.log(`  Variants: ${variantsToRun.map((v) => v.id).join(", ")}`);
  if (limit) console.log(`  Limit: ${limit} questions`);
  console.log("");

  const dataset = loadDataset(dataFile);
  const items = limit ? dataset.slice(0, limit) : dataset;
  console.log(`Loaded ${items.length} questions (of ${dataset.length} total)`);

  for (const variant of variantsToRun) {
    const { results, questionMetrics } = await runVariant(
      variant,
      items,
      model,
      maxResults,
      verbose,
    );

    // Write results JSONL
    const suffix = args.oracle ? "oracle" : "s";
    const resultsPath = join(outputDir, `${variant.id}_longmemeval_${suffix}.jsonl`);
    writeResults(results, resultsPath);
    console.log(`  Results: ${resultsPath}`);

    // Write dream metrics
    const metricsPath = join(outputDir, `${variant.id}_dream_metrics.json`);
    const aggregated = {
      variant: variant.id,
      variantName: variant.name,
      description: variant.description,
      expectedImpact: variant.expectedImpact,
      questionsProcessed: questionMetrics.length,
      dreamSummary: summarizeDreamMetrics(questionMetrics),
      memorySummary: summarizeMemoryMetrics(questionMetrics),
      perQuestion: questionMetrics,
    };
    writeFileSync(metricsPath, JSON.stringify(aggregated, null, 2), "utf-8");
    console.log(`  Metrics: ${metricsPath}`);
  }

  console.log("\nDone. Run evaluate.ts and then compare.ts to analyze results.");
}

// ── Helpers ──

function buildSearchQuery(item: LongMemEvalItem): string {
  const base = item.question;
  switch (item.question_type) {
    case "temporal-reasoning":
      return `${base} (as of ${item.question_date})`;
    case "knowledge-update":
      return `${base} (most recent information)`;
    default:
      return base;
  }
}

function summarizeDreamMetrics(metrics: QuestionMetrics[]): Record<string, unknown> {
  let totalCycles = 0;
  let totalInsights = 0;
  let totalLlmCalls = 0;
  const modeFreq: Record<string, number> = {};

  for (const m of metrics) {
    totalCycles += m.dreamMetrics.totalCycles;
    totalInsights += m.dreamMetrics.totalInsights;
    totalLlmCalls += m.dreamMetrics.totalLlmCalls;
    for (const [mode, count] of Object.entries(m.dreamMetrics.modeFrequency)) {
      modeFreq[mode] = (modeFreq[mode] ?? 0) + count;
    }
  }

  return {
    totalCycles,
    totalInsights,
    totalLlmCalls,
    avgInsightsPerQuestion: metrics.length > 0 ? (totalInsights / metrics.length).toFixed(2) : 0,
    avgLlmCallsPerQuestion: metrics.length > 0 ? (totalLlmCalls / metrics.length).toFixed(2) : 0,
    modeFrequency: modeFreq,
  };
}

function summarizeMemoryMetrics(metrics: QuestionMetrics[]): Record<string, unknown> {
  if (metrics.length === 0) return {};

  const avgChunks = metrics.reduce((s, m) => s + m.memoryMetrics.activeChunks, 0) / metrics.length;
  const avgInsights =
    metrics.reduce((s, m) => s + m.memoryMetrics.dreamInsights, 0) / metrics.length;
  const avgImportance =
    metrics.reduce((s, m) => s + m.memoryMetrics.avgImportanceScore, 0) / metrics.length;

  const curiosityRewards = metrics
    .map((m) => m.memoryMetrics.avgCuriosityReward)
    .filter((r): r is number => r !== null);
  const avgCuriosity =
    curiosityRewards.length > 0
      ? curiosityRewards.reduce((a, b) => a + b, 0) / curiosityRewards.length
      : null;

  return {
    avgActiveChunks: avgChunks.toFixed(1),
    avgDreamInsights: avgInsights.toFixed(1),
    avgImportanceScore: avgImportance.toFixed(3),
    avgCuriosityReward: avgCuriosity?.toFixed(3) ?? "N/A",
  };
}

// ── Run ──

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
