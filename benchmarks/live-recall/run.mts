/**
 * Live-memory held-out recall set: scoring.
 *
 * For every generated question, searches a COPY of the store snapshot through
 * the normal MemoryIndexManager (same embedding provider and hybrid settings
 * as a live node, every background engine off) and records where the chunk the
 * question was written from lands: fused rank and each channel's own rank.
 * The output holds ranks and ids only, never text.
 *
 *   node --import tsx benchmarks/live-recall/run.mts \
 *     --snapshot ~/snap.sqlite --questions ~/.bitterbot/benchmarks/live-recall/questions.jsonl \
 *     --out benchmarks/live-recall/results/live-recall-<tag>.json [--max-results 50]
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import { loadConfig } from "../../src/config/io.js";
import type { HybridChannel } from "../../src/memory/hybrid.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";
import type { MemorySearchResult } from "../../src/memory/types.js";

const { values: args } = parseArgs({
  options: {
    snapshot: { type: "string" },
    questions: { type: "string" },
    out: { type: "string" },
    "max-results": { type: "string", default: "50" },
    /** Turn the post-fusion recency boost off, to measure fusion order alone. */
    "no-recency": { type: "boolean", default: false },
    /** query.postFusionBoostScale for the run (1 = legacy full boosts). */
    "boost-scale": { type: "string" },
  },
  strict: true,
});
if (!args.snapshot || !args.questions || !args.out) {
  throw new Error("usage: --snapshot <sqlite> --questions <jsonl> --out <json> [--max-results 50]");
}
const CHANNELS: readonly HybridChannel[] = ["vector", "keyword", "graph"];
const maxResults = Number(args["max-results"]);

type Question = {
  chunkId: string;
  path: string;
  source: string;
  startLine: number;
  endLine: number;
  question: string;
};
const questionsRaw = readFileSync(args.questions, "utf-8");
const questions = questionsRaw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Question);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

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
const measuredCommit = gitCommit();

// The manager writes access statistics on search; work on a copy, never the snapshot.
const work = mkdtempSync(join(tmpdir(), "live-recall-"));
const storePath = join(work, "store.sqlite");
copyFileSync(args.snapshot, storePath);
const workspaceDir = join(work, "workspace");
mkdirSync(join(workspaceDir, "memory"), { recursive: true });
writeFileSync(join(workspaceDir, "memory", "MEMORY.md"), "# held-out recall\n");

const live = loadConfig();
const openai = await resolveApiKeyForProvider({ provider: "openai", cfg: live });
if (!openai?.apiKey) {
  throw new Error("no OpenAI key resolvable; the store's embeddings are text-embedding-3-small");
}
const agentId = "live-recall";
const cfg = {
  agents: {
    defaults: {
      workspace: workspaceDir,
      memorySearch: {
        enabled: true,
        provider: "openai",
        model: "text-embedding-3-small",
        remote: { apiKey: openai.apiKey },
        sources: ["memory", "sessions"],
        store: { path: storePath, vector: { enabled: true } },
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
          ...(args["no-recency"] ? { recency: { enabled: false } } : {}),
          ...(args["boost-scale"] !== undefined
            ? { postFusionBoostScale: Number(args["boost-scale"]) }
            : {}),
        },
      },
    },
    list: [{ id: agentId, default: true, workspace: workspaceDir }],
  },
  memory: {
    dream: { enabled: false },
    consolidation: { enabled: false },
    curiosity: { enabled: false },
    emotional: { enabled: false },
    healthSweep: { enabled: false },
    coverageDiagnostics: { enabled: false },
  },
} as unknown as BitterbotConfig;

const manager = await MemoryIndexManager.get({ cfg, agentId });
if (!manager) {
  throw new Error("MemoryIndexManager.get returned null");
}

const hits = (q: Question, c: MemorySearchResult) =>
  c.path === q.path && c.startLine <= q.endLine && c.endLine >= q.startLine;
const firstRank = (list: MemorySearchResult[], q: Question) => {
  const i = list.findIndex((c) => hits(q, c));
  return i < 0 ? null : i + 1;
};

type Ranks = { fused: number | null } & Record<HybridChannel, number | null>;
type Tally = { at1: number; at5: number; at10: number; rr: number };
const per: Array<{
  chunkId: string;
  source: string;
  ranks: Ranks;
  returned: number;
  fusion?: string;
}> = [];
const agg: Record<"fused" | HybridChannel, Tally> = {
  fused: { at1: 0, at5: 0, at10: 0, rr: 0 },
  vector: { at1: 0, at5: 0, at10: 0, rr: 0 },
  keyword: { at1: 0, at5: 0, at10: 0, rr: 0 },
  graph: { at1: 0, at5: 0, at10: 0, rr: 0 },
};
const t0 = Date.now();
for (let i = 0; i < questions.length; i++) {
  const q = questions[i]!;
  const results = await manager.search(q.question, { maxResults });
  const ranks = { fused: firstRank(results, q) } as Ranks;
  for (const ch of CHANNELS) {
    const ranked = results
      .filter((c) => c.channels?.[ch])
      .toSorted((a, b) => a.channels![ch]!.rank - b.channels![ch]!.rank);
    ranks[ch] = firstRank(ranked, q);
  }
  for (const k of ["fused", ...CHANNELS] as const) {
    const r = ranks[k];
    if (r !== null) {
      if (r <= 1) agg[k].at1++;
      if (r <= 5) agg[k].at5++;
      if (r <= 10) agg[k].at10++;
      agg[k].rr += 1 / r;
    }
  }
  per.push({
    chunkId: q.chunkId,
    source: q.source,
    ranks,
    returned: results.length,
    fusion: results[0]?.fusion,
  });
  if ((i + 1) % 10 === 0) {
    const r5 = ((100 * agg.fused.at5) / (i + 1)).toFixed(1);
    console.log(`  ${i + 1}/${questions.length} fused R@5 so far ${r5}%`);
  }
}
const n = questions.length;
const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
const summary = Object.fromEntries(
  (["fused", ...CHANNELS] as const).map((k) => [
    k,
    {
      "R@1": pct(agg[k].at1),
      "R@5": pct(agg[k].at5),
      "R@10": pct(agg[k].at10),
      MRR: (agg[k].rr / n).toFixed(3),
    },
  ]),
);
const bySource: Record<string, { n: number; fusedAt5: number; keywordAt5: number }> = {};
for (const p of per) {
  const b = (bySource[p.source] ??= { n: 0, fusedAt5: 0, keywordAt5: 0 });
  b.n++;
  if (p.ranks.fused !== null && p.ranks.fused <= 5) b.fusedAt5++;
  if (p.ranks.keyword !== null && p.ranks.keyword <= 5) b.keywordAt5++;
}
const out = {
  git_commit: measuredCommit,
  recencyBoost: !args["no-recency"],
  postFusionBoostScale: args["boost-scale"] !== undefined ? Number(args["boost-scale"]) : 1,
  snapshotSha256: sha(readFileSync(args.snapshot)),
  questionsSha256: sha(questionsRaw),
  n,
  maxResults,
  elapsed_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  summary,
  bySource,
  per_question: per,
};
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ commit: measuredCommit, n, summary, bySource }, null, 1));
await manager.close();
rmSync(work, { recursive: true, force: true });
