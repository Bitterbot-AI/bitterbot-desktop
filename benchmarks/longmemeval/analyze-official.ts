/**
 * Dissect an official-protocol run: where the misses come from.
 *
 * Joins the hypothesis file, the judge output (`.eval-results-gpt-4o`), the
 * retrieval log (`.retrieval.jsonl`) and the reference data, and reports per
 * question type: accuracy, session recall at several k, how many misses had
 * every gold session inside the reader's context (a reading failure) versus
 * missing one (a retrieval failure), where the first missing gold session
 * ranked, and abstention behaviour (false abstentions on answerable
 * questions, missed abstentions on `_abs` ones). Output is JSON on stdout plus
 * a markdown table; nothing here touches the inference path.
 *
 *   node --import tsx benchmarks/longmemeval/analyze-official.ts --hyp <jsonl> [--k 10] [--ref data/longmemeval_s.json] [--samples 0]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isAbstentionId, QUESTION_TYPES, type RawItem } from "./official-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    hyp: { type: "string" },
    ref: { type: "string", default: join(__dirname, "data", "longmemeval_s.json") },
    k: { type: "string", default: "10" },
    /** Print this many wrong answers per type (question, expected, answer head) for reading. */
    samples: { type: "string", default: "0" },
  },
  strict: true,
});
if (!args.hyp) {
  throw new Error("--hyp <hypothesis.jsonl> is required");
}
const K = Number(args.k);
const samples = Number(args.samples);
const lines = (p: string) =>
  readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const ref = new Map(
  (JSON.parse(readFileSync(args.ref!, "utf-8")) as RawItem[]).map((r) => [r.question_id, r]),
);
const hyps = new Map(lines(args.hyp).map((h) => [h.question_id as string, h.hypothesis as string]));
const labels = new Map(
  lines(`${args.hyp}.eval-results-gpt-4o`).map((r) => [
    r.question_id as string,
    (r.autoeval_label as { label: boolean }).label,
  ]),
);
type Ret = { question_id: string; ranked: string[]; gold: string[]; abstention: boolean };
const retrieval = new Map(
  lines(`${args.hyp}.retrieval.jsonl`).map((r) => [r.question_id as string, r as unknown as Ret]),
);

const ABSTAIN_RE =
  /not enough information|no information|does not (contain|mention|provide)|doesn't (contain|mention|provide)|cannot (determine|find|answer)|can't (determine|find|answer)|unable to (determine|find|answer)|insufficient|not (available|mentioned|provided) in/i;

type Bucket = {
  n: number;
  correct: number;
  recallAll: Record<number, number>;
  recallAny: Record<number, number>;
  retrievalScored: number;
  wrongAllGoldInContext: number;
  wrongGoldMissing: number;
  missingGoldRanks: number[];
  falseAbstain: number;
  absN: number;
  absCorrect: number;
  hypChars: number[];
};
const KS = [1, 3, 5, 10, K].filter((v, i, a) => a.indexOf(v) === i).toSorted((a, b) => a - b);
const empty = (): Bucket => ({
  n: 0,
  correct: 0,
  recallAll: Object.fromEntries(KS.map((k) => [k, 0])),
  recallAny: Object.fromEntries(KS.map((k) => [k, 0])),
  retrievalScored: 0,
  wrongAllGoldInContext: 0,
  wrongGoldMissing: 0,
  missingGoldRanks: [],
  falseAbstain: 0,
  absN: 0,
  absCorrect: 0,
  hypChars: [],
});
const byType: Record<string, Bucket> = {};
const all = empty();
const wrongSamples: Record<
  string,
  Array<{ id: string; q: string; expected: string; got: string }>
> = {};

for (const [id, label] of labels) {
  const item = ref.get(id);
  const ret = retrieval.get(id);
  const hyp = hyps.get(id) ?? "";
  if (!item || !ret) continue;
  const b = (byType[item.question_type] ??= empty());
  for (const t of [b, all]) {
    t.n++;
    if (label) t.correct++;
    t.hypChars.push(hyp.length);
    const abstained = ABSTAIN_RE.test(hyp);
    if (isAbstentionId(id)) {
      t.absN++;
      if (label) t.absCorrect++;
    } else {
      if (abstained && !label) t.falseAbstain++;
      const gold = new Set(ret.gold);
      if (gold.size > 0) {
        t.retrievalScored++;
        for (const k of KS) {
          const top = new Set(ret.ranked.slice(0, k));
          const hit = [...gold].filter((g) => top.has(g)).length;
          if (hit > 0) t.recallAny[k]!++;
          if (hit === gold.size) t.recallAll[k]!++;
        }
        if (!label) {
          const topK = new Set(ret.ranked.slice(0, K));
          const missing = [...gold].filter((g) => !topK.has(g));
          if (missing.length === 0) {
            t.wrongAllGoldInContext++;
          } else {
            t.wrongGoldMissing++;
            for (const g of missing) {
              const r = ret.ranked.indexOf(g);
              t.missingGoldRanks.push(r < 0 ? -1 : r + 1);
            }
          }
        }
      }
    }
  }
  if (!label && samples > 0) {
    const list = (wrongSamples[item.question_type] ??= []);
    if (list.length < samples) {
      list.push({
        id,
        q: item.question,
        expected: String(item.answer),
        got: hyp.replaceAll(/\s+/g, " ").slice(0, 400),
      });
    }
  }
}

const pct = (a: number, b: number) => (b ? Number((a / b).toFixed(3)) : null);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const summarize = (b: Bucket) => ({
  n: b.n,
  accuracy: pct(b.correct, b.n),
  recall_all: Object.fromEntries(KS.map((k) => [k, pct(b.recallAll[k]!, b.retrievalScored)])),
  recall_any: Object.fromEntries(KS.map((k) => [k, pct(b.recallAny[k]!, b.retrievalScored)])),
  misses: {
    total: b.n - b.correct,
    reading: b.wrongAllGoldInContext,
    retrieval: b.wrongGoldMissing,
    abstention_items_wrong: b.absN - b.absCorrect,
    missing_gold_rank_median: median(b.missingGoldRanks.filter((r) => r > 0)),
    missing_gold_not_in_candidates: b.missingGoldRanks.filter((r) => r < 0).length,
  },
  false_abstentions: b.falseAbstain,
  abstention: { n: b.absN, correct: b.absCorrect },
  hypothesis_chars_median: median(b.hypChars),
});

const typeAccs = Object.values(byType).map((b) => b.correct / b.n);
const out = {
  hyp: args.hyp,
  k: K,
  overall: summarize(all),
  task_averaged: Number((typeAccs.reduce((a, c) => a + c, 0) / typeAccs.length).toFixed(4)),
  by_type: Object.fromEntries(
    QUESTION_TYPES.filter((t) => byType[t]).map((t) => [t, summarize(byType[t]!)]),
  ),
  ...(samples > 0 ? { wrong_samples: wrongSamples } : {}),
};
console.log(JSON.stringify(out, null, 2));

console.log(
  "\n| type | n | acc | recall_all@5 | recall_all@k | misses | reading | retrieval | false abstain |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
const row = (name: string, s: ReturnType<typeof summarize>) =>
  console.log(
    `| ${name} | ${s.n} | ${s.accuracy} | ${s.recall_all[5]} | ${s.recall_all[K]} | ${s.misses.total} | ${s.misses.reading} | ${s.misses.retrieval} | ${s.false_abstentions} |`,
  );
for (const [t, s] of Object.entries(out.by_type)) row(t, s);
row("overall", out.overall);
