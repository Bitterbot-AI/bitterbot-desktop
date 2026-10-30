/**
 * Fusion-weight sweep on the PLAN-59 Phase 1 partition.
 *
 * Captures one deep fused search per question from a frozen fork of a store
 * snapshot (the fused top N with every channel's own rank on each result),
 * then re-fuses offline with weighted RRF over a grid of channel weights and
 * RRF constants, through the production `rrfFuse`. Selection happens on the
 * development split only, confirmation on qualification (family-paired
 * bootstrap), and the final split stays sealed behind the Phase 1 partition
 * gate (`--final --freeze <sha256>` of a protocol file marked frozen).
 *
 * The capture holds chunk ids and file paths of private memory, so it is
 * written only under `~/.bitterbot/benchmarks/live-recall/` with mode 0600
 * and is never committed. The result file holds weights, hashes and numbers.
 *
 *   node --import tsx benchmarks/live-recall/fusion-sweep.mts \
 *     --snapshot <copy.sqlite> --questions ~/.bitterbot/benchmarks/live-recall/plan59-questions-<date>.jsonl \
 *     --capture ~/.bitterbot/benchmarks/live-recall/plan59-fusion-capture-<date>.json \
 *     --out benchmarks/live-recall/results/fusion-sweep-<date>.json [--max 200] [--now <epoch ms>]
 *
 * The capture is reused when it exists, so the grid can be changed and the
 * sweep re-run without another round of searches. Captures take about ten
 * seconds per question at 1,000 candidates per channel on a small box; a
 * partial capture is checkpointed every ten questions and resumed.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/io.js";
import { rrfFuse } from "../../src/memory/rrf.js";
import type { MemorySearchResult } from "../../src/memory/types.js";
import {
  gitCommit,
  isPrivateBenchmarkPath,
  loadQuestions,
  type Question,
  refuseUnderBitterbotHome,
  sha256,
  sha256File,
} from "../plan59-phase1/common.js";
import {
  EmbeddingMemo,
  makeIdResolver,
  openFrozenStore,
  parentMap,
} from "../plan59-phase1/harness.js";
import {
  assertFinalAllowed,
  type FinalGate,
  type Partition,
  questionsIn,
  type Split,
} from "../plan59-phase1/partition.js";
import { type Channel, CHANNELS, type RankedResult, rankOf } from "../plan59-phase1/scoring.js";

const { values: args } = parseArgs({
  options: {
    snapshot: { type: "string" },
    questions: { type: "string" },
    capture: { type: "string" },
    out: { type: "string" },
    max: { type: "string", default: "200" },
    now: { type: "string" },
    work: { type: "string" },
    final: { type: "boolean", default: false },
    freeze: { type: "string" },
    protocol: { type: "string" },
  },
  strict: true,
});
if (!args.snapshot || !args.questions || !args.capture || !args.out) {
  throw new Error(
    "usage: --snapshot <sqlite> --questions <jsonl> --capture <private json> --out <result json> [--max 200] [--now ms]",
  );
}
if (!isPrivateBenchmarkPath(args.capture)) {
  throw new Error(
    `the capture holds private paths; --capture must be under ~/.bitterbot/benchmarks/live-recall/ (got ${args.capture})`,
  );
}
refuseUnderBitterbotHome(args.out, "a sweep result");
const MAX = Math.max(1, Math.floor(Number(args.max)));

// ---- questions and partition ----------------------------------------------

type CapturedResult = {
  id: string | null;
  path: string;
  startLine: number;
  endLine: number;
  fusedRank: number;
  ch: Partial<Record<Channel, number>>;
};
type Capture = { chunkId: string; path: string; split: Split; results: CapturedResult[] };
type CaptureFile = {
  snapshotSha256?: string;
  questionsSha256: string;
  frozenNow: number;
  maxResults: number;
  gitCommit: string | null;
  captures: Capture[];
};

const { questions, raw } = loadQuestions(args.questions);
const qSha = sha256(raw);
const partition = JSON.parse(readFileSync(`${args.questions}.partition.json`, "utf8")) as Partition;
let finalGate: FinalGate | undefined;
if (args.final) {
  finalGate = assertFinalAllowed({
    final: true,
    freeze: args.freeze,
    protocolPath: args.protocol ?? join(dirname(args.out), "fusion-sweep.protocol.md"),
  });
}
const splits: Split[] = finalGate
  ? ["development", "qualification", "final"]
  : ["development", "qualification"];
const bySplit = new Map<Split, Question[]>(
  splits.map((s) => [
    s,
    questionsIn(s, questions, partition, { questionsSha256: qSha, finalGate }),
  ]),
);
const splitOf = new Map<string, Split>();
for (const [s, qs] of bySplit) {
  for (const q of qs) {
    splitOf.set(q.chunkId, s);
  }
}
const all = splits.flatMap((s) => bySplit.get(s)!);
const questionById = new Map(all.map((q) => [q.chunkId, q] as const));

// ---- capture (reused when present) ----------------------------------------

async function withRetries<T>(label: string, fn: () => Promise<T>, attempts = 30): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(
        `${label} failed (attempt ${attempt}): ${String((err as Error).message).slice(0, 120)}`,
      );
      await new Promise((r) => setTimeout(r, Math.min(60_000, 5_000 * 2 ** (attempt - 1))));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function writePrivate(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function capture(): Promise<CaptureFile> {
  if (existsSync(args.capture!)) {
    const existing = JSON.parse(readFileSync(args.capture!, "utf8")) as CaptureFile;
    if (existing.questionsSha256 !== qSha) {
      throw new Error("capture was made from a different question file (sha256 mismatch)");
    }
    const have = new Set(existing.captures.map((c) => c.chunkId));
    const missing = all.filter((q) => !have.has(q.chunkId));
    if (missing.length === 0) {
      console.error(`loaded ${existing.captures.length} captures from ${args.capture}`);
      return existing;
    }
    console.error(`capture lacks ${missing.length} questions (final split?); capturing them`);
    return await captureMissing(existing, missing);
  }
  return await captureMissing(null, all);
}

async function captureMissing(
  existing: CaptureFile | null,
  todo: Question[],
): Promise<CaptureFile> {
  const frozenNow = existing?.frozenNow ?? Number(args.now ?? Date.now());
  const maxResults = existing?.maxResults ?? MAX;
  const liveConfig = loadConfig();
  const key = await resolveApiKeyForProvider({ provider: "openai", cfg: liveConfig });
  if (!key?.apiKey) {
    throw new Error("no OpenAI key resolvable (embeddings)");
  }
  const memo = new EmbeddingMemo();
  const workDir = args.work ?? mkdtempSync(join(tmpdir(), "fusion-sweep-"));
  refuseUnderBitterbotHome(workDir, "a work directory");
  mkdirSync(workDir, { recursive: true });
  const store = await openFrozenStore({
    storePath: args.snapshot!,
    workDir,
    agentId: "fusion-sweep",
    apiKey: key.apiKey,
    maxResults,
    memo,
  });
  const reader = new DatabaseSync(args.snapshot!, { readOnly: true });
  const resolve = makeIdResolver(reader);
  const partialPath = `${args.capture}.partial`;
  const caps: Capture[] = existing?.captures ? [...existing.captures] : [];
  if (!existing && existsSync(partialPath)) {
    caps.push(...(JSON.parse(readFileSync(partialPath, "utf8")) as CaptureFile).captures);
    console.error(`resuming: ${caps.length} captures already on disk`);
  }
  const done = new Set(caps.map((c) => c.chunkId));
  const realNow = Date.now;
  Date.now = () => frozenNow;
  const t0 = performance.now();
  try {
    let n = 0;
    for (const q of todo) {
      if (done.has(q.chunkId)) {
        continue;
      }
      const results = await withRetries(`search ${q.chunkId.slice(0, 8)}`, () =>
        store.manager.search(q.question, {
          maxResults,
          now: frozenNow,
          observe: false,
          caller: "plan59_fusion_sweep",
        }),
      );
      caps.push({
        chunkId: q.chunkId,
        path: q.path,
        split: splitOf.get(q.chunkId)!,
        results: results.map((r: MemorySearchResult, idx) => {
          const ch: Partial<Record<Channel, number>> = {};
          for (const c of CHANNELS) {
            const rk = r.channels?.[c]?.rank;
            if (typeof rk === "number") {
              ch[c] = rk;
            }
          }
          return {
            id: resolve(r),
            path: r.path,
            startLine: r.startLine,
            endLine: r.endLine,
            fusedRank: idx + 1,
            ch,
          };
        }),
      });
      n += 1;
      if (caps.length % 10 === 0) {
        writePrivate(
          partialPath,
          JSON.stringify({
            questionsSha256: qSha,
            frozenNow,
            maxResults,
            gitCommit: null,
            captures: caps,
          }),
        );
      }
      if (n % 25 === 0) {
        console.error(
          `${n}/${todo.length} captured, ${Math.round((performance.now() - t0) / 1000)} s, embed calls ${memo.calls}`,
        );
      }
    }
  } finally {
    Date.now = realNow;
    reader.close();
    await store.close();
  }
  const file: CaptureFile = {
    snapshotSha256: sha256File(args.snapshot!),
    questionsSha256: qSha,
    frozenNow,
    maxResults,
    gitCommit: gitCommit(),
    captures: caps,
  };
  writePrivate(args.capture!, JSON.stringify(file));
  console.error(`capture written (${caps.length} questions) to ${args.capture}`);
  return file;
}

const captured = await capture();
const caps = captured.captures.filter((c) => splitOf.has(c.chunkId));

// ---- offline re-fusion through the production rrfFuse ---------------------

const reader = new DatabaseSync(args.snapshot, { readOnly: true });
const parents = parentMap(reader);
reader.close();

type Weights = { v: number; k: number; g: number; rrfK: number };
const asList = (cap: Capture, channel: Channel, weight: number) => ({
  name: channel,
  weight,
  entries: cap.results
    .filter((r) => r.ch[channel] !== undefined)
    .map((r) => ({ id: String(r.fusedRank), rank: r.ch[channel]!, payload: r })),
});

/** Re-fuse one capture's per-channel ranks; ties broken by the live fused rank. */
function fuse(cap: Capture, w: Weights): CapturedResult[] {
  const fused = rrfFuse(
    [asList(cap, "vector", w.v), asList(cap, "keyword", w.k), asList(cap, "graph", w.g)],
    w.rrfK,
  );
  return fused
    .toSorted((a, b) => b.score - a.score || a.payload.fusedRank - b.payload.fusedRank)
    .map((f) => f.payload);
}

