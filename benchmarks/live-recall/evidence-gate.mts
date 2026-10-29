/**
 * PLAN-59 Phase 0 engineering gate: evidence telemetry against a copy of a real store.
 *
 * Never touches the live database. `--copy-from` opens the live file READ-ONLY
 * and takes a `VACUUM INTO` snapshot under the gate work dir; `--db` points at
 * an existing copy. Any `--db` path under ~/.bitterbot is refused.
 *
 * Measures and prints (JSON + a markdown table):
 *   1. migration wall time on the copy (v78 -> v79 on a 2026-10 store);
 *   2. search wall time p50/p95 with evidence mode `off` vs `observe`, the same
 *      real queries, `--reps` repetitions each, interleaved per query;
 *   3. observation neutrality: the ordered chunk-id list is identical between
 *      the two modes for every query and repetition (hard fail otherwise);
 *   4. rows written == min(topK, returned) per observe search; zero rows after
 *      the off-mode pass;
 *   5. prune removes rows older than retention and leaves newer ones;
 *   6. stats() matches COUNT(*).
 *
 * Queries: a jsonl file with a `query` (journal replay, extract-journal-queries.mts)
 * or `question` (make-questions.mts) field per line, loaded exactly as run.mts
 * and replay-judge.mts load theirs. The file is private; only counts, hashes,
 * ranks and timings leave this script.
 *
 *   node --import tsx benchmarks/live-recall/evidence-gate.mts \
 *     --copy-from ~/.bitterbot/memory/main.sqlite \
 *     --queries ~/.bitterbot/benchmarks/live-recall/journal-queries-2026-10-27.jsonl \
 *     --reps 3 [--max-results 10] [--out <json>] [--work-dir <dir>] [--keep]
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import { loadConfig } from "../../src/config/io.js";
import { EvidenceTelemetry } from "../../src/memory/evidence-telemetry.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";
import { runMigrations } from "../../src/memory/migrations.js";
import type { MemorySearchResult } from "../../src/memory/types.js";

const DEFAULT_WORK_DIR =
  "/tmp/claude-1000/-mnt-d-Bitterbot-bitterbot-desktop/50d3c3a2-52de-4c6c-b556-d6fde8b9c93d/scratchpad/plan59-gate";

const { values: args } = parseArgs({
  options: {
    "copy-from": { type: "string" },
    db: { type: "string" },
    queries: { type: "string" },
    reps: { type: "string", default: "3" },
    "max-results": { type: "string", default: "10" },
    "top-k": { type: "string", default: "10" },
    out: { type: "string" },
    "work-dir": { type: "string", default: DEFAULT_WORK_DIR },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});

if ((!args["copy-from"] && !args.db) || !args.queries) {
  throw new Error(
    "usage: (--copy-from <live sqlite> | --db <copy>) --queries <jsonl> [--reps 3] [--max-results 10]",
  );
}
const reps = Math.max(1, Number(args.reps));
const maxResults = Number(args["max-results"]);
const topK = Number(args["top-k"]);
const workDir = resolve(args["work-dir"]!);
mkdirSync(workDir, { recursive: true });

const bitterbotHome = resolve(join(homedir(), ".bitterbot"));
const underHome = (p: string) =>
  resolve(p).startsWith(`${bitterbotHome}/`) || resolve(p) === bitterbotHome;
if (args.db && underHome(args.db)) {
  throw new Error(
    `refusing to operate on ${args.db}: paths under ~/.bitterbot are never written by the gate`,
  );
}
if (resolve(workDir).startsWith(`${bitterbotHome}/`)) {
  throw new Error(`refusing a work dir under ~/.bitterbot`);
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const ms = (x: number) => Number(x.toFixed(2));
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
function gitCommit(): string | null {
  try {
    const head = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", {
      encoding: "utf-8",
    }).trim();
    return dirty ? `${head}+dirty` : head;
  } catch {
    return null;
  }
}

// ── 0. snapshot ──
let copyPath: string;
let snapshotMs: number | null = null;
if (args["copy-from"]) {
  const src = resolve(args["copy-from"]);
  copyPath = join(workDir, `store-copy-${Date.now()}.sqlite`);
  if (existsSync(copyPath)) {
    rmSync(copyPath);
  }
  const t0 = performance.now();
  const ro = new DatabaseSync(src, { readOnly: true });
  try {
    ro.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
  } finally {
    ro.close();
  }
  snapshotMs = performance.now() - t0;
  console.log(`snapshot: ${(statSync(copyPath).size / 1e6).toFixed(1)} MB in ${ms(snapshotMs)} ms`);
} else {
  copyPath = resolve(args.db!);
}
const copySizeMb = Number((statSync(copyPath).size / 1e6).toFixed(1));

// ── 1. migration wall time ──
const migDb = new DatabaseSync(copyPath);
const before = (
  migDb.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
)?.value;
const tMig = performance.now();
const mig = runMigrations(migDb);
const migrationMs = performance.now() - tMig;
const chunkCount = Number(
  (migDb.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c: number }).c,
);
const evidenceTablesPresent =
  Number(
    (
      migDb
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'
             AND name IN ('retrieval_hits','surfacing_events','decision_traces','evidence_meta')`,
        )
        .get() as { c: number }
    ).c,
  ) === 4;
migDb.close();
console.log(
  `migration: schema ${before ?? "?"} -> ${mig.to} (ran ${mig.ran}) in ${ms(migrationMs)} ms; ${chunkCount} chunks`,
);
if (!evidenceTablesPresent) {
  throw new Error("evidence tables missing after migration");
}

// ── queries (same loader shape as run.mts / replay-judge.mts) ──
const queriesRaw = readFileSync(args.queries!, "utf-8");
const queries = queriesRaw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { query?: string; question?: string })
  .map((r) => (r.query ?? r.question ?? "").trim())
  .filter((q) => q.length > 0);
if (queries.length === 0) {
  throw new Error("no queries loaded");
}
console.log(`queries: ${queries.length} (file sha256 ${sha(queriesRaw).slice(0, 12)})`);

// ── managers: one per mode, same store, same embedding provider ──
const workspaceDir = join(workDir, "workspace");
mkdirSync(join(workspaceDir, "memory"), { recursive: true });
writeFileSync(join(workspaceDir, "memory", "MEMORY.md"), "# evidence gate\n");
const live = loadConfig();
const openai = await resolveApiKeyForProvider({ provider: "openai", cfg: live });
if (!openai?.apiKey) {
  throw new Error("no OpenAI key resolvable; the store's embeddings are text-embedding-3-small");
}
function cfgFor(agentId: string, mode: "off" | "observe"): BitterbotConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          remote: { apiKey: openai!.apiKey },
          sources: ["memory", "sessions"],
          store: { path: copyPath, vector: { enabled: true } },
          sync: {
            intervalMinutes: 0,
            onSearch: false,
            onStartup: false,
            watch: false,
            onSessionStart: false,
          },
          query: {
            maxResults,
            minScore: 0,
            hybrid: { enabled: true, mergeStrategy: "rrf", candidateMultiplier: 5 },
            // Recency measures from last_accessed_at, which every search advances;
            // off so the same query is deterministic across repetitions and modes.
            recency: { enabled: false },
          },
        },
      },
      list: [{ id: agentId, default: false, workspace: workspaceDir }],
    },
    memory: {
      dream: { enabled: false },
      consolidation: { enabled: false },
      curiosity: { enabled: false, evidence: { mode, topK } },
      // Hormonal state is per manager and every search moves it (limbic
      // bridge), which then scales the mood-congruent and recency boosts; two
      // managers with different histories would reorder near-ties for reasons
      // unrelated to telemetry. Off, so both score identically.
      emotional: { enabled: false, hormonal: { enabled: false } },
      healthSweep: { enabled: false },
      coverageDiagnostics: { enabled: false },
    },
  } as unknown as BitterbotConfig;
}
const offManager = await MemoryIndexManager.get({
  cfg: cfgFor("gate-off", "off"),
  agentId: "gate-off",
});
const obsManager = await MemoryIndexManager.get({
  cfg: cfgFor("gate-observe", "observe"),
  agentId: "gate-observe",
});
if (!offManager || !obsManager) {
  throw new Error("MemoryIndexManager.get returned null");
}
const offMode = offManager.getEvidenceTelemetry()?.mode;
const obsMode = obsManager.getEvidenceTelemetry()?.mode;
if (offMode !== "off" || obsMode !== "observe") {
  throw new Error(`telemetry modes wrong: off=${offMode} observe=${obsMode}`);
}

const reader = new DatabaseSync(copyPath, { readOnly: true });
const idLookup = reader.prepare(
  `SELECT id FROM chunks WHERE path = ? AND start_line = ? AND end_line = ? LIMIT 1`,
);
// Identity of a returned result: the chunk id where (path, lines) resolves to
// one, plus a hash of the snippet so two extracted facts stored at the same
// path and line span (0/0) are never conflated.
const chunkIds = (list: MemorySearchResult[]): string[] =>
  list.map((r) => {
    const row = idLookup.get(r.path, r.startLine, r.endLine) as { id: string } | undefined;
    return `${row?.id ?? `${r.path}:${r.startLine}:${r.endLine}`}#${sha(r.snippet).slice(0, 8)}`;
  });
const countHits = () =>
  Number((reader.prepare(`SELECT COUNT(*) AS c FROM retrieval_hits`).get() as { c: number }).c);
const NOW = Date.now();
// Freeze the wall clock for the compared searches. Age-dependent scoring that
// reads Date.now() directly (graph-channel decay, cache ages) would otherwise
// drift between two searches minutes apart and flip near-ties for reasons
// unrelated to telemetry. Timings below use performance.now().
const realNow = Date.now;
Date.now = () => NOW;

// ── 4a. off-mode pass: warms the embedding cache; must write nothing ──
const hitsBeforeOff = countHits();
for (const q of queries) {
  await offManager.search(q, { maxResults, now: NOW });
}
const hitsAfterOff = countHits();
console.log(
  `off pass: ${queries.length} searches, retrieval_hits ${hitsBeforeOff} -> ${hitsAfterOff}`,
);
// The observe manager gets the same warm-up so both carry identical in-process
// state (caches, counters) into the timed, compared repetitions.
const warmObserveExpected: number[] = [];
for (const q of queries) {
  const list = await obsManager.search(q, { maxResults, now: NOW, caller: "evidence_gate" });
  warmObserveExpected.push(Math.min(topK, list.length));
}
console.log(
  `observe warm-up: ${queries.length} searches, retrieval_hits ${hitsAfterOff} -> ${countHits()}`,
);

// ── 2 + 3. interleaved timed reps ──
const timings = { off: [] as number[], observe: [] as number[] };
const mismatches: Array<{ q: number; rep: number; off: string[]; observe: string[] }> = [];
const expectedRows: number[] = [...warmObserveExpected];
let returnedTotal = 0;
let sameModeDrift = 0;
let sameModeDriftObserve = 0;
const firstOff = new Map<number, string>();
const firstObs = new Map<number, string>();
for (let rep = 0; rep < reps; rep++) {
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi]!;
    const order: Array<"off" | "observe"> =
      (rep + qi) % 2 === 0 ? ["off", "observe"] : ["observe", "off"];
    const lists: Partial<Record<"off" | "observe", MemorySearchResult[]>> = {};
    for (const mode of order) {
      const m = mode === "off" ? offManager : obsManager;
      const t0 = performance.now();
      lists[mode] = await m.search(q, { maxResults, now: NOW, caller: "evidence_gate" });
      timings[mode].push(performance.now() - t0);
    }
    const offIds = chunkIds(lists.off!);
    const obsIds = chunkIds(lists.observe!);
    if (JSON.stringify(offIds) !== JSON.stringify(obsIds)) {
      mismatches.push({ q: qi, rep, off: offIds, observe: obsIds });
    }
    const key = JSON.stringify(offIds);
    if (!firstOff.has(qi)) {
      firstOff.set(qi, key);
    } else if (firstOff.get(qi) !== key) {
      sameModeDrift++;
    }
    const keyObs = JSON.stringify(obsIds);
    if (!firstObs.has(qi)) {
      firstObs.set(qi, keyObs);
    } else if (firstObs.get(qi) !== keyObs) {
      sameModeDriftObserve++;
    }
    expectedRows.push(Math.min(topK, lists.observe!.length));
    returnedTotal += lists.observe!.length;
  }
  console.log(`rep ${rep + 1}/${reps} done; retrieval_hits now ${countHits()}`);
}

// ── 4b. rows written ──
const perQuery = reader
  .prepare(
    `SELECT query_id, COUNT(*) AS n, MAX(rank) AS top, MIN(rank) AS bottom
       FROM retrieval_hits GROUP BY query_id ORDER BY MIN(id)`,
  )
  .all() as unknown as Array<{ query_id: string; n: number; top: number; bottom: number }>;
const nonEmptyExpected = expectedRows.filter((n) => n > 0);
const rowsMatch =
  perQuery.length === nonEmptyExpected.length &&
  perQuery.every((p, i) => p.n === nonEmptyExpected[i] && p.bottom === 1 && p.top === p.n);
const totalRows = countHits();
const textLeak = (() => {
  const dump = reader
    .prepare(
      `SELECT group_concat(COALESCE(query_digest,'') || COALESCE(session_digest,'') || COALESCE(caller,''), ' ') AS s
         FROM retrieval_hits`,
    )
    .get() as { s: string | null };
  const s = dump.s ?? "";
  return queries.some((q) => q.length >= 8 && s.includes(q));
})();
const callers = (
  reader.prepare(`SELECT DISTINCT caller FROM retrieval_hits`).all() as Array<{
    caller: string | null;
  }>
).map((r) => r.caller);
reader.close();

// ── 5 + 6. prune and stats on a separate writer connection ──
const wdb = new DatabaseSync(copyPath);
const telemetry = new EvidenceTelemetry(wdb, { mode: "observe", retentionDays: 90, topK });
const statsBefore = telemetry.stats();
const countNow = Number(
  (wdb.prepare(`SELECT COUNT(*) AS c FROM retrieval_hits`).get() as { c: number }).c,
);
const statsMatchBefore = statsBefore.retrievalHits === countNow;
const DAY = 86_400_000;
wdb.exec(`UPDATE retrieval_hits SET created_at = created_at - ${100 * DAY} WHERE id % 2 = 0`);
const backdated = Number(
  (
    wdb
      .prepare(`SELECT COUNT(*) AS c FROM retrieval_hits WHERE created_at < ?`)
      .get(NOW - 90 * DAY) as {
      c: number;
    }
  ).c,
);
const tPrune = performance.now();
const pruneNoop = await telemetry.prune(NOW - 101 * DAY); // nothing older than that
const pruned = await telemetry.prune(NOW);
const pruneMs = performance.now() - tPrune;
const remaining = Number(
  (wdb.prepare(`SELECT COUNT(*) AS c FROM retrieval_hits`).get() as { c: number }).c,
);
const statsAfter = telemetry.stats();
const pruneOk =
  pruneNoop.retrievalHits === 0 &&
  pruned.retrievalHits === backdated &&
  remaining === countNow - backdated &&
  statsAfter.retrievalHits === remaining &&
  statsMatchBefore;
wdb.close();

Date.now = realNow;
await offManager.close();
await obsManager.close();

// ── report ──
const sortedOff = [...timings.off].sort((a, b) => a - b);
const sortedObs = [...timings.observe].sort((a, b) => a - b);
const p50off = percentile(sortedOff, 50);
const p50obs = percentile(sortedObs, 50);
const p95off = percentile(sortedOff, 95);
const p95obs = percentile(sortedObs, 95);
const neutral = mismatches.length === 0;
const zeroRowsOff = hitsAfterOff === hitsBeforeOff;
const pass = neutral && zeroRowsOff && rowsMatch && pruneOk && !textLeak;

const report = {
  git_commit: gitCommit(),
  measuredAt: new Date(NOW).toISOString(),
  store: { copySizeMb, chunkCount, snapshotMs: snapshotMs === null ? null : ms(snapshotMs) },
  migration: { from: Number(before ?? 0), to: mig.to, ran: mig.ran, wallMs: ms(migrationMs) },
  queries: { n: queries.length, sha256: sha(queriesRaw), reps, maxResults, topK },
  search: {
    off: {
      n: sortedOff.length,
      p50Ms: ms(p50off),
      p95Ms: ms(p95off),
      meanMs: ms(sortedOff.reduce((a, b) => a + b, 0) / Math.max(1, sortedOff.length)),
    },
    observe: {
      n: sortedObs.length,
      p50Ms: ms(p50obs),
      p95Ms: ms(p95obs),
      meanMs: ms(sortedObs.reduce((a, b) => a + b, 0) / Math.max(1, sortedObs.length)),
    },
    p50DeltaMs: ms(p50obs - p50off),
    p95DeltaMs: ms(p95obs - p95off),
  },
  neutrality: {
    identicalLists: neutral,
    comparisons: queries.length * reps,
    mismatches: mismatches.length,
    // control: how often the SAME mode returned a different list for the same
    // query across repetitions; nonzero means search itself drifts
    sameModeDrift: { off: sameModeDrift, observe: sameModeDriftObserve },
  },
  rows: {
    zeroRowsAfterOffPass: zeroRowsOff,
    totalRows,
    expectedRows: nonEmptyExpected.reduce((a, b) => a + b, 0),
    perQueryMatch: rowsMatch,
    returnedTotal,
    callers,
    queryTextInRows: textLeak,
  },
  prune: {
    backdated,
    removed: pruned.retrievalHits,
    remaining,
    noopRemoved: pruneNoop.retrievalHits,
    wallMs: ms(pruneMs),
    statsMatch: statsMatchBefore && statsAfter.retrievalHits === remaining,
    ok: pruneOk,
  },
  pass,
};

const table = [
  "| check | result |",
  "| --- | --- |",
  `| store | ${copySizeMb} MB copy, ${chunkCount} chunks${snapshotMs === null ? "" : `, VACUUM INTO ${ms(snapshotMs)} ms`} |`,
  `| migration v${report.migration.from} -> v${report.migration.to} | ${report.migration.wallMs} ms |`,
  `| queries | ${queries.length} real queries x ${reps} reps, maxResults ${maxResults}, topK ${topK} |`,
  `| search mean off / observe | ${report.search.off.meanMs} ms / ${report.search.observe.meanMs} ms |`,
  `| search p50 off / observe | ${ms(p50off)} ms / ${ms(p50obs)} ms (delta ${report.search.p50DeltaMs} ms) |`,
  `| search p95 off / observe | ${ms(p95off)} ms / ${ms(p95obs)} ms (delta ${report.search.p95DeltaMs} ms) |`,
  `| neutrality (ordered chunk ids identical) | ${neutral ? "PASS" : "FAIL"} (${queries.length * reps} comparisons, ${mismatches.length} mismatches; same-mode drift off ${sameModeDrift}, observe ${sameModeDriftObserve}) |`,
  `| rows after off pass | ${zeroRowsOff ? "0 (PASS)" : `${hitsAfterOff - hitsBeforeOff} (FAIL)`} |`,
  `| rows == min(topK, returned) per observe search | ${rowsMatch ? "PASS" : "FAIL"} (${totalRows} rows over ${perQuery.length} searches) |`,
  `| query text in rows | ${textLeak ? "FOUND (FAIL)" : "none (PASS)"} |`,
  `| prune (90 d) | removed ${pruned.retrievalHits} of ${backdated} backdated, kept ${remaining}, ${report.prune.wallMs} ms (${pruneOk ? "PASS" : "FAIL"}) |`,
  `| stats() == COUNT(*) | ${report.prune.statsMatch ? "PASS" : "FAIL"} |`,
  `| overall | ${pass ? "PASS" : "FAIL"} |`,
].join("\n");

const outPath = args.out ?? join(workDir, `evidence-gate-${report.git_commit ?? "nogit"}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`\n${table}\n`);
console.log(`report: ${outPath}`);
if (mismatches.length > 0) {
  console.log(`first mismatch: ${JSON.stringify(mismatches[0])}`);
}

if (!args.keep && args["copy-from"]) {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${copyPath}${suffix}`, { force: true });
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  console.log("copy deleted");
}
if (!pass) {
  process.exitCode = 1;
}
