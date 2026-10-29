/**
 * PLAN-59 Phase 1 pilot: gain x need consolidation on forked stores.
 *
 *   node --no-warnings --import tsx benchmarks/plan59-phase1/run-pilot.mts \
 *     --snapshot <scratch>/snapshot.sqlite \
 *     --questions ~/.bitterbot/benchmarks/live-recall/plan59-questions.jsonl \
 *     [--partition <questions>.partition.json] [--seed 59] [--k 20] [--gain-cap 40] \
 *     [--min-cosurface 3] [--max-results 50] [--work-dir <scratch>/plan59-phase1] \
 *     [--out-dir benchmarks/plan59-phase1/results] [--keep]
 *
 * Stages: verify the sealed snapshot; development baseline on a fork;
 * candidate operations and co-surfacing qualification; need per family; gain
 * per operation on single-operation forks (development queries only);
 * priority; five arms, each on its own fork, scored on the qualification
 * partition; family-paired bootstrap contrasts. The final partition is never
 * read unless `--final --freeze <sha256>` names a protocol file marked
 * `status: frozen` (implemented, unused by the pilot).
 *
 * Output: `<out-dir>/<timestamp>.json` and `.md` with ids, hashes, ranks and
 * numbers only. Forks are deleted unless `--keep`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/io.js";
import { loadSqliteVecExtension } from "../../src/memory/sqlite-vec.js";
import {
  type ArmName,
  type ArmPlan,
  ARMS,
  buildArms,
  chooseK,
  type SelectionCost,
} from "./arms.js";
import {
  dbBytes,
  gitCommit,
  loadQuestions,
  type Question,
  refuseUnderBitterbotHome,
  removeDbFiles,
  round,
  sha256,
  sha256File,
  vacuumInto,
} from "./common.js";
import {
  affectedQueries,
  type ChunkNeedRow,
  COST_WEIGHTS,
  type DevBaseline,
  gainByFamily,
  NEED_HALF_LIFE_DAYS,
  type NeedBreakdown,
  needByFamily,
  operationNeed,
  type PriorityRow,
  priorityRow,
} from "./estimate.js";
import {
  EMBEDDING_MODEL,
  EmbeddingMemo,
  makeEmbedder,
  openFrozenStore,
  runQueries,
} from "./harness.js";
import {
  type ApplyResult,
  applyOperation,
  clusterDiagnostics,
  describeReembed,
  findBoundValidityCandidates,
  findClusterCandidates,
  hasTable,
  type Operation,
  type OperationCost,
  qualifyClusters,
  quotedCost,
} from "./operations.js";
import {
  assertFinalAllowed,
  familyHash,
  type FinalGate,
  type Partition,
  questionsIn,
} from "./partition.js";
import {
  type ArmSummary,
  familyMeans,
  pairedFamilyBootstrap,
  type PairedContrast,
  type QueryOutcome,
  reciprocal,
  summarize,
} from "./scoring.js";

const SCRATCH =
  "/tmp/claude-1000/-mnt-d-Bitterbot-bitterbot-desktop/50d3c3a2-52de-4c6c-b556-d6fde8b9c93d/scratchpad/plan59-phase1";

const { values: args } = parseArgs({
  options: {
    snapshot: { type: "string" },
    questions: { type: "string" },
    partition: { type: "string" },
    seed: { type: "string", default: "59" },
    k: { type: "string", default: "20" },
    "gain-cap": { type: "string", default: "40" },
    "min-cosurface": { type: "string", default: "3" },
    /** stop before the arms when fewer clusters qualify (the brief's floor is 5) */
    "min-qualified": { type: "string", default: "5" },
    "max-results": { type: "string", default: "50" },
    "work-dir": { type: "string", default: SCRATCH },
    "out-dir": { type: "string", default: "benchmarks/plan59-phase1/results" },
    protocol: { type: "string", default: "benchmarks/plan59-phase1/protocol.frozen.md" },
    final: { type: "boolean", default: false },
    freeze: { type: "string" },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});
if (!args.snapshot || !args.questions) {
  throw new Error("usage: --snapshot <sealed.sqlite> --questions <jsonl> [options]");
}

