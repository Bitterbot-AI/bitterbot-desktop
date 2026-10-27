/**
 * Real agent queries from the event journal.
 *
 * Every `memory_search` tool call the agent made is journaled with its
 * arguments (stream "tool", phase "start"). This pulls the distinct queries
 * out so retrieval can be judged on what the agent actually asks, not on
 * questions a model wrote while looking at the answer. The output paraphrases
 * the operator's conversations, so it is PRIVATE: written 0600 outside the
 * repository, never committed. A manifest with counts and the file hash is.
 *
 *   node --import tsx benchmarks/live-recall/extract-journal-queries.mts \
 *     --journal ~/.bitterbot/event-journal.sqlite --out ~/.bitterbot/benchmarks/live-recall/journal-queries.jsonl [--max 120]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const { values: args } = parseArgs({
  options: {
    journal: { type: "string" },
    out: { type: "string" },
    max: { type: "string", default: "120" },
  },
  strict: true,
});
if (!args.journal || !args.out) {
  throw new Error("usage: --journal <event-journal.sqlite> --out <queries.jsonl> [--max N]");
}
const max = Number(args.max);

type ToolEvent = { phase?: string; name?: string; args?: { query?: unknown } };

const db = new DatabaseSync(args.journal, { readOnly: true });
const rows = db
  .prepare(
    `SELECT seq, ts, session_key AS sk, data_blob AS d FROM event_log WHERE stream = 'tool' ORDER BY seq DESC`,
  )
  .all() as unknown as Array<{ seq: number; ts: number; sk: string | null; d: Uint8Array }>;
db.close();

const seen = new Set<string>();
const picked: Array<{ seq: number; ts: number; sessionKeySha256: string; query: string }> = [];
let calls = 0;
for (const r of rows) {
  let evt: ToolEvent;
  try {
    evt = JSON.parse(gunzipSync(Buffer.from(r.d)).toString("utf-8")) as ToolEvent;
  } catch {
    continue;
  }
  if (evt.name !== "memory_search" || evt.phase !== "start") {
    continue;
  }
  const query = typeof evt.args?.query === "string" ? evt.args.query.trim() : "";
  if (!query) {
    continue;
  }
  calls++;
  const key = query.toLowerCase();
  if (seen.has(key)) {
    continue;
  }
  seen.add(key);
  picked.push({
    seq: r.seq,
    ts: r.ts,
    sessionKeySha256: createHash("sha256")
      .update(r.sk ?? "")
      .digest("hex")
      .slice(0, 16),
    query,
  });
  if (picked.length >= max) {
    break;
  }
}
// Oldest first, so a saved file reads chronologically.
picked.sort((a, b) => a.seq - b.seq);

mkdirSync(dirname(args.out), { recursive: true });
const body = `${picked.map((p) => JSON.stringify(p)).join("\n")}\n`;
writeFileSync(args.out, body, { mode: 0o600 });
const manifest = {
  createdAt: new Date().toISOString(),
  journal: args.journal,
  toolEvents: rows.length,
  memorySearchCalls: calls,
  distinctQueries: picked.length,
  oldest: picked[0] ? new Date(picked[0].ts).toISOString() : null,
  newest: picked.at(-1) ? new Date(picked.at(-1)!.ts).toISOString() : null,
  queriesSha256: createHash("sha256").update(body).digest("hex"),
};
writeFileSync(`${args.out}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
