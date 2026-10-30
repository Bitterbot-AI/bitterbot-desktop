/**
 * Replay real agent queries against a store snapshot under several search
 * settings and judge relevance with a small model.
 *
 * The held-out set (run.mts) has exact ground truth but synthetic questions.
 * Real queries from the journal (extract-journal-queries.mts) have no ground
 * truth, so a judge model marks each (query, passage) pair relevant or not,
 * ONCE, and the same verdicts score every setting. Settings differ only in the
 * code path under test, so the comparison is fair even if the judge is not
 * perfect. Output holds metrics, hashes and ranks only.
 *
 * A setting is a post-fusion boost scale, an RRF weight triple
 * (vector,keyword,graph) and optionally an RRF constant:
 *
 *   node --import tsx benchmarks/live-recall/replay-judge.mts \
 *     --snapshot ~/snap.sqlite --queries ~/.bitterbot/benchmarks/live-recall/journal-queries.jsonl \
 *     --settings "boost=0.1;rrf=1,1,1" "boost=0.1;rrf=0.25,1,1" "boost=0.1;rrf=0.1,1,1" \
 *     --out benchmarks/live-recall/results/replay-<date>.json [--k 5] [--judge claude-haiku-4-5] \
 *     [--now <epoch ms>] [--rejudge 60] [--verdict-cache <json>]
 *
 * `--scales 1,0.1,0` is the older spelling of `--settings "boost=1;rrf=1,1,1" ...`.
 * The first setting is the baseline the others are compared with. The wall
 * clock is frozen at `--now` for every search (default: the start of the run)
 * and hormonal modulation is off, so a setting's result list is a function of
 * the code and the snapshot alone; the recency boost keeps its production
 * default. `--rejudge N` asks the judge a second time about N randomly chosen
 * pooled pairs to estimate its flip rate, which sets the non-inferiority
 * margin (see `judgeNoise` and `contrasts` in the output).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import { loadConfig } from "../../src/config/io.js";
import type { EmbeddingProvider } from "../../src/memory/embeddings.js";
import type { HybridRrfWeights } from "../../src/memory/hybrid.js";
import { MemoryIndexManager } from "../../src/memory/manager.js";
import type { MemorySearchResult } from "../../src/memory/types.js";
import { seededRandom } from "../plan59-phase1/common.js";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    snapshot: { type: "string" },
    queries: { type: "string" },
    out: { type: "string" },
    scales: { type: "string" },
    settings: { type: "string", multiple: true },
    k: { type: "string", default: "5" },
    judge: { type: "string", default: "claude-haiku-4-5" },
    now: { type: "string" },
    rejudge: { type: "string", default: "0" },
    "verdict-cache": { type: "string" },
  },
  strict: true,
});
if (!args.snapshot || !args.queries || !args.out) {
  throw new Error(
    'usage: --snapshot <sqlite> --queries <jsonl> --out <json> [--settings "boost=0.1;rrf=1,1,1" ...] [--scales 1,0.1,0] [--k 5]',
  );
}
const K = Number(args.k);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ---- settings ---------------------------------------------------------------

type Setting = {
  label: string;
  boost: number;
  rrf: HybridRrfWeights;
  rrfK: number;
};

/** Parse `boost=0.1;rrf=0.25,1,1;k=60` (every part optional; defaults 0.1 / 1,1,1 / 60). */
function parseSetting(spec: string): Setting {
  const setting: Setting = {
    label: spec.trim(),
    boost: 0.1,
    rrf: { vector: 1, keyword: 1, graph: 1 },
    rrfK: 60,
  };
  for (const part of spec.split(";")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (!key) {
      continue;
    }
    if (key === "boost") {
      setting.boost = Number(value);
    } else if (key === "rrf") {
      const [v, k, g] = (value ?? "").split(",").map((s) => Number(s.trim()));
      setting.rrf = { vector: v ?? 1, keyword: k ?? 1, graph: g ?? 1 };
    } else if (key === "k") {
      setting.rrfK = Number(value);
    } else {
      throw new Error(`unknown setting key "${key}" in "${spec}"`);
    }
  }
  const checks: Array<[string, number]> = [
    ["boost", setting.boost],
    ["rrf.vector", setting.rrf.vector],
    ["rrf.keyword", setting.rrf.keyword],
    ["rrf.graph", setting.rrf.graph],
    ["k", setting.rrfK],
  ];
  for (const [name, n] of checks) {
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`setting "${spec}": ${name} must be a finite number >= 0`);
    }
  }
  return setting;
}