const seed = String(args.seed);
const kMax = Number(args.k);
const gainCap = Number(args["gain-cap"]);
const maxResults = Number(args["max-results"]);
const workDir = resolve(args["work-dir"]!);
const outDir = resolve(args["out-dir"]!);
refuseUnderBitterbotHome(workDir, "the work dir");
refuseUnderBitterbotHome(outDir, "results");
mkdirSync(join(workDir, "forks"), { recursive: true });
mkdirSync(outDir, { recursive: true });
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const wallStart = performance.now();

// ── 0. sealed snapshot, questions, partition ──
const snapshotPath = resolve(args.snapshot);
const manifestPath = `${snapshotPath}.manifest.json`;
if (!existsSync(manifestPath)) {
  throw new Error(`no manifest beside the snapshot (${manifestPath}); run snapshot.mts first`);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  sha256: string;
  createdAt: string;
  chunks: number;
  bytes: number;
};
const snapshotSha = sha256File(snapshotPath);
if (snapshotSha !== manifest.sha256) {
  throw new Error("snapshot sha256 does not match its manifest; the seal is broken");
}
const NOW = Date.parse(manifest.createdAt);
const { questions, raw: questionsRaw } = loadQuestions(resolve(args.questions));
const questionsSha = sha256(questionsRaw);
const partitionPath = resolve(args.partition ?? `${resolve(args.questions)}.partition.json`);
const partitionRaw = readFileSync(partitionPath, "utf-8");
const partition = JSON.parse(partitionRaw) as Partition;
if (partition.questionsSha256 !== questionsSha) {
  throw new Error("partition was cut from a different question file");
}
let finalGate: FinalGate | undefined;
if (args.final) {
  finalGate = assertFinalAllowed({
    final: true,
    freeze: args.freeze,
    protocolPath: resolve(args.protocol!),
  });
}
const devQuestions = questionsIn("development", questions, partition, {
  questionsSha256: questionsSha,
});
const scoredSplit = finalGate ? "final" : "qualification";
const scoredQuestions = questionsIn(scoredSplit, questions, partition, {
  questionsSha256: questionsSha,
  finalGate,
});
const fh = (path: string) => familyHash(seed, path);
log(
  `snapshot ${snapshotSha.slice(0, 12)} (${manifest.chunks} chunks), questions ${questionsSha.slice(0, 12)}: ` +
    `${devQuestions.length} development, ${scoredQuestions.length} ${scoredSplit}`,
);

// ── keys, embedder ──
const liveConfig = loadConfig();
const openai = await resolveApiKeyForProvider({ provider: "openai", cfg: liveConfig });
if (!openai?.apiKey) {
  throw new Error("no OpenAI key resolvable through the normal auth path");
}
const apiKey = openai.apiKey;
const memo = new EmbeddingMemo();
const embed = await makeEmbedder({ liveConfig, apiKey, memo });

// ── forks ──
let forkSeq = 0;
let forkCount = 0;
let forkMsTotal = 0;
function fork(name: string): string {
  const path = join(workDir, "forks", `${String(++forkSeq).padStart(3, "0")}-${name}.sqlite`);
  removeDbFiles(path);
  const r = vacuumInto(snapshotPath, path);
  forkCount += 1;
  forkMsTotal += r.ms;
  return path;
}
function discard(path: string): void {
  if (!args.keep) {
    removeDbFiles(path);
  }
}
async function openForOps(path: string): Promise<DatabaseSync> {
  const db = new DatabaseSync(path, { allowExtension: true });
  const vec = await loadSqliteVecExtension({ db });
  if (!vec.ok) {
    db.close();
    throw new Error(`sqlite-vec failed to load for the fork: ${vec.error}`);
  }
  return db;
}
let searchCount = 0;
async function score(
  storePath: string,
  agentId: string,
  qs: readonly Question[],
  label: string,
): Promise<QueryOutcome[]> {
  const store = await openFrozenStore({ storePath, workDir, agentId, apiKey, maxResults, memo });
  try {
    const out = await runQueries({
      store,
      storePath,
      questions: qs,
      now: NOW,
      maxResults,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) log(`  ${label}: ${done}/${total}`);
      },
    });
    searchCount += out.length;
    return out;
  } finally {
    await store.close();
  }
}