function goldRank(cap: Capture, ranked: CapturedResult[]): number | null {
  const q = questionById.get(cap.chunkId);
  if (!q) {
    throw new Error(`no question for ${cap.chunkId}`);
  }
  const parentId = parents.get(cap.chunkId) ?? null;
  return rankOf(ranked as RankedResult[], q, parentId).mapped;
}

type Metrics = { n: number; mrr: number; r1: number; r5: number; cov10: number };
function metrics(ranks: Array<number | null>): Metrics {
  const n = ranks.length;
  const share = (pred: (r: number | null) => boolean) =>
    +(ranks.filter(pred).length / n).toFixed(4);
  return {
    n,
    mrr: +(ranks.reduce((a: number, r) => a + (r ? 1 / r : 0), 0) / n).toFixed(4),
    r1: share((r) => r === 1),
    r5: share((r) => r !== null && r <= 5),
    cov10: share((r) => r !== null && r <= 10),
  };
}

type Setting = Weights | "live" | "keyword";
function evalSetting(capsIn: Capture[], w: Setting) {
  const ranks = capsIn.map((c) => {
    if (w === "live") {
      return goldRank(c, c.results);
    }
    if (w === "keyword") {
      return goldRank(c, fuse(c, { v: 0, k: 1, g: 0, rrfK: 60 }));
    }
    return goldRank(c, fuse(c, w));
  });
  return { m: metrics(ranks), ranks };
}