// `--settings a b c` and `--settings a --settings b --settings c` both work:
// bare positionals after the first --settings are further settings.
const settingSpecs = [...(args.settings ?? []), ...positionals];
const settings: Setting[] = settingSpecs.length
  ? settingSpecs.map(parseSetting)
  : (args.scales ?? "1,0.1,0").split(",").map((s) => parseSetting(`boost=${s.trim()};rrf=1,1,1`));
if (new Set(settings.map((s) => s.label)).size !== settings.length) {
  throw new Error("settings must have distinct labels");
}

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
const frozenNow = Number(args.now ?? Date.now());

const live = loadConfig();
const openai = await resolveApiKeyForProvider({ provider: "openai", cfg: live });
const anthropic = await resolveApiKeyForProvider({ provider: "anthropic", cfg: live });
if (!openai?.apiKey || !anthropic?.apiKey) {
  throw new Error("need both an OpenAI key (embeddings) and an Anthropic key (judge)");
}
const openaiKey = openai.apiKey;
const judgeKey = anthropic.apiKey;

// ---- retries ----------------------------------------------------------------

async function withRetries<T>(label: string, fn: () => Promise<T>, attempts = 8): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal) {
        break;
      }
      const msg = String((err as Error).message ?? err).slice(0, 140);
      console.error(`${label} failed (attempt ${attempt}/${attempts}): ${msg}`);
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** (attempt - 1))));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---- search -----------------------------------------------------------------

/** Query embeddings memoised by text so every setting sees the same vector. */
const embedMemo = new Map<string, Promise<number[]>>();
let embedCalls = 0;

type Hit = { id: string; snippet: string; rank: number };
const resultId = (r: MemorySearchResult) => `${r.path}:${r.startLine}-${r.endLine}`;

async function searchAll(setting: Setting, index: number): Promise<Map<string, Hit[]>> {
  const work = mkdtempSync(join(tmpdir(), `replay-${index}-`));
  const storePath = join(work, "store.sqlite");
  copyFileSync(args.snapshot!, storePath);
  const workspaceDir = join(work, "workspace");
  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
  writeFileSync(join(workspaceDir, "memory", "MEMORY.md"), "# replay\n");
  const agentId = `replay-${index}`;
  const cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          remote: { apiKey: openaiKey },
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
            hybrid: {
              enabled: true,
              mergeStrategy: "rrf",
              candidateMultiplier: 5,
              rrfWeights: setting.rrf,
              rrfK: setting.rrfK,
            },
            postFusionBoostScale: setting.boost,
          },
        },
      },
      list: [{ id: agentId, default: true, workspace: workspaceDir }],
    },
    memory: {
      dream: { enabled: false },
      consolidation: { enabled: false },
      curiosity: { enabled: false, evidence: { mode: "off" } },
      emotional: { enabled: false, hormonal: { enabled: false } },
      healthSweep: { enabled: false },
      coverageDiagnostics: { enabled: false },
    },
  } as unknown as BitterbotConfig;
  const manager = await MemoryIndexManager.get({ cfg, agentId });
  if (!manager) {
    throw new Error("MemoryIndexManager.get returned null");
  }
  const inner = manager as unknown as { provider: EmbeddingProvider };
  const original = inner.provider.embedQuery.bind(inner.provider);
  inner.provider.embedQuery = (text: string, opts?: Parameters<typeof original>[1]) => {
    const hit = embedMemo.get(text);
    if (hit) {
      return hit;
    }
    embedCalls += 1;
    const p = original(text, opts).catch((err: unknown) => {
      embedMemo.delete(text);
      throw err;
    });
    embedMemo.set(text, p);
    return p;
  };
  const out = new Map<string, Hit[]>();
  const realNow = Date.now;
  Date.now = () => frozenNow;
  try {
    for (const q of queries) {
      const results = await withRetries(`search ${sha(q).slice(0, 8)}`, () =>
        manager.search(q, {
          maxResults: K,
          now: frozenNow,
          observe: false,
          caller: "replay_judge",
        }),
      );
      out.set(
        q,
        results.slice(0, K).map((r, i) => ({ id: resultId(r), snippet: r.snippet, rank: i + 1 })),
      );
    }
  } finally {
    Date.now = realNow;
    await manager.close();
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}

// ---- judge ------------------------------------------------------------------