// ── 1. development baseline ──
log("development baseline");
const tDev = performance.now();
const devForkPath = fork("dev-baseline");
const devOutcomes = await score(devForkPath, "p59-dev", devQuestions, "dev baseline");
discard(devForkPath);
const devBaseline: DevBaseline[] = devOutcomes.map((o) => ({
  chunkId: o.chunkId,
  family: o.family,
  fusedRank: o.mappedRank,
  topTenIds: o.topTenIds,
}));
const devSummary = summarize(devOutcomes);
log(
  `  dev baseline MRR ${devSummary.mrr.toFixed(3)} R@5 ${(100 * devSummary.r5).toFixed(1)}% in ${((performance.now() - tDev) / 1000).toFixed(0)} s`,
);

// ── 2. snapshot facts for need and candidates (read-only) ──
const snap = new DatabaseSync(snapshotPath, { readOnly: true });
const chunkRows = snap
  .prepare(`SELECT id, path, access_count, last_accessed_at, created_at FROM chunks`)
  .all() as unknown as Array<{
  id: string;
  path: string;
  access_count: number | null;
  last_accessed_at: number | null;
  created_at: number | null;
}>;
const chunkFamily = new Map(chunkRows.map((r) => [r.id, r.path]));
const needRows: ChunkNeedRow[] = chunkRows.map((r) => ({
  id: r.id,
  path: r.path,
  accessCount: Number(r.access_count ?? 0),
  lastAccessedAt: r.last_accessed_at,
  createdAt: r.created_at,
}));
const retrievalHits = hasTable(snap, "retrieval_hits")
  ? (snap.prepare(`SELECT chunk_id, created_at FROM retrieval_hits`).all() as unknown as Array<{
      chunk_id: string;
      created_at: number;
    }>)
  : [];
const reembed = describeReembed(snap, EMBEDDING_MODEL);
const clusterCandidatesAll = findClusterCandidates(snap);
const boundValidity = findBoundValidityCandidates(snap);
snap.close();

const topFives = devBaseline.map((q) => q.topTenIds.slice(0, 5));
let coSurfaceBar = Number(args["min-cosurface"]);
let clusters = qualifyClusters(clusterCandidatesAll, topFives, coSurfaceBar);
let coSurfaceLowered = false;
if (clusters.length < 8 && coSurfaceBar > 2) {
  coSurfaceBar = 2;
  coSurfaceLowered = true;
  clusters = qualifyClusters(clusterCandidatesAll, topFives, coSurfaceBar);
}
log(
  `candidates: ${clusterCandidatesAll.length} clusters (${clusters.length} co-surface at >= ${coSurfaceBar} dev queries` +
    `${coSurfaceLowered ? ", bar lowered from 3" : ""}), ${boundValidity.length} bound_validity; re-embed ${reembed.applicable ? "applicable" : "not applicable"}`,
);

const need = needByFamily({
  chunks: needRows,
  devBaseline,
  chunkFamily,
  now: NOW,
  retrievalHits: retrievalHits.map((r) => ({
    chunkId: r.chunk_id,
    createdAt: Number(r.created_at),
  })),
});
const needOf = (op: Operation) => operationNeed(op, need);

const resultBase = {
  gitCommit: gitCommit(),
  ranAt: new Date().toISOString(),
  frozenNow: new Date(NOW).toISOString(),
  snapshot: { sha256: snapshotSha, chunks: manifest.chunks, bytes: manifest.bytes },
  questions: {
    sha256: questionsSha,
    n: questions.length,
    partitionSha256: sha256(partitionRaw),
    partitionSeed: partition.seed,
    counts: partition.counts,
    scoredSplit,
  },
  settings: {
    seed,
    kMax,
    gainCap,
    maxResults,
    coSurfaceBar,
    coSurfaceLowered,
    minQualified: Number(args["min-qualified"]),
    needHalfLifeDays: NEED_HALF_LIFE_DAYS,
    costWeights: COST_WEIGHTS,
    embeddingModel: EMBEDDING_MODEL,
    recencyBoost: false,
    hormonal: false,
    evidenceTelemetry: "off",
    bootstrapResamples: 2000,
  },
  developmentBaseline: devSummary,
  candidates: {
    clustersTotal: clusterCandidatesAll.length,
    clustersQualified: clusters.length,
    boundValidity: boundValidity.length,
    retrievalHitsRows: retrievalHits.length,
    reembed,
  },
};

