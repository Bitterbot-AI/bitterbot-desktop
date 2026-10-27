/**
 * LongMemEval RETRIEVAL-ONLY Runner
 *
 * Computes Recall@K (gold-evidence session present in top-K retrieved sessions)
 * to give an apples-to-apples comparison against MemPalace's reported 96.6% R@5.
 *
 * Key differences from runner.ts and runner-biological.ts:
 *   - No answer generation, no LLM judge — pure retrieval evaluation
 *   - Per-session file ingestion (one .md per session) so we can map chunks → sessions
 *   - Uses the baseline bridge (no consolidation/dream/hormones) to compare against
 *     MemPalace's "raw mode" honestly
 *
 * Methodology mirrors mempalace's longmemeval_bench.py:
 *   1. Ingest the haystack sessions into a fresh memory store per question
 *   2. Search with the question text
 *   3. Dedupe top-K chunks down to unique sessions (best chunk score per session)
 *   4. recall_any@K = 1 if any answer_session_id ∈ top-K sessions, else 0
 *
 * Usage:
 *   node --import tsx benchmarks/longmemeval/runner-retrieval.ts [--oracle] [--limit N]
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import type { HybridChannel } from "../../src/memory/hybrid.js";
import type { MemorySearchResult } from "../../src/memory/types.js";
import { loadDataset, sessionToMarkdown, cleanWorkDir } from "./adapter.js";
import { createBenchmarkMemoryManager } from "./bitterbot-bridge.js";

// ── PLAN-58: per-channel attribution ──
//
// Every result now carries `channels` (rank + native score per channel that
// returned it). From the same fused list we can therefore compute, per
// question, what EACH channel alone would have recalled at K and which
// channel(s) found the gold chunk, without a second search. This is the
// frozen baseline every later retrieval experiment is measured against.

const CHANNELS: readonly HybridChannel[] = ["vector", "keyword", "graph"];

type ChannelRecall = Record<HybridChannel, { recall_any_5: number; recall_any_10: number }>;
/** Which channels contributed to the top-5 fused hit on a gold session. */
type Attribution = "vector-only" | "keyword-only" | "graph-only" | "multi" | "none";

/** Re-rank the fused list by one channel's own rank and dedupe to sessions. */
function sessionsByChannel(chunks: MemorySearchResult[], channel: HybridChannel): string[] {
  const ranked = chunks
    .filter((c) => c.channels?.[channel])
    .toSorted((a, b) => a.channels![channel]!.rank - b.channels![channel]!.rank);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const c of ranked) {
    const sid = sessionIdFromPath(c.path);
    if (!seen.has(sid)) {
      seen.add(sid);
      order.push(sid);
    }
  }
  return order;
}

function channelRecall(chunks: MemorySearchResult[], gold: string[]): ChannelRecall {
  const out = {} as ChannelRecall;
  for (const ch of CHANNELS) {
    const order = sessionsByChannel(chunks, ch);
    const top5 = new Set(order.slice(0, 5));
    const top10 = new Set(order.slice(0, 10));
    out[ch] = {
      recall_any_5: gold.some((g) => top5.has(g)) ? 1 : 0,
      recall_any_10: gold.some((g) => top10.has(g)) ? 1 : 0,
    };
  }
  return out;
}

/** For the first fused top-5 chunk on a gold session, who found it? */
function attribution(chunks: MemorySearchResult[], top5: Set<string>, gold: string[]): Attribution {
  const hit = chunks.find((c) => {
    const sid = sessionIdFromPath(c.path);
    return top5.has(sid) && gold.includes(sid);
  });
  if (!hit?.channels) {
    return "none";
  }
  const found = CHANNELS.filter((ch) => hit.channels![ch]);
  if (found.length > 1) {
    return "multi";
  }
  return found[0] ? (`${found[0]}-only` as Attribution) : "none";
}

/**
 * The commit under test, read ONCE before the first question. A run takes
 * long enough for HEAD to move (the 2026-10-27 baseline was stamped with a
 * commit made while it ran), so the stamp is taken at the start, and a dirty
 * working tree is marked because the measured code is then not that commit.
 */
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

