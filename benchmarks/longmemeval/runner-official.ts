/**
 * LongMemEval, official protocol.
 *
 * The reference pipeline (xiaowu0162/LongMemEval) defines a third-party run
 * as: feed each question's timestamped history to the memory system without
 * the question, ask the question at `question_date`, write
 * `{question_id, hypothesis}` JSONL, score it with `evaluate_qa.py`. This
 * runner does exactly that against Bitterbot's memory manager:
 *
 *   - the memory system sees only role, content and session date (no gold
 *     ids, no `has_answer`, no `question_type`), one document per session;
 *   - the raw question is the search query, with `question_date` as "now"
 *     for every age-dependent boost, and each session's chunks dated to the
 *     session;
 *   - retrieved chunks map to their sessions; the top-k distinct sessions
 *     (or top-k chunks, `--unit chunk`) are rendered with the official
 *     reader template, date-sorted, with the pinned reader at temperature 0;
 *   - a failed reader call after retries is an empty hypothesis (scored
 *     wrong; the reference script drops such questions, we do not);
 *   - a sidecar `<out>.meta.json` records everything a reader of the number
 *     needs: dataset hash, commit (+dirty), reader, k, unit, boost scale,
 *     session recall of the retrieval stage, errors.
 *
 *   node --import tsx benchmarks/longmemeval/runner-official.ts \
 *     --out benchmarks/longmemeval/results/official-s-haiku.jsonl \
 *     [--oracle] [--limit N | --per-type N] [--reader anthropic/claude-haiku-4-5-20251001] \
 *     [--reading con|direct] [--unit session|chunk] [--k 10] [--max-results 50] [--resume]
 *
 * Then: node --import tsx benchmarks/longmemeval/evaluate-official.ts --hyp <out>
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createBenchmarkMemoryManager } from "./bitterbot-bridge.js";
import {
  buildReaderPrompt,
  type ContextItem,
  firstPerType,
  OFFICIAL_PROTOCOL_REF,
  parseLongMemEvalDate,
  type RawItem,
  READER_MAX_TOKENS,
  READER_TEMPERATURE,
  READER_TEMPLATE_CON,
  READER_TEMPLATE_DIRECT,
  type Reading,
  sessionFileName,
  sessionIdFromPath,
  sessionRecall,
  sessionToNlDocument,
  toInferenceItem,
} from "./official-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    oracle: { type: "boolean", default: false },
    "data-dir": { type: "string", default: join(__dirname, "data") },
    out: { type: "string" },
    limit: { type: "string", default: "0" },
    "per-type": { type: "string", default: "0" },
    /** Dated snapshot ids only; the result is meaningless without one. */
    reader: { type: "string", default: "anthropic/claude-haiku-4-5-20251001" },
    reading: { type: "string", default: "con" },
    unit: { type: "string", default: "session" },
    k: { type: "string", default: "10" },
    "max-results": { type: "string", default: "50" },
    resume: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});
if (!args.out) {
  throw new Error("--out <hypothesis.jsonl> is required");
}
const reading = args.reading as Reading;
if (reading !== "con" && reading !== "direct") {
  throw new Error("--reading must be con or direct");
}
const unit = args.unit as "session" | "chunk";
if (unit !== "session" && unit !== "chunk") {
  throw new Error("--unit must be session or chunk");
}
const k = Number(args.k);
const maxResults = Number(args["max-results"]);
const limit = Number(args.limit) || 0;
const perType = Number(args["per-type"]) || 0;
const outPath = args.out;
const metaPath = `${outPath}.meta.json`;
const retrievalPath = `${outPath}.retrieval.jsonl`;

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

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

// ── Load ──

const dataFile = join(
  args["data-dir"]!,
  args.oracle ? "longmemeval_oracle.json" : "longmemeval_s.json",
);
if (!existsSync(dataFile)) {
  throw new Error(`missing ${dataFile}; run pnpm benchmark:longmemeval:download`);
}
const rawBytes = readFileSync(dataFile);
const dataset = JSON.parse(rawBytes.toString("utf-8")) as RawItem[];
if (dataset.length !== 500) {
  throw new Error(`expected 500 questions, found ${dataset.length}`);
}
let items = perType ? firstPerType(dataset, perType) : dataset;
if (limit) {
  items = items.slice(0, limit);
}