const minQualified = Number(args["min-qualified"]);
const diagnostics = clusterDiagnostics(clusterCandidatesAll, devBaseline);
const devPerQuery = devOutcomes.map((o) => ({
  chunkId: o.chunkId,
  familyHash: fh(o.family),
  fusedRank: o.mappedRank,
  channelRanks: o.channelRanks,
  topTenIds: o.topTenIds,
  latencyMs: round(o.latencyMs, 1),
}));
const boundValidityDiagnostics = {
  operations: boundValidity.length,
  evidenceChunks: boundValidity.reduce((s, o) => s + o.chunkIds.length, 0),
  withAffectedDevQueries: boundValidity.filter((o) => affectedQueries(o, devBaseline).length > 0)
    .length,
};
const accountingSoFar = () => ({
  forks: forkCount,
  forkMsTotal: round(forkMsTotal, 0),
  searches: searchCount,
  embeddingCalls: memo.calls,
  distinctEmbeddedTexts: memo.size,
  embeddedCharsTotal: memo.chars,
  embeddedTokensEstimate: Math.round(memo.chars / 4),
  embeddingDollarsEstimate: round((Math.round(memo.chars / 4) / 1e6) * 0.02, 4),
  elapsedSeconds: round((performance.now() - wallStart) / 1000, 1),
});
if (clusters.length < minQualified) {
  const negative = {
    ...resultBase,
    armsRun: false,
    reason: `fewer than ${minQualified} clusters co-surface at the ${coSurfaceBar}-query bar; arm run stopped`,
    clusterCoSurfaceCounts: qualifyClusters(clusterCandidatesAll, topFives, 1).map((c) => ({
      id: c.id,
      members: c.memberIds.length,
      coSurfaceQueries: c.coSurfaceQueries,
    })),
    clusterSizes: Object.fromEntries(
      [...new Set(clusterCandidatesAll.map((c) => c.memberIds.length))]
        .toSorted((a, b) => a - b)
        .map((n) => [n, clusterCandidatesAll.filter((c) => c.memberIds.length === n).length]),
    ),
    clusterFamilies: new Set(clusterCandidatesAll.flatMap((c) => c.families)).size,
    diagnostics,
    boundValidity: boundValidityDiagnostics,
    developmentPerQuery: devPerQuery,
    accounting: accountingSoFar(),
    snapshotIntact: sha256File(snapshotPath) === snapshotSha,
  };
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  writeFileSync(join(outDir, `${stamp}.json`), `${JSON.stringify(negative, null, 2)}\n`);
  const { developmentPerQuery: _perQuery, diagnostics: _diag, ...brief } = negative;
  console.log(JSON.stringify(brief, null, 2));
  if (!args.keep) {
    rmSync(join(workDir, "forks"), { recursive: true, force: true });
    rmSync(join(workDir, "workspace"), { recursive: true, force: true });
  }
  process.exit(0);
}

