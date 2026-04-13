/**
 * LongMemEval Biological Mode Runner for Bitterbot
 *
 * Exercises the FULL biological memory pipeline for each question:
 *   1. Ingest sessions ONE AT A TIME (simulating real conversations over time)
 *   2. Stimulate hormones per session (social/reward/stress signals)
 *   3. Run consolidation after ingestion (Ebbinghaus decay, merging, importance scoring)
 *   4. Trigger a dream cycle (replay, compression, exploration, mutation)
 *   5. Search with full pipeline (reconsolidation labile windows, mood-congruent retrieval)
 *   6. Generate answer with Opus 4.6
 *
 * This mode is 5-10x slower than the baseline runner but exercises:
 *   - Reconsolidation (recalled memories enter labile windows during search)
 *   - Dream consolidation (cross-session synthesis, compression, replay)
 *   - Hormonal modulation (mood-congruent retrieval biases)
 *   - Spacing effect (access timestamps tracked across sessions)
 *   - Synaptic tagging (strong session crystals promote nearby weak ones)
 *   - Curiosity (gap detection from exploration targets)
 *   - Knowledge graph (entity extraction for structured relationships)
 *
 * Usage:
 *   node --import tsx benchmarks/longmemeval/runner-biological.ts [--oracle] [--limit N]
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
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
} from "./adapter.js";

// ── CLI Args ──

const { values: args } = parseArgs({
  options: {
    oracle: { type: "boolean", default: false },
    limit: { type: "string", default: "0" },
    stratify: { type: "string", default: "0" },
    model: { type: "string", default: "anthropic/claude-opus-4-6" },
    "max-results": { type: "string", default: "15" },
    "data-dir": { type: "string", default: join(__dirname, "data") },
    "output-dir": { type: "string", default: join(__dirname, "results") },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

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
  const maxResults = parseInt(args["max-results"]!, 10);
  const model = args.model!;
  const verbose = args.verbose!;

  console.log("🧬 LongMemEval BIOLOGICAL Mode — Bitterbot");
  console.log(`   Data: ${dataFile}`);
  console.log(`   Model: ${model}`);
  console.log(`   Max search results: ${maxResults}`);
  console.log(`   Oracle mode: ${args.oracle}`);
  if (limit) {
    console.log(`   Limit: ${limit} questions`);
  }
  console.log("");
  console.log(
    "   Pipeline: ingest-per-session → hormones → consolidation → dream → search → answer",
  );
  console.log("");

  // Load dataset
  const dataset = loadDataset(dataFile);
  const stratify = parseInt(args.stratify!, 10) || 0;
  let items: LongMemEvalItem[];
  if (stratify > 0) {
    // Stratified sample: take first N of each question type (deterministic, reproducible)
    const buckets: Record<string, LongMemEvalItem[]> = {};
    for (const it of dataset) {
      if (!buckets[it.question_type]) {
        buckets[it.question_type] = [];
      }
      if (buckets[it.question_type].length < stratify) {
        buckets[it.question_type].push(it);
      }
    }
    items = Object.values(buckets).flat();
    console.log(
      `Stratified sample: ${stratify} per category × ${Object.keys(buckets).length} categories = ${items.length} questions`,
    );
    for (const [type, bucket] of Object.entries(buckets)) {
      console.log(`   ${type}: ${bucket.length}`);
    }
  } else {
    items = limit ? dataset.slice(0, limit) : dataset;
  }
  console.log(`Loaded ${items.length} questions (of ${dataset.length} total)`);

  // Import bridge
  const { createBiologicalBenchmarkBridge } = await import("./bitterbot-bridge-biological.js");
  const bridge = await createBiologicalBenchmarkBridge({ model });

  const results: LongMemEvalResult[] = [];
  // Retrieval-only sidecar: per-question session rankings for R@K computation
  const retrievalRecords: Array<{
    question_id: string;
    question_type: string;
    num_haystack_sessions: number;
    answer_session_ids: string[];
    retrieved_sessions: string[];
    recall_any_5: number;
    recall_any_10: number;
    num_chunks: number;
  }> = [];
  const workDir = join(__dirname, ".work-bio");
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
      console.log(`   Sessions: ${item.haystack_sessions.length}`);
    } else if (i % 10 === 0) {
      console.log(`${progress} Processing...`);
    }

    try {
      // ── Step 0: Reset memory (clean slate per question) ──
      await bridge.reset();

      // ── Step 1: Ingest sessions ONE AT A TIME (simulating real conversations) ──
      // Sort chronologically so the memory system sees events in order
      const indexed = item.haystack_sessions.map((session, si) => ({
        session,
        date: item.haystack_dates[si] ?? "unknown",
        id: item.haystack_session_ids[si] ?? `session_${si}`,
      }));
      indexed.sort((a, b) => a.date.localeCompare(b.date));

      const itemWorkDir = join(workDir, item.question_id);
      mkdirSync(itemWorkDir, { recursive: true });

      for (let si = 0; si < indexed.length; si++) {
        const { session, date, id } = indexed[si];
        const md = sessionToMarkdown(session, date, id);
        const filepath = join(itemWorkDir, `${id}.md`);
        writeFileSync(filepath, md, "utf-8");

        // Ingest this single session
        await bridge.ingestFile(filepath);

        // Stimulate hormones based on session content
        // Simulates the emotional impact of the conversation
        const sessionText = session.map((t) => t.content).join(" ");
        bridge.stimulate(sessionText);

        if (verbose && si === 0) {
          console.log(`   Ingested session 1/${indexed.length} (${date})`);
        }
      }

      if (verbose) {
        console.log(`   All ${indexed.length} sessions ingested`);
        const hormones = bridge.hormonalState();
        if (hormones) {
          console.log(
            `   Hormones: D=${hormones.dopamine.toFixed(2)} C=${hormones.cortisol.toFixed(2)} O=${hormones.oxytocin.toFixed(2)}`,
          );
        }
      }

      // ── Step 2: Run consolidation (Ebbinghaus decay, merging, importance scoring) ──
      const consolidationStats = bridge.consolidate();
      if (verbose && consolidationStats) {
        console.log(
          `   Consolidation: merged=${String((consolidationStats.merged as number) ?? 0)}, decayed=${String((consolidationStats.decayed as number) ?? 0)}`,
        );
      }

      // ── Step 3: Trigger a dream cycle ──
      // This runs replay, compression, exploration, and mutation modes
      // The dream engine selects modes based on hormonal state and curiosity targets
      const dreamStats = await bridge.dream();
      if (verbose && dreamStats) {
        console.log(
          `   Dream: ${dreamStats.newInsights?.length ?? 0} insights, state=${dreamStats.cycle?.state ?? "?"}`,
        );
      }

      // ── Step 4: Search with full pipeline ──
      // Brief cooldown lets the embedding API connection pool recover after heavy ingestion
      await new Promise((r) => setTimeout(r, 1000));
      // Search triggers reconsolidation (labile windows) and mood-congruent retrieval
      const searchQuery = buildSearchQuery(item);
      const chunks = await bridge.search(searchQuery, { maxResults });

      if (verbose) {
        console.log(`   Retrieved ${chunks.length} chunks`);
        if (chunks.length > 0) {
          console.log(
            `   Top scores: ${chunks
              .slice(0, 3)
              .map((c: MemoryChunk) => c.score.toFixed(3))
              .join(", ")}`,
          );
        }
      }

      // ── Record retrieval ranking for R@K computation ──
      // Dedupe chunks → ordered unique sessions (best chunk score per session).
      // Chunks come back in score order, so first occurrence is best.
      const sessionOrder: string[] = [];
      const sessionSeen = new Set<string>();
      for (const c of chunks) {
        const sid = basename(c.path ?? "").replace(/\.md$/, "");
        if (sid && !sessionSeen.has(sid)) {
          sessionSeen.add(sid);
          sessionOrder.push(sid);
        }
      }
      const top5 = new Set(sessionOrder.slice(0, 5));
      const top10 = new Set(sessionOrder.slice(0, 10));
      const goldSessions = item.answer_session_ids ?? [];
      const recall_any_5 = goldSessions.some((g) => top5.has(g)) ? 1 : 0;
      const recall_any_10 = goldSessions.some((g) => top10.has(g)) ? 1 : 0;
      retrievalRecords.push({
        question_id: item.question_id,
        question_type: item.question_type,
        num_haystack_sessions: item.haystack_sessions.length,
        answer_session_ids: goldSessions,
        retrieved_sessions: sessionOrder.slice(0, 10),
        recall_any_5,
        recall_any_10,
        num_chunks: chunks.length,
      });
      if (verbose) {
        console.log(
          `   Unique sessions in top-${chunks.length}: ${sessionOrder.length} | R@5=${recall_any_5} R@10=${recall_any_10}`,
        );
      }

      // ── Step 5: Generate answer ──
      const prompt = buildAnswerPrompt(
        item.question,
        item.question_date,
        item.question_type,
        chunks,
      );
      const hypothesis = await bridge.complete({ model, prompt, maxTokens: 256 });

      results.push({
        question_id: item.question_id,
        hypothesis: hypothesis.trim(),
      });

      typeCounters[item.question_type].processed++;

      if (verbose) {
        console.log(`   A: ${hypothesis.trim().slice(0, 100)}...`);
        console.log(`   Expected: ${String(item.answer).slice(0, 100)}`);
      }

      rmSync(itemWorkDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`   Error on ${item.question_id}:`, err);
      results.push({
        question_id: item.question_id,
        hypothesis: "[ERROR]",
      });
    }
  }

  // Write results
  const suffix = args.oracle ? "oracle_biological" : "s_biological";
  const outputPath = join(outputDir, `bitterbot_longmemeval_${suffix}.jsonl`);
  writeResults(results, outputPath);
  console.log(`\nResults written to ${outputPath}`);

  // ── Write retrieval-only sidecar with R@K metrics ──
  const retrievalSuffix = args.oracle ? "oracle_biological_retrieval" : "s_biological_retrieval";
  const retrievalPath = join(outputDir, `bitterbot_longmemeval_${retrievalSuffix}.json`);
  const n = retrievalRecords.length;
  const aggR5 = n ? retrievalRecords.reduce((s, r) => s + r.recall_any_5, 0) / n : 0;
  const aggR10 = n ? retrievalRecords.reduce((s, r) => s + r.recall_any_10, 0) / n : 0;
  const byTypeAgg: Record<string, { n: number; r5: number; r10: number }> = {};
  for (const r of retrievalRecords) {
    if (!byTypeAgg[r.question_type]) {
      byTypeAgg[r.question_type] = { n: 0, r5: 0, r10: 0 };
    }
    byTypeAgg[r.question_type].n++;
    byTypeAgg[r.question_type].r5 += r.recall_any_5;
    byTypeAgg[r.question_type].r10 += r.recall_any_10;
  }
  writeFileSync(
    retrievalPath,
    JSON.stringify(
      {
        n_questions: n,
        overall: { "R@5": aggR5, "R@10": aggR10 },
        by_question_type: Object.fromEntries(
          Object.entries(byTypeAgg).map(([k, v]) => [
            k,
            { n: v.n, "R@5": v.r5 / v.n, "R@10": v.r10 / v.n },
          ]),
        ),
        per_question: retrievalRecords,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`Retrieval sidecar written to ${retrievalPath}`);
  console.log(`Retrieval R@5: ${(aggR5 * 100).toFixed(1)}%, R@10: ${(aggR10 * 100).toFixed(1)}%`);

  // Summary
  console.log("\nSummary by question type:");
  for (const [type, counts] of Object.entries(typeCounters)) {
    console.log(`   ${type}: ${counts.processed}/${counts.total}`);
  }

  // Cleanup
  cleanWorkDir(workDir);
  await bridge.cleanup();
}

// ── Helpers ──

function buildSearchQuery(item: LongMemEvalItem): string {
  const base = item.question;
  switch (item.question_type) {
    case "temporal-reasoning":
      return `${base} (as of ${item.question_date})`;
    case "knowledge-update":
      return `${base} (most recent information)`;
    case "multi-session":
      return base;
    default:
      return base;
  }
}

// ── Run ──

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
