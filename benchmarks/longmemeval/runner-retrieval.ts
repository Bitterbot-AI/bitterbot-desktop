/**
 * LongMemEval RETRIEVAL-ONLY Runner
 *
 * Computes Recall@K (gold-evidence session present in top-K retrieved sessions)
 * to give an apples-to-apples comparison against MemPalace's reported 96.6% R@5.
 *
 * Key differences from runner.ts and runner-biological.ts:
 *   - No answer generation, no LLM judge — pure retrieval evaluation
 *   - Per-session file ingestion (one .md per session) so we can map chunks → sessions
 *   - Uses the baseline bridge (no consolidation/dream/hormones) to compare against
 *     MemPalace's "raw mode" honestly
 *
 * Methodology mirrors mempalace's longmemeval_bench.py:
 *   1. Ingest the haystack sessions into a fresh memory store per question
 *   2. Search with the question text
 *   3. Dedupe top-K chunks down to unique sessions (best chunk score per session)
 *   4. recall_any@K = 1 if any answer_session_id ∈ top-K sessions, else 0
 *
 * Usage:
 *   node --import tsx benchmarks/longmemeval/runner-retrieval.ts [--oracle] [--limit N]
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { type LongMemEvalItem, loadDataset, sessionToMarkdown, cleanWorkDir } from "./adapter.js";
import { createBenchmarkMemoryManager } from "./bitterbot-bridge.js";

// ── CLI Args ──

const { values: args } = parseArgs({
  options: {
    oracle: { type: "boolean", default: false },
    limit: { type: "string", default: "0" },
    "max-chunks": { type: "string", default: "50" },
    "data-dir": { type: "string", default: join(__dirname, "data") },
    "output-dir": { type: "string", default: join(__dirname, "results") },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

// ── Helpers ──

function sessionIdFromPath(path: string): string {
  const base = basename(path);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

interface PerQuestion {
  question_id: string;
  question_type: string;
  num_haystack_sessions: number;
  num_answer_sessions: number;
  retrieved_sessions: string[]; // ordered, unique, by best chunk score
  answer_session_ids: string[];
  recall_any_5: number;
  recall_any_10: number;
  recall_all_5: number;
  recall_all_10: number;
  num_chunks_returned: number;
  error?: string;
}

interface Aggregate {
  count: number;
  recall_any_5_sum: number;
  recall_any_10_sum: number;
  recall_all_5_sum: number;
  recall_all_10_sum: number;
}

function emptyAgg(): Aggregate {
  return {
    count: 0,
    recall_any_5_sum: 0,
    recall_any_10_sum: 0,
    recall_all_5_sum: 0,
    recall_all_10_sum: 0,
  };
}

function addToAgg(agg: Aggregate, q: PerQuestion) {
  agg.count++;
  agg.recall_any_5_sum += q.recall_any_5;
  agg.recall_any_10_sum += q.recall_any_10;
  agg.recall_all_5_sum += q.recall_all_5;
  agg.recall_all_10_sum += q.recall_all_10;
}

function fmt(agg: Aggregate) {
  if (agg.count === 0) {
    return { n: 0, "R@5": "—", "R@10": "—", "R@5(all)": "—", "R@10(all)": "—" };
  }
  const pct = (n: number) => ((100 * n) / agg.count).toFixed(1) + "%";
  return {
    n: agg.count,
    "R@5": pct(agg.recall_any_5_sum),
    "R@10": pct(agg.recall_any_10_sum),
    "R@5(all)": pct(agg.recall_all_5_sum),
    "R@10(all)": pct(agg.recall_all_10_sum),
  };
}

// ── Main ──

async function run() {
  const dataFile = args.oracle
    ? join(args["data-dir"]!, "longmemeval_oracle.json")
    : join(args["data-dir"]!, "longmemeval_s.json");

  if (!existsSync(dataFile)) {
    console.error(`Data file not found: ${dataFile}`);
    console.error("   Run: pnpm benchmark:longmemeval:download");
    process.exit(1);
  }

  const outputDir = args["output-dir"]!;
  mkdirSync(outputDir, { recursive: true });

  const limit = parseInt(args.limit!, 10) || 0;
  const maxChunks = parseInt(args["max-chunks"]!, 10);
  const verbose = args.verbose!;

  console.log("LongMemEval RETRIEVAL-ONLY — Bitterbot");
  console.log(`   Data: ${dataFile}`);
  console.log(`   Max chunks per query: ${maxChunks}`);
  console.log(`   Oracle mode: ${args.oracle}`);
  if (limit) {
    console.log(`   Limit: ${limit} questions`);
  }
  console.log("");

  const dataset = loadDataset(dataFile);
  const items = limit ? dataset.slice(0, limit) : dataset;
  console.log(`Loaded ${items.length} questions (of ${dataset.length} total)`);

  const bridge = await createBenchmarkMemoryManager();

  const perQuestion: PerQuestion[] = [];
  const overall = emptyAgg();
  const byType: Record<string, Aggregate> = {};
  const workDir = join(__dirname, ".work-retrieval");

  const t0 = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const progress = `[${i + 1}/${items.length}]`;

    if (!byType[item.question_type]) {
      byType[item.question_type] = emptyAgg();
    }

    if (verbose) {
      console.log(
        `\n${progress} ${item.question_id} (${item.question_type}) — ${item.haystack_sessions.length} sessions`,
      );
    } else if (i % 10 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const r5 = overall.count
        ? ((100 * overall.recall_any_5_sum) / overall.count).toFixed(1) + "%"
        : "—";
      console.log(`${progress} elapsed=${elapsed}s running R@5=${r5}`);
    }

    const itemWorkDir = join(workDir, item.question_id);

    try {
      // Reset memory store
      await bridge.memory.reset();

      // Write each session to its own .md file (so chunk paths encode session id)
      mkdirSync(itemWorkDir, { recursive: true });
      const sessionFiles: string[] = [];
      for (let si = 0; si < item.haystack_sessions.length; si++) {
        const session = item.haystack_sessions[si];
        const date = item.haystack_dates[si] ?? "unknown";
        const sid = item.haystack_session_ids[si] ?? `session_${si}`;
        const md = sessionToMarkdown(session, date, sid);
        const fp = join(itemWorkDir, `${sid}.md`);
        writeFileSync(fp, md, "utf-8");
        sessionFiles.push(fp);
      }

      // Single batch ingest
      await bridge.memory.ingestMarkdownFiles(sessionFiles);

      // Search — request enough chunks to dedupe down to top-10 sessions safely
      const chunks = await bridge.memory.search(item.question, { maxResults: maxChunks });

      // Dedupe to ranked unique sessions (best chunk score per session)
      const seen = new Map<string, number>(); // session_id -> best score
      const order: string[] = [];
      for (const c of chunks) {
        const sid = sessionIdFromPath(c.path);
        if (!seen.has(sid)) {
          seen.set(sid, c.score);
          order.push(sid);
        } else {
          // chunks are returned in score order, so first occurrence is best
        }
      }

      const top5 = new Set(order.slice(0, 5));
      const top10 = new Set(order.slice(0, 10));
      const gold = item.answer_session_ids ?? [];

      const recall_any_5 = gold.some((g) => top5.has(g)) ? 1 : 0;
      const recall_any_10 = gold.some((g) => top10.has(g)) ? 1 : 0;
      const recall_all_5 = gold.length > 0 && gold.every((g) => top5.has(g)) ? 1 : 0;
      const recall_all_10 = gold.length > 0 && gold.every((g) => top10.has(g)) ? 1 : 0;

      const q: PerQuestion = {
        question_id: item.question_id,
        question_type: item.question_type,
        num_haystack_sessions: item.haystack_sessions.length,
        num_answer_sessions: gold.length,
        retrieved_sessions: order.slice(0, 10),
        answer_session_ids: gold,
        recall_any_5,
        recall_any_10,
        recall_all_5,
        recall_all_10,
        num_chunks_returned: chunks.length,
      };

      perQuestion.push(q);
      addToAgg(overall, q);
      addToAgg(byType[item.question_type], q);

      if (verbose) {
        console.log(
          `   chunks=${chunks.length} unique_sessions=${order.length} R@5=${recall_any_5} R@10=${recall_any_10}`,
        );
        console.log(`   gold=${gold.join(",")} top5=${[...top5].join(",")}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   Error on ${item.question_id}: ${msg}`);
      perQuestion.push({
        question_id: item.question_id,
        question_type: item.question_type,
        num_haystack_sessions: item.haystack_sessions.length,
        num_answer_sessions: (item.answer_session_ids ?? []).length,
        retrieved_sessions: [],
        answer_session_ids: item.answer_session_ids ?? [],
        recall_any_5: 0,
        recall_any_10: 0,
        recall_all_5: 0,
        recall_all_10: 0,
        num_chunks_returned: 0,
        error: msg,
      });
    } finally {
      rmSync(itemWorkDir, { recursive: true, force: true });
    }
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);

  // Write outputs
  const suffix = args.oracle ? "oracle_retrieval" : "s_retrieval";
  const outputPath = join(outputDir, `bitterbot_longmemeval_${suffix}.json`);
  const summary = {
    dataset: dataFile,
    n_questions: perQuestion.length,
    elapsed_seconds: parseFloat(totalSec),
    overall: fmt(overall),
    by_question_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, fmt(v)])),
    per_question: perQuestion,
  };
  writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf-8");

  // Console summary
  console.log("");
  console.log(`Done in ${totalSec}s — wrote ${outputPath}`);
  console.log("");
  console.log("Overall:");
  console.log("  ", fmt(overall));
  console.log("");
  console.log("By question type:");
  for (const [type, agg] of Object.entries(byType)) {
    console.log(`  ${type}:`, fmt(agg));
  }

  cleanWorkDir(workDir);
  await bridge.cleanup();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
