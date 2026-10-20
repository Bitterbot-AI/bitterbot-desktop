/**
 * Re-grade every result row with the current judge.
 *
 * Needed once: the first run judged with max_tokens 5, which cut Sonnet 5 off
 * on 12% of calls, and a cut-off reply was scored "wrong". The negative-probe
 * rubric also scored a correct "No" as a hallucination. This pass re-applies
 * the deterministic fast path and, where it has no verdict, the fixed judge
 * (negative probes use NEGATIVE_JUDGE_PROMPT). Answers are untouched.
 *
 *   node --import tsx benchmarks/compaction-policy/rejudge.ts [--root <dir>]
 *
 * Resumable: writes <root>/results.rejudged.jsonl incrementally and skips rows
 * already present. Prints accuracy and hallucination per model and arm before
 * and after, and the number of rows whose verdict changed.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const REAL_STATE_DIR =
  process.env.BITTERBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".bitterbot");
const args = parseArgs({ options: { root: { type: "string" } } });
const ROOT = args.values.root ?? path.join(REAL_STATE_DIR, "eval", "compaction");
process.env.BITTERBOT_STATE_DIR = path.join(ROOT, "state");

const { resolveApiKeyForProvider } = await import("../../src/agents/model-auth.js");
const { loadConfig } = await import("../../src/config/io.js");
const { initClient, Spend } = await import("./llm.js");
const { judge, scoreOf } = await import("./judge.js");
type ResultRow = import("./report.js").ResultRow;
type Probe = import("./probes.js").Probe;

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

const cfg = loadConfig();
const auth = await resolveApiKeyForProvider({
  provider: "anthropic",
  cfg,
  agentDir: path.join(REAL_STATE_DIR, "agents", "main", "agent"),
});
initClient(auth.apiKey ?? "");
const spend = new Spend();

const OUT = path.join(ROOT, "results.rejudged.jsonl");
const rows = await readJsonl<ResultRow>(path.join(ROOT, "results.jsonl"));
const probes = new Map(
  (await readJsonl<Probe>(path.join(ROOT, "probes.jsonl"))).map((p) => [p.probeId, p]),
);
const keyOf = (r: ResultRow) => `${r.model}|${r.arm}|${r.probeId}`;
const done = new Map((await readJsonl<ResultRow>(OUT)).map((r) => [keyOf(r), r]));

let changed = 0;
let failed = 0;
for (const r of rows) {
  if (done.has(keyOf(r))) {
    continue;
  }
  const probe = probes.get(r.probeId);
  let next: ResultRow = r;
  if (probe && !r.error) {
    const { verdict, judged } = await judge({
      probe,
      answer: r.answer,
      spend,
      feature: "eval/compaction/rejudge",
    });
    const score = scoreOf(probe, verdict);
    if (judged === "llm-failed") {
      failed++;
    }
    if (
      verdict !== r.verdict ||
      score.correct !== r.correct ||
      score.hallucinated !== r.hallucinated
    ) {
      changed++;
    }
    next = {
      ...r,
      verdict,
      judged: judged === "fast" ? "fast" : "llm",
      correct: score.correct,
      hallucinated: score.hallucinated,
    };
  }
  await fs.appendFile(OUT, `${JSON.stringify(next)}\n`);
  done.set(keyOf(next), next);
}

const summarize = (rs: ResultRow[]) => {
  const groups = new Map<string, ResultRow[]>();
  for (const r of rs) {
    const k = `${r.model} arm${r.arm}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return groups;
};
const before = summarize(rows);
const after = summarize([...done.values()]);
const fmt = (rs: ResultRow[]) => {
  const nn = rs.filter((r) => r.probeType !== "negative");
  const neg = rs.filter((r) => r.probeType === "negative");
  const acc = nn.reduce((a, r) => a + r.correct, 0) / Math.max(1, nn.length);
  const hal = neg.reduce((a, r) => a + r.hallucinated, 0) / Math.max(1, neg.length);
  return `acc ${(100 * acc).toFixed(1)}% (n=${nn.length}) halluc ${(100 * hal).toFixed(1)}% (n=${neg.length})`;
};
for (const k of [...before.keys()].toSorted()) {
  console.log(`${k}: ${fmt(before.get(k)!)}  ->  ${fmt(after.get(k) ?? [])}`);
}
console.log(
  `rows ${rows.length}, verdict changed ${changed}, judge failures ${failed}, rejudge spend $${spend.total.toFixed(2)}`,
);
process.exit(0);
