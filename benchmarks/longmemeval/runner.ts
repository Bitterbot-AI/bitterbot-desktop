/**
 * LongMemEval Benchmark Runner for Bitterbot
 *
 * Orchestrates the full evaluation pipeline:
 * 1. Load LongMemEval dataset
 * 2. For each question: ingest chat history → search → generate answer
 * 3. Write results JSONL for official evaluation
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval/runner.ts [--oracle] [--limit N] [--model MODEL]
 */

import { mkdirSync, rmSync, existsSync } from "node:fs";
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
  convertItemToDocument,
  buildAnswerPrompt,
  writeResults,
  cleanWorkDir,
} from "./adapter.js";

// ── CLI Args ──

const { values: args } = parseArgs({
  options: {
    oracle: { type: "boolean", default: false },
    limit: { type: "string", default: "0" },
    model: { type: "string", default: "anthropic/claude-opus-4-6" },
    "max-results": { type: "string", default: "15" },
    "data-dir": { type: "string", default: join(__dirname, "data") },
    "output-dir": { type: "string", default: join(__dirname, "results") },
    verbose: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

// ── Main ──

interface MemoryManager {
  search(query: string, opts?: { maxResults?: number }): Promise<MemoryChunk[]>;
  sync(opts?: { reason?: string }): Promise<void>;
  ingestMarkdownFiles(files: string[]): Promise<void>;
  reset(): Promise<void>;
}

interface LlmProvider {
  complete(params: { model: string; prompt: string; maxTokens?: number }): Promise<string>;
}

async function run() {
  const dataFile = args.oracle
    ? join(args["data-dir"]!, "longmemeval_oracle.json")
    : join(args["data-dir"]!, "longmemeval_s.json");

  if (!existsSync(dataFile)) {
    console.error(`❌ Data file not found: ${dataFile}`);
    console.error("   Run: pnpm benchmark:longmemeval:download");
    process.exit(1);
  }

  const outputDir = args["output-dir"]!;
  mkdirSync(outputDir, { recursive: true });

  const limit = parseInt(args.limit!, 10) || 0;
  const maxResults = parseInt(args["max-results"]!, 10);
  const model = args.model!;
  const verbose = args.verbose!;
  const dryRun = args["dry-run"]!;

  console.log("🧠 LongMemEval Benchmark Runner for Bitterbot");
  console.log(`   Data: ${dataFile}`);
  console.log(`   Model: ${model}`);
  console.log(`   Max search results: ${maxResults}`);
  console.log(`   Oracle mode: ${args.oracle}`);
  if (limit) {
    console.log(`   Limit: ${limit} questions`);
  }
  console.log("");

  // Load dataset
  const dataset = loadDataset(dataFile);
  const items = limit ? dataset.slice(0, limit) : dataset;
  console.log(`📊 Loaded ${items.length} questions (of ${dataset.length} total)`);

  // Import Bitterbot internals
  // These imports are deferred so the benchmark can be type-checked
  // without requiring a full Bitterbot installation
  let memoryManager: MemoryManager;
  let llm: LlmProvider;
  let bridgeCleanup: (() => Promise<void>) | null = null;

  if (!dryRun) {
    try {
      const { createBenchmarkMemoryManager } = await import("./bitterbot-bridge.js");
      const bridge = await createBenchmarkMemoryManager();
      memoryManager = bridge.memory;
      llm = bridge.llm;
      bridgeCleanup = () => bridge.cleanup();
    } catch (err) {
      console.error("❌ Failed to initialize Bitterbot bridge:", err);
      console.error("   Make sure Bitterbot is built: pnpm build");
      console.error("   And OPENAI_API_KEY is set for embeddings");
      process.exit(1);
    }
  }

  const results: LongMemEvalResult[] = [];
  const workDir = join(__dirname, ".work");

  // Type-level counters for reporting
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
      console.log(`   Q: ${item.question.slice(0, 100)}...`);
      console.log(`   Sessions: ${item.haystack_sessions.length}`);
    } else if (i % 50 === 0) {
      console.log(`${progress} Processing...`);
    }

    if (dryRun) {
      results.push({
        question_id: item.question_id,
        hypothesis: "[DRY RUN]",
      });
      continue;
    }

    try {
      // Step 0: Reset memory for this question (clean slate per item)
      await memoryManager!.reset();

      // Step 1: Convert all sessions into a single chronological document
      const itemWorkDir = join(workDir, item.question_id);
      const docPath = convertItemToDocument(item, itemWorkDir);

      // Step 2: Ingest the document into memory
      await memoryManager!.ingestMarkdownFiles([docPath]);

      // Step 3: Search for relevant context
      const searchQuery = buildSearchQuery(item);
      const chunks = await memoryManager!.search(searchQuery, { maxResults });

      if (verbose) {
        console.log(`   Retrieved ${chunks.length} chunks`);
        if (chunks.length > 0) {
          console.log(
            `   Top scores: ${chunks
              .slice(0, 3)
              .map((c) => c.score.toFixed(3))
              .join(", ")}`,
          );
          console.log(
            `   Top chunk: ${chunks[0].snippet?.slice(0, 120) ?? chunks[0].text?.slice(0, 120) ?? "?"}...`,
          );
        }
      }

      // Step 4: Generate answer
      const prompt = buildAnswerPrompt(
        item.question,
        item.question_date,
        item.question_type,
        chunks,
      );
      const hypothesis = await llm!.complete({
        model,
        prompt,
        maxTokens: 256,
      });

      results.push({
        question_id: item.question_id,
        hypothesis: hypothesis.trim(),
      });

      typeCounters[item.question_type].processed++;

      if (verbose) {
        console.log(`   A: ${hypothesis.trim().slice(0, 100)}...`);
        console.log(`   Expected: ${item.answer.slice(0, 100)}`);
      }

      // Cleanup this item's work files
      rmSync(itemWorkDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`   ❌ Error on ${item.question_id}:`, err);
      results.push({
        question_id: item.question_id,
        hypothesis: "[ERROR]",
      });
    }
  }

  // Write results
  const suffix = args.oracle ? "oracle" : "s";
  const outputPath = join(outputDir, `bitterbot_longmemeval_${suffix}.jsonl`);
  writeResults(results, outputPath);
  console.log(`\n✅ Results written to ${outputPath}`);

  // Summary
  console.log("\n📊 Summary by question type:");
  for (const [type, counts] of Object.entries(typeCounters)) {
    console.log(`   ${type}: ${counts.processed}/${counts.total}`);
  }

  // Cleanup
  cleanWorkDir(workDir);
  if (bridgeCleanup) {
    await bridgeCleanup();
  }
}

// ── Helpers ──

/**
 * Build an optimized search query based on the question type.
 * For temporal questions, include date context.
 * For multi-session, emphasize entity relationships.
 */
function buildSearchQuery(item: LongMemEvalItem): string {
  const base = item.question;

  switch (item.question_type) {
    case "temporal-reasoning":
      return `${base} (as of ${item.question_date})`;
    case "knowledge-update":
      return `${base} (most recent information)`;
    case "multi-session":
      return base; // Multi-session needs broad retrieval
    default:
      return base;
  }
}

// ── Run ──

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