// ── 3. gain estimation on single-operation forks (development queries only) ──
const candidates: Operation[] = [...clusters, ...boundValidity];
const byNeed = [...candidates].toSorted((a, b) => needOf(b) - needOf(a) || (a.id < b.id ? -1 : 1));
const toEstimate = byNeed.slice(0, gainCap);
log(`gain estimation: ${toEstimate.length} of ${candidates.length} candidates (cap ${gainCap})`);
const tGain = performance.now();
const searchesBefore = searchCount;
const embedCallsBefore = memo.calls;
const forksBefore = forkCount;
const devRankBefore = new Map(devBaseline.map((q) => [q.chunkId, q.fusedRank]));
const priorities = new Map<string, PriorityRow>();
const estimationLog: Array<{
  opId: string;
  affectedQueries: number;
  forked: boolean;
  realizedCost: OperationCost | null;
  seconds: number;
}> = [];
for (let i = 0; i < toEstimate.length; i++) {
  const op = toEstimate[i]!;
  const t0 = performance.now();
  const affected = affectedQueries(op, devBaseline);
  let realized: OperationCost | null = null;
  let gain = new Map<string, number>();
  if (affected.length > 0) {
    const path = fork(`gain-${op.id}`);
    const db = await openForOps(path);
    let applied: ApplyResult;
    try {
      applied = await applyOperation(db, op, { embed, now: NOW });
    } finally {
      db.close();
    }
    realized = applied.cost;
    const after = await score(path, `p59-gain-${i}`, affected.map(toQuestion), `gain ${op.id}`);
    discard(path);
    const devRankAfter = new Map(after.map((o) => [o.chunkId, o.mappedRank]));
    gain = gainByFamily(affected, devRankBefore, devRankAfter);
  }
  const row = priorityRow({
    op,
    need,
    gain,
    cost: realized ?? quotedCost(op),
    affectedQueries: affected.length,
  });
  priorities.set(op.id, row);
  estimationLog.push({
    opId: op.id,
    affectedQueries: affected.length,
    forked: affected.length > 0,
    realizedCost: realized,
    seconds: round((performance.now() - t0) / 1000, 1),
  });
  log(
    `  ${i + 1}/${toEstimate.length} ${op.id}: ${affected.length} affected, benefit ${row.benefit.toFixed(3)}, priority ${row.priority.toFixed(4)}`,
  );
}
const estimationCost: SelectionCost = {
  forks: forkCount - forksBefore,
  searches: searchCount - searchesBefore,
  embeddingCalls: memo.calls - embedCallsBefore,
  seconds: round((performance.now() - tGain) / 1000, 1),
};
log(
  `gain estimation done in ${estimationCost.seconds} s (${estimationCost.forks} forks, ${estimationCost.searches} searches)`,
);

function toQuestion(q: DevBaseline): Question {
  const found = devQuestions.find((x) => x.chunkId === q.chunkId);
  if (!found) throw new Error(`development question ${q.chunkId} vanished`);
  return found;
}

