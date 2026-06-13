/**
 * PLAN-24 HORMA Phase 2: contrastive H-vs-H' runner + proof gate.
 *
 * For each LongMemEval item (default: the train split, so the held-out test
 * split is never touched), runs BOTH conditions against the same gold answer:
 *
 *   H  = full raw transcript stuffed into the prompt (no memory construction).
 *   H' = the real biological memory pipeline (ingest → construct → retrieve).
 *
 * Judges both, partitions into HORMA's D_exo / D_end sets, writes a
 * construction_feedback corpus (the Phase 3 architect-loop input) and a
 * human-readable report with accuracy by question type and the token-efficiency
 * ratio (H' context tokens / H context tokens — HORMA's headline metric).
 *
 * Usage:
 *   export $(grep -v '^#' .env | xargs)   # OPENAI_API_KEY + ANTHROPIC_API_KEY
 *   node --import tsx benchmarks/longmemeval/runner-contrastive.ts \
 *     --oracle --split train --limit 10 [--skip-extraction] [--skip-llm-judge]
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  type LongMemEvalItem,
  type MemoryChunk,
  buildAnswerPrompt,
  loadDatasetSplit,
  selectSplit,
  sessionToMarkdown,
} from "./adapter.js";
import {
  type ContrastiveRecord,
  constructionFeedback,
  summarize,
} from "./contrastive-partition.js";
import { judgeAnswer, heuristicJudge } from "./judge.js";

const { values: args } = parseArgs({
  options: {
    oracle: { type: "boolean", default: false },
    limit: { type: "string", default: "10" },
    split: { type: "string", default: "train" },
    model: { type: "string", default: "anthropic/claude-opus-4-7" },
    "max-results": { type: "string", default: "15" },
    "char-budget": { type: "string", default: "48000" },
    "skip-extraction": { type: "boolean", default: false },
    "skip-llm-judge": { type: "boolean", default: false },
    "data-dir": { type: "string", default: join(__dirname, "data") },
    "output-dir": { type: "string", default: join(__dirname, "results") },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** Retry an LLM completion through transient network failures. */
async function completeWithRetry(
  bridge: { complete(p: { model: string; prompt: string; maxTokens?: number }): Promise<string> },
  params: { model: string; prompt: string; maxTokens?: number },
  attempts = 3,
): Promise<string> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await bridge.complete(params);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
    }
  }
  throw lastErr;
}

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

/** Single chronological transcript for the H (full-context) condition. */
function buildFullTranscript(item: LongMemEvalItem): string {
  const indexed = item.haystack_sessions.map((session, i) => ({
    session,
    date: item.haystack_dates[i] ?? "unknown",
    id: item.haystack_session_ids[i] ?? `session_${i}`,
  }));
  indexed.sort((a, b) => a.date.localeCompare(b.date));
  return indexed.map(({ session, date, id }) => sessionToMarkdown(session, date, id)).join("\n\n");
}

async function judge(
  useLlm: boolean,
  question: string,
  expected: string,
  hypothesis: string,
): Promise<boolean> {
  try {
    const score = useLlm
      ? await judgeAnswer(question, expected, hypothesis)
      : heuristicJudge(expected, hypothesis);
    return score >= 1;
  } catch (err) {
    console.warn(`judge failed (${String(err)}), falling back to heuristic`);
    return heuristicJudge(expected, hypothesis) >= 1;
  }
}

