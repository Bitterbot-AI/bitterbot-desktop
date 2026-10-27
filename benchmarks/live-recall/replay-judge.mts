/**
 * Replay real agent queries against a store snapshot under several
 * post-fusion boost scales and judge relevance with a small model.
 *
 * The held-out set (run.mts) has exact ground truth but synthetic questions.
 * Real queries from the journal (extract-journal-queries.mts) have no ground
 * truth, so a judge model marks each (query, passage) pair relevant or not,
 * ONCE, and the same verdicts score every setting. Settings differ only in the
 * code path under test, so the comparison is fair even if the judge is not
 * perfect. Output holds metrics and ids only.
 *
 *   node --import tsx benchmarks/live-recall/replay-judge.mts \
 *     --snapshot ~/snap.sqlite --queries ~/.bitterbot/benchmarks/live-recall/journal-queries.jsonl \
 *     --scales 1,0.1,0 --out benchmarks/live-recall/results/replay-<date>.json [--k 5] [--judge claude-haiku-4-5]
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
import { MemoryIndexManager } from "../../src/memory/manager.js";
import type { MemorySearchResult } from "../../src/memory/types.js";

const { values: args } = parseArgs({
  options: {
    snapshot: { type: "string" },
    queries: { type: "string" },
    out: { type: "string" },
    scales: { type: "string", default: "1,0.1,0" },
    k: { type: "string", default: "5" },
    judge: { type: "string", default: "claude-haiku-4-5" },
  },
  strict: true,
});
if (!args.snapshot || !args.queries || !args.out) {
  throw new Error(
    "usage: --snapshot <sqlite> --queries <jsonl> --out <json> [--scales 1,0.1,0] [--k 5]",
  );
}
const K = Number(args.k);
const scales = args.scales.split(",").map((s) => Number(s.trim()));
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const queriesRaw = readFileSync(args.queries, "utf-8");
const queries = queriesRaw
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => (JSON.parse(l) as { query: string }).query);

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

const live = loadConfig();
const openai = await resolveApiKeyForProvider({ provider: "openai", cfg: live });
const anthropic = await resolveApiKeyForProvider({ provider: "anthropic", cfg: live });
if (!openai?.apiKey || !anthropic?.apiKey) {
  throw new Error("need both an OpenAI key (embeddings) and an Anthropic key (judge)");
}
const judgeKey = anthropic.apiKey;

type Hit = { id: string; snippet: string; rank: number };
const resultId = (r: MemorySearchResult) => `${r.path}:${r.startLine}-${r.endLine}`;

async function searchAll(scale: number): Promise<Map<string, Hit[]>> {
  const work = mkdtempSync(join(tmpdir(), `replay-${scale}-`));
  const storePath = join(work, "store.sqlite");
  copyFileSync(args.snapshot!, storePath);
  const workspaceDir = join(work, "workspace");
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(join(workspaceDir, "memory", "MEMORY.md"), "# replay\n");
  const agentId = `replay-${String(scale).replace(".", "_")}`;
  const cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          remote: { apiKey: openai!.apiKey },
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
            maxResults: K,
            minScore: 0,
            hybrid: { enabled: true, mergeStrategy: "rrf", candidateMultiplier: 5 },
            postFusionBoostScale: scale,
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
  const out = new Map<string, Hit[]>();
  for (const q of queries) {
    const results = await manager.search(q, { maxResults: K });
    out.set(
      q,
      results.slice(0, K).map((r, i) => ({ id: resultId(r), snippet: r.snippet, rank: i + 1 })),
    );
  }
  await manager.close();
  rmSync(work, { recursive: true, force: true });
  return out;
}

const JUDGE_PROMPT =
  "You judge memory retrieval. Given a search query someone typed into their personal memory system and one " +
  "retrieved passage, answer YES if the passage contains information that answers or directly addresses the " +
  "query, otherwise NO. Answer with the single word YES or NO.";

const verdicts = new Map<string, boolean>();
async function judge(query: string, passage: string): Promise<boolean> {
  const key = sha(`${query}\u0000${passage}`);
  const cached = verdicts.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": judgeKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: args.judge,
      max_tokens: 5,
      system: JUDGE_PROMPT,
      messages: [{ role: "user", content: `Query: ${query}\n\nPassage:\n${passage}` }],
    }),
  });
  if (!res.ok) {
    throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = (data.content.find((c) => c.type === "text")?.text ?? "").trim().toUpperCase();
  const yes = text.startsWith("YES");
  verdicts.set(key, yes);
  return yes;
}

const t0 = Date.now();
const byScale = new Map<number, Map<string, Hit[]>>();
for (const scale of scales) {
  console.log(`searching ${queries.length} queries at scale ${scale}`);
  byScale.set(scale, await searchAll(scale));
}

// Judge every (query, passage) pair once across all settings.
let judged = 0;
const relevant = new Map<string, Set<string>>(); // query -> relevant hit ids
for (const q of queries) {
  const seen = new Map<string, string>();
  for (const scale of scales) {
    for (const h of byScale.get(scale)!.get(q) ?? []) {
      if (!seen.has(h.id)) {
        seen.set(h.id, h.snippet);
      }
    }
  }
  const rel = new Set<string>();
  for (const [id, snippet] of seen) {
    judged++;
    if (await judge(q, snippet)) {
      rel.add(id);
    }
  }
  relevant.set(q, rel);
  if (relevant.size % 10 === 0) {
    console.log(`  judged ${relevant.size}/${queries.length} queries (${judged} pairs)`);
  }
}

type Metrics = { hitAtK: number; precisionAtK: number; mrr: number; relevantAt1: number };
const summary: Record<string, Metrics & { n: number }> = {};
const perQuery: Array<{
  q: string;
  results: Record<string, { ranks: number[]; relevant: number }>;
}> = [];
for (const scale of scales) {
  let hit = 0;
  let prec = 0;
  let rr = 0;
  let at1 = 0;
  for (const q of queries) {
    const hits = byScale.get(scale)!.get(q) ?? [];
    const rel = relevant.get(q)!;
    const relRanks = hits.filter((h) => rel.has(h.id)).map((h) => h.rank);
    if (relRanks.length > 0) {
      hit++;
      rr += 1 / relRanks[0]!;
      if (relRanks[0] === 1) at1++;
    }
    prec += relRanks.length / Math.max(1, hits.length);
  }
  const n = queries.length;
  summary[String(scale)] = {
    n,
    hitAtK: Number((hit / n).toFixed(3)),
    precisionAtK: Number((prec / n).toFixed(3)),
    mrr: Number((rr / n).toFixed(3)),
    relevantAt1: Number((at1 / n).toFixed(3)),
  };
}
for (const q of queries) {
  const row: Record<string, { ranks: number[]; relevant: number }> = {};
  for (const scale of scales) {
    const hits = byScale.get(scale)!.get(q) ?? [];
    const rel = relevant.get(q)!;
    row[String(scale)] = {
      ranks: hits.filter((h) => rel.has(h.id)).map((h) => h.rank),
      relevant: hits.filter((h) => rel.has(h.id)).length,
    };
  }
  perQuery.push({ q: sha(q).slice(0, 12), results: row });
}

const out = {
  git_commit: measuredCommit,
  snapshotSha256: sha(readFileSync(args.snapshot)),
  queriesSha256: sha(queriesRaw),
  judge: args.judge,
  judgePromptSha256: sha(JUDGE_PROMPT),
  k: K,
  n: queries.length,
  pairsJudged: judged,
  anyRelevantQueries: [...relevant.values()].filter((s) => s.size > 0).length,
  elapsed_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  summary,
  per_query: perQuery,
};
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  JSON.stringify(
    { commit: measuredCommit, n: queries.length, pairsJudged: judged, summary },
    null,
    1,
  ),
);
