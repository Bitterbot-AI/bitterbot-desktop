/**
 * PLAN-34 §6.2 — one-time session_trust backfill for pre-migration session
 * chunks. Contract: NULL rows only (live writes stamp at write time), whole
 * run SKIPPED when the sessions.json store loads zero mappings (a transient
 * failure must never permanently stamp everything unknown), genuinely
 * unmapped paths stamped `unknown` (prunable history never improves), and
 * non-session chunks untouched.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

let mockKnownSessions = 0;
let mockTrustByPath: Record<string, string> = {};
const detailedResolverCalls = { n: 0 };

vi.mock("./session-trust.js", () => ({
  buildSessionTrustResolverDetailed: async () => {
    detailedResolverCalls.n++;
    return {
      resolve: (p: string) => mockTrustByPath[p] ?? "unknown",
      knownSessions: mockKnownSessions,
    };
  },
  buildSessionTrustResolver: async () => (p: string) => mockTrustByPath[p] ?? "unknown",
  classifySessionKeyTrust: () => "first_party",
}));

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function seedChunk(
  db: DatabaseSync,
  id: string,
  path: string,
  source: string,
  trust: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       session_trust, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?, 'test', '[]', ?, ?, ?)`,
  ).run(id, path, source, `text ${id}`, `h_${id}`, trust, now, now);
}

function backfill(db: DatabaseSync): Promise<number> {
  const target = Object.assign(Object.create(MemoryIndexManager.prototype) as object, {
    db,
    agentId: "main",
    sessionTrustBackfillDone: false,
  }) as unknown as { backfillSessionTrust(): Promise<number> };
  return target.backfillSessionTrust();
}

function trustOf(db: DatabaseSync, id: string): string | null {
  return (
    (db.prepare(`SELECT session_trust FROM chunks WHERE id = ?`).get(id) as {
      session_trust: string | null;
    }) ?? { session_trust: null }
  ).session_trust;
}

describe("backfillSessionTrust (PLAN-34 §6.2)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = makeDb();
    mockKnownSessions = 0;
    mockTrustByPath = {};
    detailedResolverCalls.n = 0;
  });

  it("stamps NULL session chunks by resolved trust; unmapped paths become unknown", async () => {
    seedChunk(db, "c1", "/s/aaa.jsonl", "sessions", null);
    seedChunk(db, "c2", "/s/aaa.jsonl", "sessions", null); // same path, both stamped
    seedChunk(db, "c3", "/s/bbb.jsonl", "sessions", null); // unmapped → unknown
    seedChunk(db, "c4", "/repo/file.ts", "code", null); // non-session → untouched
    seedChunk(db, "c5", "/s/ccc.jsonl", "sessions", "untrusted"); // already stamped → untouched
    mockKnownSessions = 2;
    mockTrustByPath = { "/s/aaa.jsonl": "first_party" };

    const stamped = await backfill(db);
    expect(stamped).toBe(2); // two DISTINCT paths processed (aaa, bbb)
    expect(trustOf(db, "c1")).toBe("first_party");
    expect(trustOf(db, "c2")).toBe("first_party");
    expect(trustOf(db, "c3")).toBe("unknown");
    expect(trustOf(db, "c4")).toBeNull();
    expect(trustOf(db, "c5")).toBe("untrusted");
  });

  it("skips the entire run when the store loaded zero mappings (transient failure)", async () => {
    seedChunk(db, "c1", "/s/aaa.jsonl", "sessions", null);
    mockKnownSessions = 0; // store unreadable / empty
    mockTrustByPath = { "/s/aaa.jsonl": "first_party" };

    expect(await backfill(db)).toBe(0);
    expect(trustOf(db, "c1")).toBeNull(); // NOT stamped unknown — retried later
  });

  it("is a cheap no-op once no NULL session rows remain — resolver not re-invoked", async () => {
    seedChunk(db, "c1", "/s/aaa.jsonl", "sessions", null);
    mockKnownSessions = 1;
    mockTrustByPath = { "/s/aaa.jsonl": "first_party" };
    expect(await backfill(db)).toBe(1);
    expect(detailedResolverCalls.n).toBe(1);
    // A fresh call (new bare manager, flag reset) short-circuits on the COUNT
    // probe and never rebuilds the resolver.
    expect(await backfill(db)).toBe(0);
    expect(detailedResolverCalls.n).toBe(1); // NOT re-invoked
  });
});