async function run(): Promise<void> {
  const dataFile = args.oracle
    ? join(args["data-dir"]!, "longmemeval_oracle.json")
    : join(args["data-dir"]!, "longmemeval_s.json");
  if (!existsSync(dataFile)) {
    console.error(`Data file not found: ${dataFile}. Run: pnpm benchmark:longmemeval:download`);
    process.exit(1);
  }

  const outputDir = args["output-dir"]!;
  mkdirSync(outputDir, { recursive: true });
  const limit = parseInt(args.limit!, 10) || 0;
  const maxResults = parseInt(args["max-results"]!, 10);
  const charBudget = parseInt(args["char-budget"]!, 10);
  const model = args.model!;
  const useLlmJudge = !args["skip-llm-judge"];
  const skipExtraction = args["skip-extraction"]!;
  const splitName = args.split as "train" | "selection" | "test" | "all";

  const split = loadDatasetSplit(dataFile);
  const pool = selectSplit(split, splitName);
  const items = limit ? pool.slice(0, limit) : pool;

  console.log("🔬 LongMemEval CONTRASTIVE (H vs H') — PLAN-24 Phase 2");
  console.log(`   Data: ${dataFile} | split=${splitName} | items=${items.length}`);
  console.log(
    `   Model: ${model} | extraction=${skipExtraction ? "OFF" : "ON"} | judge=${useLlmJudge ? "GPT-4o" : "heuristic"}`,
  );
  console.log("");

  const { createBiologicalBenchmarkBridge } = await import("./bitterbot-bridge-biological.js");
  const bridge = await createBiologicalBenchmarkBridge({ model });
  const workDir = join(__dirname, ".work-contrastive");
  mkdirSync(workDir, { recursive: true });

  const records: ContrastiveRecord[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tag = `[${i + 1}/${items.length}] ${item.question_id} (${item.question_type})`;
    try {
      // ── H': memory pipeline ──
      await bridge.reset();
      const indexed = item.haystack_sessions.map((session, si) => ({
        session,
        date: item.haystack_dates[si] ?? "unknown",
        id: item.haystack_session_ids[si] ?? `session_${si}`,
      }));
      indexed.sort((a, b) => a.date.localeCompare(b.date));
      const itemWorkDir = join(workDir, item.question_id);
      mkdirSync(itemWorkDir, { recursive: true });
      for (const { session, date, id } of indexed) {
        const filepath = join(itemWorkDir, `${id}.md`);
        writeFileSync(filepath, sessionToMarkdown(session, date, id), "utf-8");
        await bridge.ingestFile(filepath);
        if (!skipExtraction) {
          bridge.kickOffExtraction(filepath);
        }
        bridge.stimulate(session.map((t) => t.content).join(" "));
      }
      if (!skipExtraction) {
        await bridge.awaitPendingExtractions();
      }
      bridge.consolidate();
      await new Promise((r) => setTimeout(r, 1000));
      const chunks: MemoryChunk[] = await bridge.search(buildSearchQuery(item), { maxResults });
      const hpContextTokens = chunks.reduce((a, c) => a + estTokens(c.text || ""), 0);
      const hpPrompt = buildAnswerPrompt(
        item.question,
        item.question_date,
        item.question_type,
        chunks,
      );
      const hypHp = (
        await completeWithRetry(bridge, { model, prompt: hpPrompt, maxTokens: 256 })
      ).trim();

      // ── H: full raw transcript ──
      let transcript = buildFullTranscript(item);
      if (transcript.length > charBudget) {
        transcript = transcript.slice(0, charBudget);
      }
      const hChunk: MemoryChunk = { id: "full", text: transcript, score: 1 };
      const hPrompt = buildAnswerPrompt(item.question, item.question_date, item.question_type, [
        hChunk,
      ]);
      const hTokens = estTokens(transcript);
      const hypH = (
        await completeWithRetry(bridge, { model, prompt: hPrompt, maxTokens: 256 })
      ).trim();

      // ── Judge both ──
      const hRight = await judge(useLlmJudge, item.question, item.answer, hypH);
      const hpRight = await judge(useLlmJudge, item.question, item.answer, hypHp);

      records.push({
        questionId: item.question_id,
        questionType: item.question_type,
        hRight,
        hpRight,
        hTokens,
        hpTokens: hpContextTokens,
        question: item.question,
        expected: item.answer,
        hypH,
        hypHp,
      });

      console.log(
        `${tag} H=${hRight ? "✓" : "✗"} H'=${hpRight ? "✓" : "✗"} | tokens H=${hTokens} H'=${hpContextTokens}`,
      );
      rmSync(itemWorkDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`${tag} FAILED: ${String(err)}`);
    }
  }

  await bridge.cleanup();
  rmSync(workDir, { recursive: true, force: true });

  // ── Outputs ──
  const summary = summarize(records);
  const feedback = constructionFeedback(records);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(outputDir, `contrastive_${args.oracle ? "oracle" : "s"}_${splitName}_${stamp}`);

  writeFileSync(
    `${base}.raw.jsonl`,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(`${base}.construction-feedback.json`, JSON.stringify(feedback, null, 2), "utf-8");
  writeFileSync(
    `${base}.report.md`,
    renderReport(summary, feedback.length, model, splitName),
    "utf-8",
  );

  console.log("\n" + renderReport(summary, feedback.length, model, splitName));
  console.log(`\nWrote: ${base}.report.md`);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function renderReport(
  s: ReturnType<typeof summarize>,
  feedbackCount: number,
  model: string,
  splitName: string,
): string {
  const lines: string[] = [];
  lines.push(`# LongMemEval contrastive report (PLAN-24 Phase 2)`);
  lines.push("");
  lines.push(`Model: ${model} · split: ${splitName} · N=${s.n}`);
  lines.push("");
  lines.push(`| Condition | Accuracy |`);
  lines.push(`| --- | --- |`);
  lines.push(`| H (full raw transcript) | ${pct(s.hAccuracy)} |`);
  lines.push(`| H' (memory pipeline) | ${pct(s.hpAccuracy)} |`);
  lines.push("");
  lines.push(
    `Buckets: D_exo (H✓ H'✗) = ${s.buckets.d_exo} · D_end (H✗ H'✓) = ${s.buckets.d_end} · both✓ = ${s.buckets.both_right} · both✗ = ${s.buckets.both_wrong}`,
  );
  lines.push("");
  lines.push(
    `Token efficiency: H' context averages ${Math.round(s.tokens.hpMean)} tokens vs H ${Math.round(s.tokens.hMean)} = **${pct(s.tokens.hpFractionOfH)} of baseline**.`,
  );
  lines.push("");
  lines.push(`Construction-feedback records emitted (D_exo): ${feedbackCount}`);
  lines.push("");
  lines.push(`## By question type`);
  lines.push("");
  lines.push(`| Type | N | H acc | H' acc | D_exo | D_end |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const [type, t] of Object.entries(s.byType)) {
    lines.push(`| ${type} | ${t.n} | ${pct(t.hAcc)} | ${pct(t.hpAcc)} | ${t.dExo} | ${t.dEnd} |`);
  }
  return lines.join("\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