/** Replace lone UTF-16 surrogates (a chunk cut mid-character) with U+FFFD. */
const wellFormed = (s: string): string =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");

const JUDGE_PROMPT =
  "You judge memory retrieval. Given a search query someone typed into their personal memory system and one " +
  "retrieved passage, answer YES if the passage contains information that answers or directly addresses the " +
  "query, otherwise NO. Answer with the single word YES or NO.";

// Verdicts are keyed by sha256(query NUL passage): hashes and booleans only,
// so the cache file may sit outside ~/.bitterbot. It lets a run that lost the
// network resume without paying again for the pairs already judged.
const verdicts = new Map<string, boolean>();
const cachePath = args["verdict-cache"];
if (cachePath && existsSync(cachePath)) {
  const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, boolean>;
  for (const [k, v] of Object.entries(cached)) {
    verdicts.set(k, v);
  }
  console.error(`loaded ${verdicts.size} cached verdicts`);
}
function saveVerdicts(): void {
  if (!cachePath) {
    return;
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(Object.fromEntries(verdicts)), { mode: 0o600 });
  chmodSync(cachePath, 0o600);
}

const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
// List price per million tokens for claude-haiku-4-5 at the time of writing.
const PRICE_PER_M = args.judge === "claude-haiku-4-5" ? { input: 1, output: 5 } : null;

async function askJudge(query: string, passage: string): Promise<boolean> {
  return await withRetries("judge", async () => {
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
        // A chunk cut mid-character can leave a lone surrogate, which the
        // API rejects as invalid JSON; replace it rather than fail the run.
        messages: [
          {
            role: "user",
            content: `Query: ${wellFormed(query)}\n\nPassage:\n${wellFormed(passage)}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 160);
      const err = new Error(`judge ${res.status}: ${body}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw Object.assign(err, { fatal: true });
      }
      throw err;
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    usage.calls += 1;
    usage.inputTokens += data.usage?.input_tokens ?? 0;
    usage.outputTokens += data.usage?.output_tokens ?? 0;
    const text = (data.content.find((c) => c.type === "text")?.text ?? "").trim().toUpperCase();
    return text.startsWith("YES");
  });
}

async function judge(query: string, passage: string): Promise<boolean> {
  const key = sha(`${query}\u0000${passage}`);
  const cached = verdicts.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const yes = await askJudge(query, passage);
  verdicts.set(key, yes);
  if (verdicts.size % 25 === 0) {
    saveVerdicts();
  }
  return yes;
}

// ---- run --------------------------------------------------------------------

const t0 = Date.now();
const bySetting = new Map<string, Map<string, Hit[]>>();
for (const [i, setting] of settings.entries()) {
  console.log(`searching ${queries.length} queries under ${setting.label}`);
  bySetting.set(setting.label, await searchAll(setting, i));
}

// Judge every (query, passage) pair once across all settings.
let judged = 0;
let fromCache = 0;
const pooled: Array<{ q: string; snippet: string }> = [];
const relevant = new Map<string, Set<string>>(); // query -> relevant hit ids
for (const q of queries) {
  const seen = new Map<string, string>();
  for (const setting of settings) {
    for (const h of bySetting.get(setting.label)!.get(q) ?? []) {
      if (!seen.has(h.id)) {
        seen.set(h.id, h.snippet);
      }
    }
  }
  const rel = new Set<string>();
  for (const [id, snippet] of seen) {
    judged++;
    pooled.push({ q, snippet });
    if (verdicts.has(sha(`${q}\u0000${snippet}`))) {
      fromCache++;
    }
    if (await judge(q, snippet)) {
      rel.add(id);
    }
  }
  relevant.set(q, rel);
  if (relevant.size % 10 === 0) {
    console.log(`  judged ${relevant.size}/${queries.length} queries (${judged} pairs)`);
  }
}
saveVerdicts();

// Judge noise: ask again about a seeded random subset of the pooled pairs.
const rejudgeN = Math.min(pooled.length, Math.max(0, Math.floor(Number(args.rejudge))));
let flips = 0;
if (rejudgeN > 0) {
  const rnd = seededRandom(`rejudge:${sha(queriesRaw)}`);
  const order = [...pooled.keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const idx of order.slice(0, rejudgeN)) {
    const pair = pooled[idx]!;
    const first = verdicts.get(sha(`${pair.q}\u0000${pair.snippet}`))!;
    const second = await askJudge(pair.q, pair.snippet);
    if (second !== first) {
      flips += 1;
    }
  }
  console.log(`re-judged ${rejudgeN} pairs, ${flips} flipped`);
}
const flipRate = rejudgeN > 0 ? flips / rejudgeN : null;
// With few or no observed flips the rule of three gives a 95% upper bound of
// 3/n; the simulation uses the larger of the observed rate and that bound.
const flipRateUsed = rejudgeN > 0 ? Math.max(flipRate!, 3 / rejudgeN) : null;

// ---- metrics ----------------------------------------------------------------

type Metrics = { hitAtK: number; precisionAtK: number; mrr: number; relevantAt1: number };
function scoreSetting(label: string, rel: Map<string, Set<string>>): Metrics & { n: number } {
  let hit = 0;
  let prec = 0;
  let rr = 0;
  let at1 = 0;
  for (const q of queries) {
    const hits = bySetting.get(label)!.get(q) ?? [];
    const r = rel.get(q)!;
    const relRanks = hits.filter((h) => r.has(h.id)).map((h) => h.rank);
    if (relRanks.length > 0) {
      hit++;
      rr += 1 / relRanks[0]!;
      if (relRanks[0] === 1) {
        at1++;
      }
    }
    prec += relRanks.length / Math.max(1, hits.length);
  }
  const n = queries.length;
  return {
    n,
    hitAtK: Number((hit / n).toFixed(3)),
    precisionAtK: Number((prec / n).toFixed(3)),
    mrr: Number((rr / n).toFixed(3)),
    relevantAt1: Number((at1 / n).toFixed(3)),
  };
}
const summary: Record<string, Metrics & { n: number; setting: Omit<Setting, "label"> }> = {};
for (const setting of settings) {
  const { label, ...rest } = setting;
  summary[label] = { ...scoreSetting(label, relevant), setting: rest };
}

// Per-query first relevant rank under a setting, for paired contrasts.
const firstRank = (label: string, q: string, rel: Map<string, Set<string>>): number | null => {
  const hits = bySetting.get(label)!.get(q) ?? [];
  const r = rel.get(q)!;
  const first = hits.find((h) => r.has(h.id));
  return first ? first.rank : null;
};
const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);
const sd = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const round4 = (x: number) => Number(x.toFixed(4));

