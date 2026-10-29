/**
 * PLAN-59 Phase 1: cut the question file into development / qualification /
 * final by family (see partition.ts).
 *
 *   node --no-warnings --import tsx benchmarks/plan59-phase1/partition.mts \
 *     --questions ~/.bitterbot/benchmarks/live-recall/plan59-questions.jsonl --seed 59
 *
 * Writes `<questions>.partition.json` beside the question file: chunk ids,
 * family hashes, the seed and counts. No path or question text. The file is
 * private like the question file and is written with mode 0600.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isPrivateBenchmarkPath, isUnderBitterbotHome, loadQuestions, sha256 } from "./common.js";
import { partitionQuestions } from "./partition.js";

const { values: args } = parseArgs({
  options: {
    questions: { type: "string" },
    seed: { type: "string", default: "59" },
    out: { type: "string" },
  },
  strict: true,
});
if (!args.questions) {
  throw new Error("usage: --questions <jsonl> [--seed S] [--out <partition.json>]");
}
const questionsPath = resolve(args.questions);
const out = resolve(args.out ?? `${questionsPath}.partition.json`);
if (isUnderBitterbotHome(out) && !isPrivateBenchmarkPath(out)) {
  throw new Error(`refusing to write under ~/.bitterbot outside benchmarks/live-recall: ${out}`);
}
const { questions, raw } = loadQuestions(questionsPath);
const partition = partitionQuestions(questions, {
  seed: String(args.seed),
  questionsSha256: sha256(raw),
});
writeFileSync(out, `${JSON.stringify(partition, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      out,
      seed: partition.seed,
      questionsSha256: partition.questionsSha256,
      partitionSha256: sha256(JSON.stringify(partition)),
      counts: partition.counts,
    },
    null,
    2,
  ),
);
