/**
 * LongMemEval Results Evaluator
 *
 * Scores Bitterbot's results against LongMemEval ground truth.
 * Can run standalone (using GPT-4o as judge, matching official eval)
 * or generate output compatible with LongMemEval's Python evaluation script.
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/evaluate.ts [--results FILE] [--data FILE]
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  type LongMemEvalItem,
  loadDataset,
  loadDatasetSplit,
  readResults,
  selectSplit,
  type SplitName,
} from "./adapter.js";
import { judgeAnswer, heuristicJudge } from "./judge.js";

const { values: args } = parseArgs({
  options: {
    results: {
      type: "string",
      default: join(__dirname, "results", "bitterbot_longmemeval_s.jsonl"),
    },
    data: { type: "string", default: join(__dirname, "data", "longmemeval_s.json") },
    "skip-llm": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    // PLAN-21 Phase E: pick which split of the dataset to score against.
    // Defaults to "all" so existing CI invocations are unchanged. Pass
    // --split=test for publication-grade numbers free of train-on-test
    // contamination from any skill optimization that ran during training.
    split: { type: "string", default: "all" },
  },
  strict: true,
});

// ── Types ──

interface EvalResult {
  question_id: string;
  question_type: string;
  question: string;
  expected: string;
  hypothesis: string;
  score: number; // 0 or 1
  isAbstention: boolean;
}

// Judges live in judge.js (re-exported here for backward compatibility).
export { judgeAnswer, heuristicJudge };

// ── Main ──

async function run() {
  console.log("📊 LongMemEval Results Evaluator");

  const results = readResults(args.results!);

  // PLAN-21 Phase E: optionally restrict scoring to a deterministic split.
  // "all" preserves the previous behaviour.
  const splitName = (args.split ?? "all") as SplitName;
  if (!["train", "selection", "test", "all"].includes(splitName)) {
    throw new Error(`--split must be one of train|selection|test|all (got "${splitName}")`);
  }
  const dataset =
    splitName === "all"
      ? loadDataset(args.data!)
      : selectSplit(loadDatasetSplit(args.data!), splitName);

  // Index dataset by question_id
  const dataMap = new Map<string, LongMemEvalItem>();
  for (const item of dataset) {
    dataMap.set(item.question_id, item);
  }

  console.log(`   Results: ${results.length} answers`);
  console.log(`   Dataset: ${dataset.length} questions (split=${splitName})`);
  console.log(`   LLM Judge: ${args["skip-llm"] ? "OFF (heuristic)" : "ON (GPT-4o)"}`);
  console.log("");

  const evalResults: EvalResult[] = [];
  const useLlm = !args["skip-llm"];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const item = dataMap.get(result.question_id);

    if (!item) {
      console.warn(`⚠️  No dataset entry for ${result.question_id}`);
      continue;
    }

    if (i % 50 === 0) {
      console.log(`   Evaluating [${i + 1}/${results.length}]...`);
    }

    const isAbs = result.question_id.endsWith("_abs");
    let score: number;

    if (result.hypothesis === "[ERROR]" || result.hypothesis === "[DRY RUN]") {
      score = 0;
    } else if (useLlm) {
      score = await judgeAnswer(item.question, item.answer, result.hypothesis);
    } else {
      score = heuristicJudge(item.answer, result.hypothesis);
    }

    evalResults.push({
      question_id: item.question_id,
      question_type: item.question_type,
      question: item.question,
      expected: item.answer,
      hypothesis: result.hypothesis,
      score,
      isAbstention: isAbs,
    });

    if (args.verbose && score === 0) {
      console.log(
        `   ❌ ${item.question_id}: expected "${item.answer}" got "${result.hypothesis.slice(0, 80)}"`,
      );
    }
  }

  // Aggregate scores by type
  const typeScores: Record<string, { correct: number; total: number }> = {};
  let totalCorrect = 0;

  for (const er of evalResults) {
    if (!typeScores[er.question_type]) {
      typeScores[er.question_type] = { correct: 0, total: 0 };
    }
    typeScores[er.question_type].total++;
    typeScores[er.question_type].correct += er.score;
    totalCorrect += er.score;
  }

  // Print results
  console.log("\n" + "=".repeat(60));
  console.log("📊 LongMemEval Results — Bitterbot");
  console.log("=".repeat(60));

  const typeOrder = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "temporal-reasoning",
    "knowledge-update",
    "multi-session",
  ];

  // Grouped categories matching LongMemEval paper
  const infoExtraction = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
  ];
  const ieCorrect = infoExtraction.reduce((sum, t) => sum + (typeScores[t]?.correct ?? 0), 0);
  const ieTotal = infoExtraction.reduce((sum, t) => sum + (typeScores[t]?.total ?? 0), 0);

  console.log(
    `\n  Information Extraction:  ${ieCorrect}/${ieTotal} (${ieTotal ? ((ieCorrect / ieTotal) * 100).toFixed(1) : 0}%)`,
  );

  for (const type of typeOrder) {
    const s = typeScores[type];
    if (!s) {
      continue;
    }
    const pct = s.total ? ((s.correct / s.total) * 100).toFixed(1) : "0.0";
    const indent = infoExtraction.includes(type) ? "    " : "  ";
    console.log(`${indent}${type}: ${s.correct}/${s.total} (${pct}%)`);
  }

  // Abstention
  const absResults = evalResults.filter((r) => r.isAbstention);
  const absCorrect = absResults.reduce((sum, r) => sum + r.score, 0);
  console.log(
    `\n  Abstention: ${absCorrect}/${absResults.length} (${absResults.length ? ((absCorrect / absResults.length) * 100).toFixed(1) : 0}%)`,
  );

  const overall = evalResults.length
    ? ((totalCorrect / evalResults.length) * 100).toFixed(1)
    : "0.0";
  console.log(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  OVERALL: ${totalCorrect}/${evalResults.length} (${overall}%)`);
  console.log("=".repeat(60));

  // Save detailed results
  const reportPath = join(args.results!.replace(".jsonl", "_evaluated.json"));
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        summary: {
          overall: { correct: totalCorrect, total: evalResults.length, pct: parseFloat(overall) },
          byType: Object.fromEntries(
            Object.entries(typeScores).map(([k, v]) => [
              k,
              { ...v, pct: v.total ? (v.correct / v.total) * 100 : 0 },
            ]),
          ),
          abstention: { correct: absCorrect, total: absResults.length },
        },
        details: evalResults,
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(`\n📄 Detailed results: ${reportPath}`);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