const done = new Set<string>();
if (args.resume && existsSync(outPath)) {
  for (const line of readFileSync(outPath, "utf-8").split("\n")) {
    if (line.trim()) {
      done.add((JSON.parse(line) as { question_id: string }).question_id);
    }
  }
} else if (existsSync(outPath)) {
  throw new Error(`${outPath} exists; pass --resume to continue it or choose another --out`);
}

const measuredCommit = gitCommit();
const startedAt = new Date().toISOString();

type Meta = {
  protocol: string;
  dataset: { file: string; sha256: string; variant: "s" | "oracle"; n: number };
  selection: { limit: number; perType: number; questions: number };
  git_commit: string | null;
  reader: {
    model: string;
    temperature: number;
    maxTokens: number;
    reading: Reading;
    templateSha256: string;
  };
  retrieval: {
    unit: "session" | "chunk";
    k: number;
    candidateChunks: number;
    postFusionBoostScale: "production";
    embedding: string;
    chunking: string;
    clock: "question_date";
    sessionRecall: Record<string, number>;
  };
  started_at: string;
  finished_at?: string;
  elapsed_seconds?: number;
  errors: Array<{ question_id: string; error: string }>;
};

const meta: Meta = {
  protocol: OFFICIAL_PROTOCOL_REF,
  dataset: {
    file: dataFile.split("/").pop()!,
    sha256: sha256(rawBytes),
    variant: args.oracle ? "oracle" : "s",
    n: dataset.length,
  },
  selection: { limit, perType, questions: items.length },
  git_commit: measuredCommit,
  reader: {
    model: args.reader!,
    temperature: READER_TEMPERATURE,
    maxTokens: READER_MAX_TOKENS,
    reading,
    templateSha256: sha256(reading === "con" ? READER_TEMPLATE_CON : READER_TEMPLATE_DIRECT),
  },
  retrieval: {
    unit,
    k,
    candidateChunks: maxResults,
    postFusionBoostScale: "production",
    embedding: "openai/text-embedding-3-small",
    chunking: "markdown 384 tokens / 48 overlap, one document per session",
    clock: "question_date",
    sessionRecall: {},
  },
  started_at: startedAt,
  errors: [],
};
if (existsSync(metaPath) && args.resume) {
  const prev = JSON.parse(readFileSync(metaPath, "utf-8")) as Meta;
  meta.errors = prev.errors ?? [];
  meta.started_at = prev.started_at ?? startedAt;
}

console.log(`LongMemEval official-protocol run`);
console.log(`  data      ${meta.dataset.file} sha256 ${meta.dataset.sha256.slice(0, 12)}`);
console.log(`  questions ${items.length}${done.size ? ` (${done.size} already done)` : ""}`);
console.log(
  `  reader    ${args.reader} temp ${READER_TEMPERATURE} max_tokens ${READER_MAX_TOKENS} reading ${reading}`,
);
console.log(`  retrieval unit ${unit} k ${k} candidates ${maxResults} boost scale production`);
console.log(`  commit    ${measuredCommit}`);

// ── Run ──

const bridge = await createBenchmarkMemoryManager({
  postFusionBoostScale: "production",
  maxResults,
});
const workDir = join(__dirname, ".work-official");
mkdirSync(dirname(outPath), { recursive: true });