type Contrast = {
  setting: string;
  baseline: string;
  deltaHitAtK: number;
  deltaMrr: number;
  queriesUp: number;
  queriesDown: number;
  /** paired percentile bootstrap over queries (sampling noise), 2,000 resamples */
  queryBootstrap: { deltaHitAtK: [number, number]; deltaMrr: [number, number] };
  /** sd of the delta when every pooled verdict flips independently with flipRateUsed */
  judgeNoiseSd: { deltaHitAtK: number; deltaMrr: number } | null;
  /** margin = 2 x judgeNoiseSd per metric; non-inferior when both deltas are >= -margin */
  nonInferior: boolean | null;
};
const baseline = settings[0]!.label;
const contrasts: Contrast[] = [];
const B = 2000;
const pooledIds = new Map<string, string[]>();
for (const q of queries) {
  const ids = new Set<string>();
  for (const setting of settings) {
    for (const h of bySetting.get(setting.label)!.get(q) ?? []) {
      ids.add(h.id);
    }
  }
  pooledIds.set(q, [...ids]);
}
for (const setting of settings.slice(1)) {
  const label = setting.label;
  const dHit: number[] = [];
  const dRr: number[] = [];
  let up = 0;
  let down = 0;
  for (const q of queries) {
    const a = firstRank(label, q, relevant);
    const b = firstRank(baseline, q, relevant);
    dHit.push((a ? 1 : 0) - (b ? 1 : 0));
    dRr.push((a ? 1 / a : 0) - (b ? 1 / b : 0));
    const ra = a ?? Number.POSITIVE_INFINITY;
    const rb = b ?? Number.POSITIVE_INFINITY;
    if (ra < rb) {
      up++;
    } else if (ra > rb) {
      down++;
    }
  }
  const n = queries.length;
  // Sampling noise: paired percentile bootstrap over queries.
  const rnd = seededRandom(`boot:${label}`);
  const bootHit: number[] = [];
  const bootRr: number[] = [];
  for (let r = 0; r < B; r++) {
    let h = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      h += dHit[j]!;
      m += dRr[j]!;
    }
    bootHit.push(h / n);
    bootRr.push(m / n);
  }
  bootHit.sort((x, y) => x - y);
  bootRr.sort((x, y) => x - y);
  // Judge noise: flip each pooled verdict independently with the estimated
  // rate and rescore both settings on the same perturbed verdicts. Passages
  // the two settings share flip together, so only the lists' differences
  // move the delta, which is what judge noise on this comparison means.
  let judgeNoiseSd: Contrast["judgeNoiseSd"] = null;
  let nonInferior: boolean | null = null;
  if (flipRateUsed !== null) {
    const rndJ = seededRandom(`judge:${label}`);
    const simHit: number[] = [];
    const simRr: number[] = [];
    for (let r = 0; r < B; r++) {
      const perturbed = new Map<string, Set<string>>();
      for (const q of queries) {
        const rel = relevant.get(q)!;
        const out = new Set<string>();
        for (const id of pooledIds.get(q)!) {
          const yes = rel.has(id) !== rndJ() < flipRateUsed;
          if (yes) {
            out.add(id);
          }
        }
        perturbed.set(q, out);
      }
      let h = 0;
      let m = 0;
      for (const q of queries) {
        const a = firstRank(label, q, perturbed);
        const b = firstRank(baseline, q, perturbed);
        h += (a ? 1 : 0) - (b ? 1 : 0);
        m += (a ? 1 / a : 0) - (b ? 1 / b : 0);
      }
      simHit.push(h / n);
      simRr.push(m / n);
    }
    judgeNoiseSd = { deltaHitAtK: round4(sd(simHit)), deltaMrr: round4(sd(simRr)) };
    nonInferior =
      mean(dHit) >= -2 * judgeNoiseSd.deltaHitAtK && mean(dRr) >= -2 * judgeNoiseSd.deltaMrr;
  }
  contrasts.push({
    setting: label,
    baseline,
    deltaHitAtK: round4(mean(dHit)),
    deltaMrr: round4(mean(dRr)),
    queriesUp: up,
    queriesDown: down,
    queryBootstrap: {
      deltaHitAtK: [round4(pct(bootHit, 0.025)), round4(pct(bootHit, 0.975))],
      deltaMrr: [round4(pct(bootRr, 0.025)), round4(pct(bootRr, 0.975))],
    },
    judgeNoiseSd,
    nonInferior,
  });
}

