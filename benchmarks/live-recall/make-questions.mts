/**
 * Live-memory held-out recall set: question generation.
 *
 * Samples chunks from a READ-ONLY snapshot of a node's memory store and asks a
 * small model to write one question each chunk answers. The output is PRIVATE
 * (it paraphrases the operator's own memory) and lives outside the repository;
 * only the manifest (hashes, counts, model, prompt hash) and the scored ranks
 * are meant to be shared.
 *
 *   node --import tsx benchmarks/live-recall/make-questions.mts \
 *     --snapshot ~/snap.sqlite --out ~/.bitterbot/benchmarks/live-recall/questions.jsonl \
 *     [--n 60] [--seed 1] [--model claude-haiku-4-5]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/io.js";
import { redactSensitiveText } from "../../src/logging/redact.js";

const { values: args } = parseArgs({
  options: {
    snapshot: { type: "string" },
    out: { type: "string" },
    n: { type: "string", default: "60" },
    seed: { type: "string", default: "1" },
    model: { type: "string", default: "claude-haiku-4-5" },
    "min-chars": { type: "string", default: "300" },
    "max-chars": { type: "string", default: "1500" },
  },
  strict: true,
});
if (!args.snapshot || !args.out) {
  throw new Error(
    "usage: --snapshot <sqlite> --out <questions.jsonl> [--n N] [--seed S] [--model M]",
  );
}
const n = Number(args.n);
const seed = String(args.seed);

const PROMPT =
  "You write retrieval test questions. Given a passage from someone's notes or chat history, write ONE question " +
  "that this passage answers and that a person who half-remembers the topic might type into a memory search. " +
  "Rules: at most 25 words; do not copy a sentence from the passage; keep the proper nouns, names, file names, " +
  "numbers or identifiers that make the passage findable; no preamble, output the question only.";

type Row = {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  text: string;
};

const db = new DatabaseSync(args.snapshot, { readOnly: true });
const rows = db
  .prepare(
    `SELECT id, path, source, start_line, end_line, text FROM chunks
     WHERE source IN ('memory', 'sessions') AND model != 'pending'
       AND lifecycle IN ('generated', 'consolidated', 'activated')
       AND length(text) BETWEEN ? AND ?`,
  )
  .all(Number(args["min-chars"]), Number(args["max-chars"])) as unknown as Row[];
const snapshotChunks = (db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c: number }).c;
db.close();

// Deterministic sample: order by sha256(seed + id).
const key = (id: string) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
const ordered = rows.toSorted((a, b) => (key(a.id) < key(b.id) ? -1 : 1));
// Never put a secret in front of a model: skip anything the redactor would change.
const clean = ordered.filter((r) => redactSensitiveText(r.text, { mode: "tools" }) === r.text);
const picked = clean.slice(0, n);
console.log(`eligible=${rows.length} clean=${clean.length} picked=${picked.length}`);

const auth = await resolveApiKeyForProvider({ provider: "anthropic", cfg: loadConfig() });
if (!auth?.apiKey) {
  throw new Error("no Anthropic key resolvable through the normal auth path");
}
const apiKey = auth.apiKey;

async function ask(text: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 120,
      system: PROMPT,
      messages: [{ role: "user", content: `Passage:\n\n${text}` }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return (data.content.find((c) => c.type === "text")?.text ?? "").trim().replaceAll(/\s+/g, " ");
}

mkdirSync(dirname(args.out), { recursive: true });
const lines: string[] = [];
let failed = 0;
for (let i = 0; i < picked.length; i++) {
  const r = picked[i]!;
  try {
    const question = await ask(r.text);
    if (!question) {
      throw new Error("empty question");
    }
    lines.push(
      JSON.stringify({
        chunkId: r.id,
        path: r.path,
        source: r.source,
        startLine: r.start_line,
        endLine: r.end_line,
        textSha256: createHash("sha256").update(r.text).digest("hex"),
        question,
      }),
    );
  } catch (err) {
    failed++;
    console.error(`  [${i + 1}/${picked.length}] ${r.id}: ${String(err).slice(0, 120)}`);
  }
  if ((i + 1) % 10 === 0) {
    console.log(`  ${i + 1}/${picked.length} generated (${failed} failed)`);
  }
}
const body = `${lines.join("\n")}\n`;
writeFileSync(args.out, body, { mode: 0o600 });
const manifest = {
  createdAt: new Date().toISOString(),
  snapshot: args.snapshot,
  snapshotChunks,
  eligible: rows.length,
  clean: clean.length,
  questions: lines.length,
  failed,
  seed,
  model: args.model,
  promptSha256: createHash("sha256").update(PROMPT).digest("hex"),
  questionsSha256: createHash("sha256").update(body).digest("hex"),
};
writeFileSync(`${args.out}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${lines.length} questions to ${args.out}`);
console.log(JSON.stringify(manifest));