// ── 4. arms ──
const k = chooseK(candidates.length, kMax);
const arms = buildArms({ candidates, k, seed, priorities, needOf, estimationCost });
type ArmResult = {
  arm: ArmName;
  operations: string[];
  applied: Array<{ opId: string; kind: Operation["kind"]; cost: OperationCost }>;
  totals: { chunksTouched: number; embeddingCalls: number; applyMs: number };
  selectionCost: SelectionCost;
  storage: { bytesDelta: number; chunksDelta: number; vecRowsDelta: number };
  summary: ArmSummary;
  outcomes: QueryOutcome[];
};
const armResults = {} as Record<ArmName, ArmResult>;
const snapshotBytes = dbBytes(snapshotPath);
const snapCounts = (() => {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  const chunks = Number((db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c: number }).c);
  db.close();
  return { chunks };
})();
for (const name of ARMS) {
  const plan: ArmPlan = arms[name];
  log(`arm ${name}: ${plan.operations.length} operations`);
  const path = fork(`arm-${name}`);
  const applied: ArmResult["applied"] = [];
  const db = await openForOps(path);
  let vecBefore = 0;
  try {
    vecBefore = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM chunks_vec`).get() as { c: number }).c,
    );
    for (const op of plan.operations) {
      const r = await applyOperation(db, op, { embed, now: NOW });
      applied.push({ opId: op.id, kind: op.kind, cost: r.cost });
    }
  } finally {
    db.close();
  }
  const after = new DatabaseSync(path, { allowExtension: true });
  await loadSqliteVecExtension({ db: after });
  const chunksAfter = Number(
    (after.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c: number }).c,
  );
  const vecAfter = Number(
    (after.prepare(`SELECT COUNT(*) AS c FROM chunks_vec`).get() as { c: number }).c,
  );
  after.close();
  const outcomes = await score(path, `p59-arm-${name}`, scoredQuestions, `arm ${name}`);
  const storage = {
    bytesDelta: dbBytes(path) - snapshotBytes,
    chunksDelta: chunksAfter - snapCounts.chunks,
    vecRowsDelta: vecAfter - vecBefore,
  };
  discard(path);
  const summary = summarize(outcomes);
  armResults[name] = {
    arm: name,
    operations: plan.operations.map((o) => o.id),
    applied,
    totals: {
      chunksTouched: applied.reduce((s, a) => s + a.cost.chunksTouched, 0),
      embeddingCalls: applied.reduce((s, a) => s + a.cost.embeddingCalls, 0),
      applyMs: round(
        applied.reduce((s, a) => s + a.cost.estimatedMs, 0),
        1,
      ),
    },
    selectionCost: plan.selectionCost,
    storage,
    summary,
    outcomes,
  };
  log(
    `  ${name}: MRR ${summary.mrr.toFixed(3)} (raw ${summary.rawMrr.toFixed(3)}) R@5 ${(100 * summary.r5).toFixed(1)}% cov@10 ${(100 * summary.coverage10).toFixed(1)}% wrong ${(100 * summary.wrongAnswerProxy).toFixed(1)}%`,
  );
}

// ── 5. contrasts (family is the inferential unit) ──
const rrMeans = (name: ArmName) =>
  familyMeans(armResults[name].outcomes, (o) => reciprocal(o.mappedRank));
const r5Means = (name: ArmName) =>
  familyMeans(armResults[name].outcomes, (o) =>
    o.mappedRank !== null && o.mappedRank <= 5 ? 1 : 0,
  );
const contrast = (a: ArmName, b: ArmName, metric: "mrr" | "r5"): PairedContrast =>
  pairedFamilyBootstrap(
    metric === "mrr" ? rrMeans(a) : r5Means(a),
    metric === "mrr" ? rrMeans(b) : r5Means(b),
    { resamples: 2000, seed: `${seed}:${a}-${b}:${metric}` },
  );
const contrasts = {
  primary: { name: "prioritised - recency, MRR", ...contrast("prioritised", "recency", "mrr") },
  secondary: {
    "prioritised - random, MRR": contrast("prioritised", "random", "mrr"),
    "prioritised - unchanged, MRR": contrast("prioritised", "unchanged", "mrr"),
    "recency - unchanged, MRR": contrast("recency", "unchanged", "mrr"),
    "random - unchanged, MRR": contrast("random", "unchanged", "mrr"),
    "shuffled_batch - prioritised, MRR": contrast("shuffled_batch", "prioritised", "mrr"),
    "prioritised - recency, R@5": contrast("prioritised", "recency", "r5"),
    "prioritised - unchanged, R@5": contrast("prioritised", "unchanged", "r5"),
  },
};

// ── 6. output: ids, hashes, ranks and numbers only ──
const opRecord = (op: Operation) => ({
  id: op.id,
  kind: op.kind,
  familyHashes: op.families.map(fh),
  chunkIds: op.kind === "consolidate_cluster" ? op.memberIds : op.chunkIds,
  ...(op.kind === "consolidate_cluster"
    ? {
        pairCount: op.pairCount,
        minSimilarity: round(op.minSimilarity),
        coSurfaceQueries: op.coSurfaceQueries,
      }
    : { factId: op.factId }),
  lastAccessedAt: op.lastAccessedAt,
  need: round(needOf(op), 3),
  quotedCost: quotedCost(op),
  priority: priorities.get(op.id)
    ? {
        ...priorities.get(op.id)!,
        gain: Object.fromEntries(
          Object.entries(priorities.get(op.id)!.gain).map(([fam, g]) => [fh(fam), round(g, 4)]),
        ),
      }
    : null,
});
const needOut: Record<string, NeedBreakdown> = {};
for (const [fam, b] of need) {
  if (b.total > 0) {
    needOut[fh(fam)] = {
      total: round(b.total, 3),
      accessPrior: round(b.accessPrior, 3),
      topFiveDemand: b.topFiveDemand,
      unsuccessful: b.unsuccessful,
      retrievalHits: round(b.retrievalHits, 3),
    };
  }
}
const embeddedTokensEstimate = Math.round(memo.chars / 4);
const result = {
  ...resultBase,
  armsRun: true,
  k,
  candidates: {
    ...resultBase.candidates,
    pool: candidates.length,
    estimated: toEstimate.length,
    operations: candidates.map(opRecord),
    diagnostics,
    boundValidity: boundValidityDiagnostics,
  },
  developmentPerQuery: devPerQuery,
  needByFamilyHash: needOut,
  estimation: { cost: estimationCost, log: estimationLog },
  arms: Object.fromEntries(
    ARMS.map((name) => {
      const a = armResults[name];
      return [
        name,
        {
          operations: a.operations,
          applied: a.applied.map((x) => ({
            ...x,
            cost: { ...x.cost, estimatedMs: round(x.cost.estimatedMs, 1) },
          })),
          totals: a.totals,
          selectionCost: a.selectionCost,
          storage: a.storage,
          summary: a.summary,
          perQuery: a.outcomes.map((o) => ({
            chunkId: o.chunkId,
            familyHash: fh(o.family),
            rawRank: o.rawRank,
            mappedRank: o.mappedRank,
            channelRanks: o.channelRanks,
            topOneSameFamily: o.topOneFamily === null ? null : o.topOneFamily === o.family,
            returned: o.returned,
            latencyMs: round(o.latencyMs, 1),
          })),
        },
      ];
    }),
  ),
  contrasts,
  accounting: {
    forks: forkCount,
    forkMsTotal: round(forkMsTotal, 0),
    searches: searchCount,
    embeddingCalls: memo.calls,
    distinctEmbeddedTexts: memo.size,
    embeddedCharsTotal: memo.chars,
    embeddedTokensEstimate,
    embeddingDollarsEstimate: round((embeddedTokensEstimate / 1e6) * 0.02, 4),
    elapsedSeconds: round((performance.now() - wallStart) / 1000, 1),
  },
  snapshotIntact: sha256File(snapshotPath) === snapshotSha,
};
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const jsonPath = join(outDir, `${stamp}.json`);
writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const ci = (c: PairedContrast) =>
  `${c.estimate >= 0 ? "+" : ""}${c.estimate.toFixed(4)} [${c.ci95[0].toFixed(4)}, ${c.ci95[1].toFixed(4)}] over ${c.families} families (${c.familiesUp} up, ${c.familiesDown} down)`;
const md = [
  `# PLAN-59 Phase 1 pilot, ${result.ranAt}`,
  "",
  `Commit ${result.gitCommit}; snapshot ${snapshotSha}; questions ${questionsSha}; partition ${result.questions.partitionSha256}.`,
  `Scored split: ${scoredSplit} (${scoredQuestions.length} questions, ${armResults.unchanged.summary.families} families). K = ${k}. Co-surfacing bar ${coSurfaceBar}${coSurfaceLowered ? " (lowered from 3)" : ""}.`,
  `Candidates: ${clusters.length} qualified clusters of ${clusterCandidatesAll.length}, ${boundValidity.length} bound_validity; ${toEstimate.length} estimated.`,
  "",
  "| arm | ops | chunks touched | embed calls | MRR (parent-mapped) | raw MRR | R@1 | R@5 | coverage@10 | wrong-answer proxy | latency p50 ms | storage delta MB |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...ARMS.map((name) => {
    const a = armResults[name];
    const s = a.summary;
    return `| ${name} | ${a.operations.length} | ${a.totals.chunksTouched} | ${a.totals.embeddingCalls} | ${s.mrr.toFixed(3)} | ${s.rawMrr.toFixed(3)} | ${pct(s.r1)} | ${pct(s.r5)} | ${pct(s.coverage10)} | ${pct(s.wrongAnswerProxy)} | ${s.latencyMs.p50.toFixed(0)} | ${(a.storage.bytesDelta / 1e6).toFixed(2)} |`;
  }),
  "",
  "Family-paired contrasts (mean over families, percentile bootstrap 95% interval, 2,000 seeded resamples):",
  "",
  `- primary, ${contrasts.primary.name}: ${ci(contrasts.primary)}`,
  ...Object.entries(contrasts.secondary).map(([name, c]) => `- ${name}: ${ci(c)}`),
  "",
  `Selection cost charged to prioritised and shuffled_batch: ${estimationCost.forks} forks, ${estimationCost.searches} searches, ${estimationCost.embeddingCalls} embedding calls, ${estimationCost.seconds} s.`,
  `Totals: ${forkCount} forks, ${searchCount} searches, ${memo.calls} embedding calls (about ${embeddedTokensEstimate} tokens, about $${result.accounting.embeddingDollarsEstimate}), ${result.accounting.elapsedSeconds} s wall. Snapshot intact: ${result.snapshotIntact}.`,
  "",
].join("\n");
writeFileSync(join(outDir, `${stamp}.md`), md);
console.log(md);
log(`wrote ${jsonPath}`);

if (!args.keep) {
  rmSync(join(workDir, "forks"), { recursive: true, force: true });
  rmSync(join(workDir, "workspace"), { recursive: true, force: true });
}