const UNWEIGHTED: Weights = { v: 1, k: 1, g: 1, rrfK: 60 };
const devCaps = caps.filter((c) => c.split === "development");
const qualCaps = caps.filter((c) => c.split === "qualification");
const finalCaps = caps.filter((c) => c.split === "final");

const grid: Weights[] = [];
for (const v of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
  for (const g of [0, 0.5, 1]) {
    for (const rrfK of [5, 15, 30, 60]) {
      grid.push({ v, k: 1, g, rrfK });
    }
  }
}
const devTable = grid
  .map((w) => ({ w, ...evalSetting(devCaps, w).m }))
  .toSorted((a, b) => b.mrr - a.mrr || b.r5 - a.r5);
const best = devTable[0]!;

// Family-paired bootstrap over qualification (the family is the gold path).
function familyRR(
  capsIn: Capture[],
  ranks: Array<number | null>,
): Array<readonly [string, number]> {
  const m = new Map<string, number[]>();
  capsIn.forEach((c, i) => {
    const a = m.get(c.path) ?? [];
    a.push(ranks[i] ? 1 / ranks[i]! : 0);
    m.set(c.path, a);
  });
  return [...m.entries()].map(([f, xs]) => [f, xs.reduce((a, b) => a + b, 0) / xs.length] as const);
}
function pairedBoot(
  capsIn: Capture[],
  a: Array<number | null>,
  b: Array<number | null>,
  seed = 59,
  B = 2000,
) {
  const fa = familyRR(capsIn, a);
  const fb = familyRR(capsIn, b);
  const d = fa.map(([, x], i) => x - fb[i]![1]);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const means: number[] = [];
  for (let i = 0; i < B; i++) {
    let t = 0;
    for (let j = 0; j < d.length; j++) {
      t += d[Math.floor(rnd() * d.length)]!;
    }
    means.push(t / d.length);
  }
  means.sort((x, y) => x - y);
  return {
    families: d.length,
    meanDiff: +(d.reduce((x, y) => x + y, 0) / d.length).toFixed(4),
    ci95: [
      +means[Math.floor(B * 0.025)]!.toFixed(4),
      +means[Math.floor(B * 0.975)]!.toFixed(4),
    ] as const,
  };
}