const perQuery: Array<{
  q: string;
  results: Record<string, { ranks: number[]; relevant: number }>;
}> = [];
for (const q of queries) {
  const row: Record<string, { ranks: number[]; relevant: number }> = {};
  for (const setting of settings) {
    const hits = bySetting.get(setting.label)!.get(q) ?? [];
    const rel = relevant.get(q)!;
    row[setting.label] = {
      ranks: hits.filter((h) => rel.has(h.id)).map((h) => h.rank),
      relevant: hits.filter((h) => rel.has(h.id)).length,
    };
  }
  perQuery.push({ q: sha(q).slice(0, 12), results: row });
}

const judgeCostUsd =
  PRICE_PER_M === null
    ? null
    : round4(
        (usage.inputTokens * PRICE_PER_M.input + usage.outputTokens * PRICE_PER_M.output) / 1e6,
      );

const out = {
  git_commit: measuredCommit,
  snapshotSha256: sha(readFileSync(args.snapshot)),
  queriesSha256: sha(queriesRaw),
  judge: args.judge,
  judgePromptSha256: sha(JUDGE_PROMPT),
  k: K,
  n: queries.length,
  frozenNow,
  determinism: "clock frozen at frozenNow, hormonal modulation off, recency boost at its default",
  embeddingCalls: embedCalls,
  pairsJudged: judged,
  pairsFromCache: fromCache,
  judgeUsage: { ...usage, costUsd: judgeCostUsd },
  judgeNoise: {
    rejudged: rejudgeN,
    flips,
    flipRate: flipRate === null ? null : round4(flipRate),
    flipRateUsed: flipRateUsed === null ? null : round4(flipRateUsed),
    rule: "margin = 2 x sd of the paired delta when every pooled verdict flips independently with flipRateUsed (the larger of the observed rate and 3/n)",
  },
  anyRelevantQueries: [...relevant.values()].filter((s) => s.size > 0).length,
  elapsed_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  summary,
  contrasts,
  per_query: perQuery,
};
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      commit: measuredCommit,
      n: queries.length,
      pairsJudged: judged,
      judgeUsage: out.judgeUsage,
      judgeNoise: out.judgeNoise,
      summary,
      contrasts,
    },
    null,
    1,
  ),
);
