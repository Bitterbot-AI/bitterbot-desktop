/**
 * PLAN-55 Phase 2, consumer 1: chunks stating a superseded value are marked,
 * ranked after current results and tagged [superseded]; a pin back clears it.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import {
  applySupersededMarks,
  propagateSupersededChunks,
  staleValueMatcher,
  SUPERSEDED_TAG,
} from "./canonical-supersede-search.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import type { MemorySearchResult } from "./types.js";

let db: DatabaseSync;
let fts = false;

function open(withFts: boolean): void {
  db = new DatabaseSync(":memory:");
  const res = ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: withFts,
  });
  fts = res.ftsAvailable;
}

function chunk(id: string, text: string, path = "memory/notes.md", line = 1): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, 'memory', ?, ?, ?, 'm', ?, '[]', ?)`,
  ).run(id, path, line, line, `h-${id}`, text, Date.now());
  if (fts) {
    db.prepare(
      `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
       VALUES (?, ?, ?, 'memory', 'm', ?, ?)`,
    ).run(text, id, path, line, line);
  }
}

const event = (over: Partial<CanonicalChangeEvent>): CanonicalChangeEvent => ({
  key: "infra.deploy_endpoint",
  oldValue: "api.acme.com",
  newValue: "api2.acme.com",
  op: "supersede",
  tier: 3,
  source: "owner",
  scope: "global",
  evidence: { ref: null, chunkIds: [] },
  factId: "fact-2",
  at: 1_000,
  ...over,
});

const marks = (): Array<{ chunk_id: string; current_value: string | null }> =>
  db
    .prepare(`SELECT chunk_id, current_value FROM chunk_supersessions ORDER BY chunk_id`)
    .all() as unknown as Array<{ chunk_id: string; current_value: string | null }>;

function result(path: string, line: number, snippet: string, score: number): MemorySearchResult {
  return { path, startLine: line, endLine: line, snippet, score, source: "memory" };
}

describe("staleValueMatcher", () => {
  it("matches whole token sequences only, case-insensitively", () => {
    const m = staleValueMatcher("api.acme.com")!;
    expect(m("Deploy to API.ACME.COM today")).toBe(true);
    expect(m("deploy to api2.acme.com")).toBe(false);
    expect(m("deploy to api.acme.company")).toBe(false);
    expect(staleValueMatcher("New York")!("lives in new   york now")).toBe(true);
  });

  it("skips trivially short, numeric, generic and long values", () => {
    expect(staleValueMatcher("no")).toBeNull();
    expect(staleValueMatcher("42")).toBeNull();
    expect(staleValueMatcher("true")).toBeNull();
    expect(staleValueMatcher("--")).toBeNull();
    expect(staleValueMatcher("x".repeat(201))).toBeNull();
  });
});

describe.each([false, true])("propagateSupersededChunks (fts=%s)", (withFts) => {
  beforeEach(() => open(withFts));

  it("marks chunks stating the old value, not ones stating both or neither", async () => {
    expect(fts).toBe(withFts);
    chunk("a", "The deploy endpoint is api.acme.com.");
    chunk("b", "We moved from api.acme.com to api2.acme.com last week.");
    chunk("c", "Unrelated note about lunch.");
    chunk("d", "Staging uses api.acme.company for tests.");
    const r = await propagateSupersededChunks(db, event({}), {
      ftsTable: withFts && fts ? "chunks_fts" : null,
    });
    expect(r.marked).toBe(1);
    expect(marks()).toEqual([{ chunk_id: "a", current_value: "api2.acme.com" }]);
  });

  it("is idempotent and caps marks per event", async () => {
    for (let i = 0; i < 5; i++) {
      chunk(`c${i}`, `note ${i}: endpoint api.acme.com`);
    }
    const ftsTable = withFts && fts ? "chunks_fts" : null;
    expect((await propagateSupersededChunks(db, event({}), { ftsTable, maxMarks: 3 })).marked).toBe(
      3,
    );
    expect((await propagateSupersededChunks(db, event({}), { ftsTable })).marked).toBe(2);
    expect((await propagateSupersededChunks(db, event({}), { ftsTable })).marked).toBe(0);
    expect(marks()).toHaveLength(5);
  });

  it("a pin back to the old value clears the marks; a further change repoints them", async () => {
    chunk("a", "The deploy endpoint is api.acme.com.");
    const opts = { ftsTable: withFts && fts ? "chunks_fts" : null };
    await propagateSupersededChunks(db, event({}), opts);
    await propagateSupersededChunks(
      db,
      event({ oldValue: "api2.acme.com", newValue: "api3.acme.com", factId: "fact-3" }),
      opts,
    );
    expect(marks()).toEqual([{ chunk_id: "a", current_value: "api3.acme.com" }]);
    await propagateSupersededChunks(
      db,
      event({ oldValue: "api3.acme.com", newValue: "api.acme.com", factId: "fact-4" }),
      opts,
    );
    expect(marks()).toEqual([]);
  });
});

describe("propagateSupersededChunks, non-marking events", () => {
  beforeEach(() => open(false));

  it("ignores adds, soft retires and too-short values; marks on the owner's retire", async () => {
    chunk("a", "The deploy endpoint is api.acme.com.");
    await propagateSupersededChunks(db, event({ op: "add", oldValue: null }));
    await propagateSupersededChunks(
      db,
      event({ op: "retire", newValue: null, retireReason: "decay" }),
    );
    await propagateSupersededChunks(db, event({ oldValue: "no", newValue: "yes" }));
    expect(marks()).toEqual([]);
    await propagateSupersededChunks(
      db,
      event({ op: "retire", newValue: null, retireReason: "owner" }),
    );
    expect(marks()).toEqual([{ chunk_id: "a", current_value: null }]);
    // unretire brings the value back: the mark goes
    await propagateSupersededChunks(
      db,
      event({ op: "unretire", oldValue: null, newValue: "api.acme.com" }),
    );
    expect(marks()).toEqual([]);
  });

  it("never marks the new fact's own evidence chunk", async () => {
    chunk("ev", "old endpoint api.acme.com is wrong");
    await propagateSupersededChunks(db, event({ evidence: { ref: null, chunkIds: ["ev"] } }));
    expect(marks()).toEqual([]);
  });

  it("scans in windows (yielding) and still finds late rows", async () => {
    for (let i = 0; i < 30; i++) {
      chunk(`f${i}`, `filler ${i}`);
    }
    chunk("late", "endpoint api.acme.com");
    const r = await propagateSupersededChunks(db, event({}), { windowRows: 7 });
    expect(r.scanned).toBe(31);
    expect(marks().map((m) => m.chunk_id)).toEqual(["late"]);
  });
});

describe("applySupersededMarks", () => {
  beforeEach(() => open(false));

  it("ranks superseded results after current ones, halves the score and tags them", async () => {
    chunk("old", "The deploy endpoint is api.acme.com.", "memory/a.md", 1);
    chunk("new", "The deploy endpoint is api2.acme.com.", "memory/b.md", 1);
    await propagateSupersededChunks(db, event({}));
    const results = [
      result("memory/a.md", 1, "The deploy endpoint is api.acme.com.", 0.9),
      result("memory/b.md", 1, "The deploy endpoint is api2.acme.com.", 0.8),
    ];
    const out = applySupersededMarks(db, results);
    expect(out).toBe(results); // in place
    expect(out.map((r) => r.path)).toEqual(["memory/b.md", "memory/a.md"]);
    expect(out[1]!.score).toBeCloseTo(0.45);
    expect(out[1]!.snippet.startsWith(SUPERSEDED_TAG)).toBe(true);
    expect(out[1]!.snippet).toContain('infra.deploy_endpoint is now "api2.acme.com"');
    expect(out[1]!.superseded).toEqual([
      { key: "infra.deploy_endpoint", currentValue: "api2.acme.com" },
    ]);
    // Not hidden, and not double-tagged on a second pass.
    applySupersededMarks(db, out);
    expect(out).toHaveLength(2);
    expect(out[1]!.snippet.indexOf(SUPERSEDED_TAG, 1)).toBe(-1);
  });

  it("disambiguates line-0 fact chunks on one path by the snippet", async () => {
    chunk("f1", "user prefers api.acme.com", "sessions/s.jsonl", 0);
    chunk("f2", "user likes tea", "sessions/s.jsonl", 0);
    await propagateSupersededChunks(db, event({}));
    const out = applySupersededMarks(db, [
      result("sessions/s.jsonl", 0, "user prefers api.acme.com", 0.7),
      result("sessions/s.jsonl", 0, "user likes tea", 0.6),
    ]);
    expect(out.map((r) => r.snippet.startsWith(SUPERSEDED_TAG))).toEqual([false, true]);
    expect(out[0]!.snippet).toBe("user likes tea");
  });

  it("is a no-op without marks", () => {
    chunk("a", "text", "memory/a.md", 1);
    const results = [result("memory/a.md", 1, "text", 0.5)];
    expect(applySupersededMarks(db, results)).toEqual([result("memory/a.md", 1, "text", 0.5)]);
  });
});