const confirm = (capsIn: Capture[]) => {
  const qBest = evalSetting(capsIn, best.w);
  const qLive = evalSetting(capsIn, "live");
  const qCur = evalSetting(capsIn, UNWEIGHTED);
  const qKw = evalSetting(capsIn, "keyword");
  return {
    n: capsIn.length,
    liveFused: qLive.m,
    currentUnweightedRrf60: qCur.m,
    keywordOnly: qKw.m,
    best: { w: best.w, ...qBest.m },
    pairedFamilyBootstrap: {
      bestMinusLive: pairedBoot(capsIn, qBest.ranks, qLive.ranks),
      bestMinusUnweighted: pairedBoot(capsIn, qBest.ranks, qCur.ranks),
      bestMinusKeyword: pairedBoot(capsIn, qBest.ranks, qKw.ranks),
      keywordMinusLive: pairedBoot(capsIn, qKw.ranks, qLive.ranks),
    },
  };
};

// Vector weight against keyword 1 and graph 1 at k 60: the one-dimensional
// view the real-query replay compares against.
const vectorLadder = (capsIn: Capture[]) =>
  [0, 0.1, 0.25, 0.5, 0.75, 1].map((v) => ({
    w: { v, k: 1, g: 1, rrfK: 60 },
    ...evalSetting(capsIn, { v, k: 1, g: 1, rrfK: 60 }).m,
  }));

const absent = (capsIn: Capture[]) => capsIn.filter((c) => goldRank(c, c.results) === null).length;
const out = {
  ranAt: new Date().toISOString(),
  gitCommit: gitCommit(),
  snapshotSha256: captured.snapshotSha256 ?? sha256File(args.snapshot),
  questionsSha256: qSha,
  frozenNow: captured.frozenNow,
  maxResults: captured.maxResults,
  fusion: "src/memory/rrf.ts rrfFuse, weight / (k + rank), ties by live fused rank",
  caveat:
    `channel lists are the per-channel ranks of the chunks inside the live fused top-${captured.maxResults}; ` +
    "gold chunks outside that list are unrecoverable here",
  goldAbsentFromCapture: {
    development: absent(devCaps),
    qualification: absent(qualCaps),
    ...(finalGate ? { final: absent(finalCaps) } : {}),
  },
  development: {
    n: devCaps.length,
    liveFused: evalSetting(devCaps, "live").m,
    currentUnweightedRrf60: evalSetting(devCaps, UNWEIGHTED).m,
    keywordOnly: evalSetting(devCaps, "keyword").m,
    best,
    top10: devTable.slice(0, 10),
    worst3: devTable.slice(-3),
  },
  qualification: confirm(qualCaps),
  vectorLadderK60: {
    development: vectorLadder(devCaps),
    qualification: vectorLadder(qualCaps),
  },
  ...(finalGate
    ? { final: { protocolSha256: finalGate.protocolSha256, ...confirm(finalCaps) } }
    : {}),
};
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));