async function completeWithRetry(prompt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await bridge.llm.complete({
        model: args.reader!,
        prompt,
        maxTokens: READER_MAX_TOKENS,
        temperature: READER_TEMPERATURE,
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

const recallSums = { any5: 0, all5: 0, anyK: 0, allK: 0, n: 0 };
const t0 = Date.now();
let processed = 0;
for (let i = 0; i < items.length; i++) {
  const raw = items[i]!;
  if (done.has(raw.question_id)) {
    continue;
  }
  const { inference, gold } = toInferenceItem(raw);
  const itemDir = join(workDir, inference.question_id);
  let hypothesis = "";
  let rankedSessions: string[] = [];
  try {
    await bridge.memory.reset();
    rmSync(itemDir, { recursive: true, force: true });
    mkdirSync(itemDir, { recursive: true });
    const files: string[] = [];
    const timestamps: Record<string, number> = {};
    const byId = new Map(inference.sessions.map((s) => [s.id, s] as const));
    for (const s of inference.sessions) {
      const name = sessionFileName(s);
      writeFileSync(join(itemDir, name), sessionToNlDocument(s), "utf-8");
      files.push(join(itemDir, name));
      timestamps[name] = parseLongMemEvalDate(s.date);
    }
    await bridge.memory.ingestMarkdownFiles(files);
    const drained = await bridge.memory.drainPendingEmbeddings();
    if (drained.remaining > 0) {
      meta.errors.push({
        question_id: inference.question_id,
        error: `${drained.remaining} chunk(s) unembedded after retries`,
      });
    }
    bridge.memory.setChunkTimestamps(timestamps);

    const now = parseLongMemEvalDate(inference.question_date);
    const chunks = await bridge.memory.search(inference.question, { maxResults, now });

    // Only this question's sessions count. The store also holds the
    // workspace MEMORY.md and the bundled skill crystals the manager seeds;
    // neither is part of the history, so neither reaches the reader.
    const sessionChunks = chunks.filter((c) => byId.has(sessionIdFromPath(c.path)));
    // Rank sessions by their best chunk (results arrive in fused order).
    const seen = new Set<string>();
    for (const c of sessionChunks) {
      const sid = sessionIdFromPath(c.path);
      if (!seen.has(sid)) {
        seen.add(sid);
        rankedSessions.push(sid);
      }
    }

    let contextItems: ContextItem[];
    if (unit === "session") {
      contextItems = rankedSessions.slice(0, k).map((sid) => {
        const s = byId.get(sid)!;
        return { date: s.date, turns: s.turns };
      });
    } else {
      contextItems = sessionChunks.slice(0, k).map((c) => ({
        date: byId.get(sessionIdFromPath(c.path))!.date,
        text: c.snippet,
      }));
    }
    const prompt = buildReaderPrompt({
      items: contextItems,
      questionDate: inference.question_date,
      question: inference.question,
      reading,
      format: unit === "session" ? "json" : "nl",
    });
    hypothesis = (await completeWithRetry(prompt)).trim();
  } catch (err) {
    meta.errors.push({ question_id: inference.question_id, error: String(err).slice(0, 300) });
    console.error(`  ${inference.question_id}: ${String(err).slice(0, 200)}`);
  } finally {
    rmSync(itemDir, { recursive: true, force: true });
  }

  appendFileSync(
    outPath,
    `${JSON.stringify({ question_id: inference.question_id, hypothesis })}\n`,
  );

  // Retrieval-stage recall over the opaque ids (evaluation-only, computed after search).
  if (!gold.isAbstention && gold.goldOpaqueIds.size > 0) {
    const r5 = sessionRecall(rankedSessions, gold.goldOpaqueIds, 5);
    const rk = sessionRecall(rankedSessions, gold.goldOpaqueIds, k);
    recallSums.any5 += r5.any;
    recallSums.all5 += r5.all;
    recallSums.anyK += rk.any;
    recallSums.allK += rk.all;
    recallSums.n++;
  }
  appendFileSync(
    retrievalPath,
    `${JSON.stringify({
      question_id: inference.question_id,
      ranked: rankedSessions.slice(0, Math.max(k, 10)),
      gold: [...gold.goldOpaqueIds],
      abstention: gold.isAbstention,
    })}\n`,
  );

  processed++;
  if (args.verbose || processed % 10 === 0) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const rAny = recallSums.n ? ((100 * recallSums.any5) / recallSums.n).toFixed(1) : "-";
    console.log(
      `[${i + 1}/${items.length}] ${inference.question_id} elapsed ${elapsed}s session recall_any@5 ${rAny}%`,
    );
    if (args.verbose) {
      console.log(`   A: ${hypothesis.slice(0, 160).replaceAll("\n", " ")}`);
    }
  }
  meta.retrieval.sessionRecall = {
    n: recallSums.n,
    recall_any_5: recallSums.n ? Number((recallSums.any5 / recallSums.n).toFixed(4)) : 0,
    recall_all_5: recallSums.n ? Number((recallSums.all5 / recallSums.n).toFixed(4)) : 0,
    [`recall_any_${k}`]: recallSums.n ? Number((recallSums.anyK / recallSums.n).toFixed(4)) : 0,
    [`recall_all_${k}`]: recallSums.n ? Number((recallSums.allK / recallSums.n).toFixed(4)) : 0,
  };
  meta.finished_at = new Date().toISOString();
  meta.elapsed_seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

await bridge.cleanup();
rmSync(workDir, { recursive: true, force: true });
console.log(`done: ${outPath}`);
console.log(
  JSON.stringify({
    commit: measuredCommit,
    ...meta.retrieval.sessionRecall,
    errors: meta.errors.length,
  }),
);
