/**
 * LongMemEval official scoring, as `evaluate_qa.py` does it.
 *
 * Same judge snapshot (gpt-4o-2024-08-06), same five question-type prompts,
 * same decoding (temperature 0, max_tokens 10), same verdict rule
 * (`'yes' in response.lower()`), same output: one JSON line per hypothesis
 * with `autoeval_label: {model, label}` appended, written to
 * `<hyp>.eval-results-gpt-4o`. Aggregates follow `print_qa_metrics.py`:
 * per type, task-averaged (mean of the six type means), overall
 * (question-weighted) and abstention.
 *
 * To cross-check against the reference Python script itself, run
 * `bash benchmarks/longmemeval/official-scorer.sh <hyp> <ref>`.
 *
 *   node --import tsx benchmarks/longmemeval/evaluate-official.ts --hyp <jsonl> [--ref data/longmemeval_s.json]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/io.js";
import {
  aggregate,
  isAbstentionId,
  type Judged,
  JUDGE_MAX_TOKENS,
  JUDGE_TEMPERATURE,
  judgePrompt,
  OFFICIAL_JUDGE_MODEL,
  parseJudgeLabel,
  type RawItem,
} from "./official-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    hyp: { type: "string" },
    ref: { type: "string", default: join(__dirname, "data", "longmemeval_s.json") },
    concurrency: { type: "string", default: "4" },
    /** Score a partial file (pilots). An official number needs all 500. */
    "allow-partial": { type: "boolean", default: false },
  },
  strict: true,
});
if (!args.hyp) {
  throw new Error("--hyp <hypothesis.jsonl> is required");
}
const hypPath = args.hyp;
const resultPath = `${hypPath}.eval-results-gpt-4o`;

type Hyp = { question_id: string; hypothesis: string; [k: string]: unknown };
const hyps = readFileSync(hypPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Hyp);
const ref = new Map(
  (JSON.parse(readFileSync(args.ref!, "utf-8")) as RawItem[]).map(
    (r) => [r.question_id, r] as const,
  ),
);
const distinct = new Set(hyps.map((h) => h.question_id));
if (distinct.size !== hyps.length) {
  throw new Error(`${hyps.length - distinct.size} duplicate question_id(s) in ${hypPath}`);
}
if (distinct.size !== ref.size && !args["allow-partial"]) {
  throw new Error(
    `${distinct.size} hypotheses for ${ref.size} reference questions; an official number needs every one (pass --allow-partial for a pilot)`,
  );
}

// Resume: verdicts already written are kept (same inputs, deterministic judge).
const judged = new Map<string, Judged>();
if (existsSync(resultPath)) {
  for (const line of readFileSync(resultPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Hyp & { autoeval_label: { label: boolean } };
    const item = ref.get(row.question_id);
    if (item) {
      judged.set(row.question_id, {
        question_id: row.question_id,
        question_type: item.question_type,
        label: row.autoeval_label.label,
      });
    }
  }
}

const envKey = process.env.OPENAI_API_KEY?.trim();
const apiKey =
  envKey || (await resolveApiKeyForProvider({ provider: "openai", cfg: loadConfig() }))?.apiKey;
if (!apiKey) {
  throw new Error("no OpenAI key for the judge");
}

async function judgeOnce(prompt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: OFFICIAL_JUDGE_MODEL,
          messages: [{ role: "user", content: prompt }],
          n: 1,
          temperature: JUDGE_TEMPERATURE,
          max_tokens: JUDGE_MAX_TOKENS,
        }),
      });
      if (!res.ok) {
        throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message.content ?? "";
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

const todo = hyps.filter((h) => {
  if (!ref.has(h.question_id)) {
    console.warn(`Warning: skipping ${h.question_id} as it is not in reference data.`);
    return false;
  }
  return !judged.has(h.question_id);
});
console.log(`judging ${todo.length} of ${hyps.length} hypotheses with ${OFFICIAL_JUDGE_MODEL}`);

const concurrency = Math.max(1, Number(args.concurrency));
let cursor = 0;
let doneCount = 0;
async function worker() {
  while (cursor < todo.length) {
    const h = todo[cursor++]!;
    const item = ref.get(h.question_id)!;
    const prompt = judgePrompt({
      questionType: item.question_type,
      question: item.question,
      answer: item.answer,
      hypothesis: h.hypothesis,
      abstention: isAbstentionId(h.question_id),
    });
    const label = parseJudgeLabel(await judgeOnce(prompt));
    judged.set(h.question_id, {
      question_id: h.question_id,
      question_type: item.question_type,
      label,
    });
    appendFileSync(
      resultPath,
      `${JSON.stringify({ ...h, autoeval_label: { model: OFFICIAL_JUDGE_MODEL, label } })}\n`,
    );
    doneCount++;
    if (doneCount % 25 === 0) {
      console.log(`  ${doneCount}/${todo.length}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

// Aggregate in hypothesis-file order, like the reference.
const rows = hyps.map((h) => judged.get(h.question_id)).filter((j): j is Judged => j !== undefined);
const agg = aggregate(rows);
console.log("Accuracy:", agg.overall.accuracy);
for (const [type, t] of Object.entries(agg.byType)) {
  console.log(`\t${type}: ${t.accuracy} (${t.n})`);
}
console.log(`Task-averaged accuracy: ${agg.taskAveraged}`);
console.log(`Abstention accuracy: ${agg.abstention.accuracy} (${agg.abstention.n})`);
if (rows.length !== 500) {
  console.log(`NOTE: ${rows.length} questions scored; an official number needs all 500.`);
}
console.log(`Saved to ${resultPath}`);