/** The first `n` items of each question_type, keeping dataset order within and across types. */
function firstPerType<T extends { question_type: string }>(dataset: T[], n: number): T[] {
  const taken = new Map<string, number>();
  return dataset.filter((item) => {
    const seen = taken.get(item.question_type) ?? 0;
    if (seen >= n) {
      return false;
    }
    taken.set(item.question_type, seen + 1);
    return true;
  });
}

// ── CLI Args ──

const { values: args } = parseArgs({
  options: {
    oracle: { type: "boolean", default: false },
    limit: { type: "string", default: "0" },
    // First N questions of EACH question_type, in dataset order. The first-N
    // slice of LongMemEval-S is all single-session-user, which cannot show
    // where one channel beats another; a stratified slice can.
    "per-type": { type: "string", default: "0" },
    "max-chunks": { type: "string", default: "50" },
    "data-dir": { type: "string", default: join(__dirname, "data") },
    "output-dir": { type: "string", default: join(__dirname, "results") },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

// ── Helpers ──

function sessionIdFromPath(path: string): string {
  const base = basename(path);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

// ── Evidence-level scoring ──
//
// Session-level recall@5 saturates on LongMemEval-S: a decent embedder puts
// SOME chunk of the gold session in the top 5 nearly every time, so two
// retrievers that are both "pretty good" look identical. The dataset marks the
// turns that actually carry the answer (`has_answer`). Scoring whether one of
// THOSE turns' chunks is retrieved, and at what rank, separates them.

type LineRange = { start: number; end: number };

/**
 * 1-based line ranges of the `has_answer` turns in the markdown
 * sessionToMarkdown() writes: header, date, blank, then per turn the content
 * lines followed by one blank line.
 */
function evidenceLineRanges(
  session: Array<{ role: string; content: string; has_answer?: boolean }>,
): LineRange[] {
  const ranges: LineRange[] = [];
  let line = 4; // lines 1-3: title, date, blank
  for (const turn of session) {
    const n = turn.content.split("\n").length;
    if (turn.has_answer) {
      ranges.push({ start: line, end: line + n - 1 });
    }
    line += n + 1; // content lines + the blank separator
  }
  return ranges;
}

function chunkHitsEvidence(chunk: MemorySearchResult, evidence: Map<string, LineRange[]>): boolean {
  const ranges = evidence.get(sessionIdFromPath(chunk.path));
  if (!ranges) {
    return false;
  }
  return ranges.some((r) => chunk.startLine <= r.end && chunk.endLine >= r.start);
}

/** 1-based rank of the first evidence chunk in `ordered`, or null. */
function firstEvidenceRank(
  ordered: MemorySearchResult[],
  evidence: Map<string, LineRange[]>,
): number | null {
  const i = ordered.findIndex((c) => chunkHitsEvidence(c, evidence));
  return i < 0 ? null : i + 1;
}

type EvidenceRanks = { fused: number | null } & Record<HybridChannel, number | null>;

function evidenceRanks(
  chunks: MemorySearchResult[],
  evidence: Map<string, LineRange[]>,
): EvidenceRanks {
  const out = { fused: firstEvidenceRank(chunks, evidence) } as EvidenceRanks;
  for (const ch of CHANNELS) {
    const ranked = chunks
      .filter((c) => c.channels?.[ch])
      .toSorted((a, b) => a.channels![ch]!.rank - b.channels![ch]!.rank);
    out[ch] = firstEvidenceRank(ranked, evidence);
  }
  return out;
}

interface PerQuestion {
  question_id: string;
  question_type: string;
  num_haystack_sessions: number;
  num_answer_sessions: number;
  retrieved_sessions: string[]; // ordered, unique, by best chunk score
  answer_session_ids: string[];
  recall_any_5: number;
  recall_any_10: number;
  recall_all_5: number;
  recall_all_10: number;
  num_chunks_returned: number;
  /** PLAN-58: what each channel alone would have recalled from the same fused list. */
  channel_recall?: ChannelRecall;
  /** PLAN-58: which channel(s) found the gold chunk in the fused top-5. */
  attribution?: Attribution;
  fusion?: string;
  /**
   * Evidence-level: 1-based rank of the first chunk overlapping a `has_answer`
   * turn, in the fused list and in each channel's own order; null = not in the
   * returned chunks. Session-level numbers above are kept for continuity.
   */
  evidence_rank?: EvidenceRanks;
  num_evidence_turns?: number;
  /** Chunks re-embedded after a transient provider failure, and how many stayed unembedded. */
  embedding_retries?: { embedded: number; remaining: number };
  error?: string;
}

interface Aggregate {
  count: number;
  recall_any_5_sum: number;
  recall_any_10_sum: number;
  recall_all_5_sum: number;
  recall_all_10_sum: number;
  /** PLAN-58 */
  channel_5_sum: Record<HybridChannel, number>;
  channel_10_sum: Record<HybridChannel, number>;
  attribution: Record<Attribution, number>;
  /** Evidence-level sums: hits at 1/5/10 and reciprocal rank, fused and per channel. */
  ev: Record<"fused" | HybridChannel, { at1: number; at5: number; at10: number; rr: number }>;
  ev_count: number;
}

function emptyAgg(): Aggregate {
  return {
    count: 0,
    recall_any_5_sum: 0,
    recall_any_10_sum: 0,
    recall_all_5_sum: 0,
    recall_all_10_sum: 0,
    channel_5_sum: { vector: 0, keyword: 0, graph: 0 },
    channel_10_sum: { vector: 0, keyword: 0, graph: 0 },
    attribution: { "vector-only": 0, "keyword-only": 0, "graph-only": 0, multi: 0, none: 0 },
    ev: {
      fused: { at1: 0, at5: 0, at10: 0, rr: 0 },
      vector: { at1: 0, at5: 0, at10: 0, rr: 0 },
      keyword: { at1: 0, at5: 0, at10: 0, rr: 0 },
      graph: { at1: 0, at5: 0, at10: 0, rr: 0 },
    },
    ev_count: 0,
  };
}

function addToAgg(agg: Aggregate, q: PerQuestion) {
  agg.count++;
  agg.recall_any_5_sum += q.recall_any_5;
  agg.recall_any_10_sum += q.recall_any_10;
  agg.recall_all_5_sum += q.recall_all_5;
  agg.recall_all_10_sum += q.recall_all_10;
  if (q.channel_recall) {
    for (const ch of CHANNELS) {
      agg.channel_5_sum[ch] += q.channel_recall[ch].recall_any_5;
      agg.channel_10_sum[ch] += q.channel_recall[ch].recall_any_10;
    }
  }
  if (q.attribution) {
    agg.attribution[q.attribution] += 1;
  }
  if (q.evidence_rank) {
    agg.ev_count++;
    for (const k of ["fused", ...CHANNELS] as const) {
      const r = q.evidence_rank[k];
      if (r !== null) {
        const e = agg.ev[k];
        if (r <= 1) e.at1++;
        if (r <= 5) e.at5++;
        if (r <= 10) e.at10++;
        e.rr += 1 / r;
      }
    }
  }
}

function fmt(agg: Aggregate) {
  if (agg.count === 0) {
    return { n: 0, "R@5": "—", "R@10": "—", "R@5(all)": "—", "R@10(all)": "—" };
  }
  const pct = (n: number) => ((100 * n) / agg.count).toFixed(1) + "%";
  return {
    n: agg.count,
    "R@5": pct(agg.recall_any_5_sum),
    "R@10": pct(agg.recall_any_10_sum),
    "R@5(all)": pct(agg.recall_all_5_sum),
    "R@10(all)": pct(agg.recall_all_10_sum),
    // PLAN-58: per-channel recall from the same fused list, and who found the gold.
    "vector R@5": pct(agg.channel_5_sum.vector),
    "keyword R@5": pct(agg.channel_5_sum.keyword),
    "graph R@5": pct(agg.channel_5_sum.graph),
    "vector R@10": pct(agg.channel_10_sum.vector),
    "keyword R@10": pct(agg.channel_10_sum.keyword),
    ...(agg.ev_count > 0
      ? Object.fromEntries(
          (["fused", ...CHANNELS] as const).flatMap((k) => [
            [`ev ${k} R@1`, ((100 * agg.ev[k].at1) / agg.ev_count).toFixed(1) + "%"],
            [`ev ${k} R@5`, ((100 * agg.ev[k].at5) / agg.ev_count).toFixed(1) + "%"],
            [`ev ${k} R@10`, ((100 * agg.ev[k].at10) / agg.ev_count).toFixed(1) + "%"],
            [`ev ${k} MRR`, (agg.ev[k].rr / agg.ev_count).toFixed(3)],
          ]),
        )
      : {}),
    attribution: Object.fromEntries(
      Object.entries(agg.attribution).map(([k, v]) => [k, pct(v)]),
    ) as Record<Attribution, string>,
  };
}

// ── Main ──

async function run() {
  const measuredCommit = gitCommit();
  const dataFile = args.oracle
    ? join(args["data-dir"]!, "longmemeval_oracle.json")
    : join(args["data-dir"]!, "longmemeval_s.json");

  if (!existsSync(dataFile)) {
    console.error(`Data file not found: ${dataFile}`);
    console.error("   Run: pnpm benchmark:longmemeval:download");
    process.exit(1);
  }

  const outputDir = args["output-dir"]!;
  mkdirSync(outputDir, { recursive: true });

  const limit = parseInt(args.limit!, 10) || 0;
  const perType = parseInt(args["per-type"]!, 10) || 0;
  const maxChunks = parseInt(args["max-chunks"]!, 10);
  const verbose = args.verbose!;

  console.log("LongMemEval RETRIEVAL-ONLY — Bitterbot");
  console.log(`   Data: ${dataFile}`);
  console.log(`   Max chunks per query: ${maxChunks}`);
  console.log(`   Oracle mode: ${args.oracle}`);
  if (limit) {
    console.log(`   Limit: ${limit} questions`);
  }
  if (perType) {
    console.log(`   Stratified: first ${perType} questions of each question_type`);
  }
  console.log("");

  const dataset = loadDataset(dataFile);
  const items = perType
    ? firstPerType(dataset, perType)
    : limit
      ? dataset.slice(0, limit)
      : dataset;
  console.log(`Loaded ${items.length} questions (of ${dataset.length} total)`);

  const bridge = await createBenchmarkMemoryManager();

  const perQuestion: PerQuestion[] = [];
  const overall = emptyAgg();
  const byType: Record<string, Aggregate> = {};
  const workDir = join(__dirname, ".work-retrieval");

  const t0 = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const progress = `[${i + 1}/${items.length}]`;

    if (!byType[item.question_type]) {
      byType[item.question_type] = emptyAgg();
    }

    if (verbose) {
      console.log(
        `\n${progress} ${item.question_id} (${item.question_type}) — ${item.haystack_sessions.length} sessions`,
      );
    } else if (i % 10 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const r5 = overall.count
        ? ((100 * overall.recall_any_5_sum) / overall.count).toFixed(1) + "%"
        : "—";
      console.log(`${progress} elapsed=${elapsed}s running R@5=${r5}`);
    }

    const itemWorkDir = join(workDir, item.question_id);

    try {
      // Reset memory store
      await bridge.memory.reset();

      // Write each session to its own .md file (so chunk paths encode session id)
      mkdirSync(itemWorkDir, { recursive: true });
      const sessionFiles: string[] = [];
      for (let si = 0; si < item.haystack_sessions.length; si++) {
        const session = item.haystack_sessions[si];
        const date = item.haystack_dates[si] ?? "unknown";
        const sid = item.haystack_session_ids[si] ?? `session_${si}`;
        const md = sessionToMarkdown(session, date, sid);
        const fp = join(itemWorkDir, `${sid}.md`);
        writeFileSync(fp, md, "utf-8");
        sessionFiles.push(fp);
      }

      // Single batch ingest, then retry anything the embedding API dropped so
      // the vector channel sees every chunk (else a flaky minute at the
      // provider reads as a retrieval regression).
      await bridge.memory.ingestMarkdownFiles(sessionFiles);
      const drained = await bridge.memory.drainPendingEmbeddings();
      if (drained.remaining > 0) {
        console.warn(
          `   ${item.question_id}: ${drained.remaining} chunk(s) still unembedded after retries`,
        );
      }

      // Search — request enough chunks to dedupe down to top-10 sessions safely
      const chunks = await bridge.memory.search(item.question, { maxResults: maxChunks });

      // Dedupe to ranked unique sessions (best chunk score per session)
      const seen = new Map<string, number>(); // session_id -> best score
      const order: string[] = [];
      for (const c of chunks) {
        const sid = sessionIdFromPath(c.path);
        if (!seen.has(sid)) {
          seen.set(sid, c.score);
          order.push(sid);
        } else {
          // chunks are returned in score order, so first occurrence is best
        }
      }

      const top5 = new Set(order.slice(0, 5));
      const top10 = new Set(order.slice(0, 10));
      const gold = item.answer_session_ids ?? [];
      // Evidence turns of every gold session, keyed by session id.
      const evidence = new Map<string, LineRange[]>();
      let numEvidenceTurns = 0;
      for (let si = 0; si < item.haystack_sessions.length; si++) {
        const sid = item.haystack_session_ids[si] ?? `session_${si}`;
        if (!gold.includes(sid)) {
          continue;
        }
        const ranges = evidenceLineRanges(item.haystack_sessions[si]);
        if (ranges.length > 0) {
          evidence.set(sid, ranges);
          numEvidenceTurns += ranges.length;
        }
      }

      const recall_any_5 = gold.some((g) => top5.has(g)) ? 1 : 0;
      const recall_any_10 = gold.some((g) => top10.has(g)) ? 1 : 0;
      const recall_all_5 = gold.length > 0 && gold.every((g) => top5.has(g)) ? 1 : 0;
      const recall_all_10 = gold.length > 0 && gold.every((g) => top10.has(g)) ? 1 : 0;

      const q: PerQuestion = {
        question_id: item.question_id,
        question_type: item.question_type,
        num_haystack_sessions: item.haystack_sessions.length,
        num_answer_sessions: gold.length,
        retrieved_sessions: order.slice(0, 10),
        answer_session_ids: gold,
        recall_any_5,
        recall_any_10,
        recall_all_5,
        recall_all_10,
        num_chunks_returned: chunks.length,
        channel_recall: channelRecall(chunks, gold),
        attribution: attribution(chunks, top5, gold),
        fusion: chunks[0]?.fusion,
        ...(evidence.size > 0
          ? { evidence_rank: evidenceRanks(chunks, evidence), num_evidence_turns: numEvidenceTurns }
          : {}),
        ...(drained.remaining > 0 || drained.embedded > 0 ? { embedding_retries: drained } : {}),
      };

      perQuestion.push(q);
      addToAgg(overall, q);
      addToAgg(byType[item.question_type], q);

      if (verbose) {
        console.log(
          `   chunks=${chunks.length} unique_sessions=${order.length} R@5=${recall_any_5} R@10=${recall_any_10}`,
        );
        console.log(`   gold=${gold.join(",")} top5=${[...top5].join(",")}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   Error on ${item.question_id}: ${msg}`);
      perQuestion.push({
        question_id: item.question_id,
        question_type: item.question_type,
        num_haystack_sessions: item.haystack_sessions.length,
        num_answer_sessions: (item.answer_session_ids ?? []).length,
        retrieved_sessions: [],
        answer_session_ids: item.answer_session_ids ?? [],
        recall_any_5: 0,
        recall_any_10: 0,
        recall_all_5: 0,
        recall_all_10: 0,
        num_chunks_returned: 0,
        error: msg,
      });
    } finally {
      rmSync(itemWorkDir, { recursive: true, force: true });
    }
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);

  // Write outputs
  const suffix = args.oracle ? "oracle_retrieval" : "s_retrieval";
  const outputPath = join(outputDir, `bitterbot_longmemeval_${suffix}.json`);
  const summary = {
    dataset: dataFile,
    // PLAN-58: the baseline is only comparable when it names the code it measured.
    git_commit: measuredCommit,
    sampling: perType ? { perType } : limit ? { limit } : { all: true },
    generated_at: new Date().toISOString(),
    n_questions: perQuestion.length,
    elapsed_seconds: parseFloat(totalSec),
    overall: fmt(overall),
    by_question_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, fmt(v)])),
    per_question: perQuestion,
  };
  writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf-8");

  // Console summary
  console.log("");
  console.log(`Done in ${totalSec}s — wrote ${outputPath}`);
  console.log("");
  console.log("Overall:");
  console.log("  ", fmt(overall));
  console.log("");
  console.log("By question type:");
  for (const [type, agg] of Object.entries(byType)) {
    console.log(`  ${type}:`, fmt(agg));
  }

  cleanWorkDir(workDir);
  await bridge.cleanup();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
