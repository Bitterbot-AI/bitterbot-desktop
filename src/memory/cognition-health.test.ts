/**
 * PLAN-34 Phase 6 — same-DB cognition counters. Exercises the aggregation
 * SQL directly (the method only reads this.db) against seeded audit-log,
 * telemetry, curiosity-target, and meta rows.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

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

type CognitionView = {
  directiveFunnel: Record<string, number>;
  insightPromotion: { promoted: number; rejectedByLeg: Record<string, number> };
  research: { outcomes: Record<string, number>; egressToday: number; egressCapPerDay: number };
  recentFindings: Array<{
    id: string;
    targetId: string | null;
    finding: string;
    sourceUrl: string | null;
    relevance: number | null;
    createdAt: number;
    surfacedAt: number | null;
  }>;
  egress: {
    totalsBySeam: Record<string, number>;
    recent: Array<{
      seam: string;
      destination: string;
      payloadHash: string;
      payloadLen: number;
      createdAt: number;
    }>;
  };
};

// cognitionHealth() delegates to sibling accessors (listResearchFindings /
// listResearchEgress), so the call target must carry the real prototype —
// a bare {db, cfg} object would lose them.
function bareManager(db: DatabaseSync, cfg: Record<string, unknown> = {}) {
  return Object.assign(Object.create(MemoryIndexManager.prototype) as object, {
    db,
    cfg,
  }) as unknown as {
    cognitionHealth(): CognitionView;
    listResearchFindings(limit?: number): CognitionView["recentFindings"];
    listResearchEgress(limit?: number): CognitionView["egress"];
  };
}

function cognition(db: DatabaseSync, cfg: Record<string, unknown> = {}) {
  return bareManager(db, cfg).cognitionHealth();
}

describe("cognitionHealth", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = makeDb();
  });

  it("counts the directive funnel by DISTINCT directive per stage (monotone, not per-event)", () => {
    const ins = db.prepare(
      `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
       VALUES (?, ?, ?, ?, 'epistemic_directives', '{}')`,
    );
    // d1: created, injected in TWO sessions (must count as ONE injected),
    // answered, resolved.
    ins.run("a1", "d1", "directive_created", 1);
    ins.run("a2", "d1", "directive_injected", 2);
    ins.run("a3", "d1", "directive_injected", 3);
    ins.run("a4", "d1", "directive_answered", 4);
    ins.run("a5", "d1", "directive_resolved", 5);
    // d2: created + injected + answer contradicted (the re-ask lane).
    ins.run("b1", "d2", "directive_created", 6);
    ins.run("b2", "d2", "directive_injected", 7);
    ins.run("b3", "d2", "directive_answer_contradicted", 8);
    // An unrelated actor's rows are ignored.
    db.prepare(
      `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
       VALUES ('x', 'c', 'directive_created', 9, 'other', '{}')`,
    ).run();

    const c = cognition(db);
    expect(c.directiveFunnel).toEqual({
      created: 2,
      injected: 2, // two DISTINCT directives injected, not three events
      answered: 1,
      resolved: 1,
      answer_contradicted: 1,
    });
  });

  it("aggregates insight-promotion outcomes from dream telemetry", () => {
    const ins = db.prepare(
      `INSERT INTO dream_telemetry (cycle_id, phase, metric_name, metric_value, created_at)
       VALUES (?, 'promotion', ?, ?, ?)`,
    );
    ins.run("c1", "promoted", 2, 1);
    ins.run("c2", "promoted", 1, 2);
    ins.run("c1", "reject_verifierRejected", 3, 1);
    ins.run("c1", "reject_noFirstPartySource", 1, 1);

    const c = cognition(db);
    expect(c.insightPromotion.promoted).toBe(3);
    expect(c.insightPromotion.rejectedByLeg).toEqual({
      verifierRejected: 3,
      noFirstPartySource: 1,
    });
  });

  it("counts research outcome codes from curiosity target metadata and egress vs cap", () => {
    const ins = db.prepare(
      `INSERT INTO curiosity_targets (id, type, description, priority, metadata, created_at, expires_at)
       VALUES (?, 'knowledge_gap', 'd', 0.5, ?, 0, ?)`,
    );
    ins.run("t1", JSON.stringify({ researchOutcome: "resolved" }), Date.now() + 1000);
    ins.run("t2", JSON.stringify({ researchOutcome: "resolved" }), Date.now() + 1000);
    ins.run("t3", JSON.stringify({ researchOutcome: "irrelevant" }), Date.now() + 1000);
    ins.run("t4", "{}", Date.now() + 1000); // no outcome — ignored

    db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const dayKey = `autoresearch_count_${new Date().toISOString().slice(0, 10)}`;
    db.prepare(`INSERT INTO memory_meta (key, value) VALUES (?, '4')`).run(dayKey);

    const c = cognition(db, { memory: { curiosity: { autoResearch: { maxPerDay: 10 } } } });
    expect(c.research.outcomes).toEqual({ resolved: 2, irrelevant: 1 });
    expect(c.research.egressToday).toBe(4);
    expect(c.research.egressCapPerDay).toBe(10);
  });

  it("degrades to empty structures on a bare DB (no throw)", () => {
    const c = cognition(db);
    expect(c.directiveFunnel).toEqual({});
    expect(c.insightPromotion.promoted).toBe(0);
    expect(c.research.outcomes).toEqual({});
    expect(c.research.egressCapPerDay).toBe(10);
    // Phase 6 §8 detail surfaces degrade the same way pre-migration.
    expect(c.recentFindings).toEqual([]);
    expect(c.egress).toEqual({ totalsBySeam: {}, recent: [] });
  });

  // PLAN-34 Phase 6 (§8): dashboard detail surfaces.

  function seedResearchTables() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_findings (
        id          TEXT PRIMARY KEY,
        target_id   TEXT,
        finding     TEXT NOT NULL,
        source_url  TEXT,
        relevance   REAL,
        created_at  INTEGER NOT NULL,
        surfaced_at INTEGER
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_egress_log (
        id           TEXT PRIMARY KEY,
        seam         TEXT NOT NULL,
        destination  TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_len  INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      )
    `);
  }

  it("lists recent research findings read-only — never marks rows surfaced", () => {
    seedResearchTables();
    const ins = db.prepare(
      `INSERT INTO research_findings (id, target_id, finding, source_url, relevance, created_at, surfaced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("f1", "t1", "older, already voiced", "https://a.example", 0.9, 100, 150);
    ins.run("f2", null, "newest, still pending", null, null, 200, null);

    const c = cognition(db);
    expect(c.recentFindings).toEqual([
      {
        id: "f2",
        targetId: null,
        finding: "newest, still pending",
        sourceUrl: null,
        relevance: null,
        createdAt: 200,
        surfacedAt: null,
      },
      {
        id: "f1",
        targetId: "t1",
        finding: "older, already voiced",
        sourceUrl: "https://a.example",
        relevance: 0.9,
        createdAt: 100,
        surfacedAt: 150,
      },
    ]);

    // The read must not have drained the queue: f2 is still unsurfaced.
    const pending = db
      .prepare(`SELECT id FROM research_findings WHERE surfaced_at IS NULL`)
      .all() as Array<{ id: string }>;
    expect(pending).toEqual([{ id: "f2" }]);
  });

  it("egress totals cover the whole table even when the recent list truncates", () => {
    seedResearchTables();
    const ins = db.prepare(
      `INSERT INTO research_egress_log (id, seam, destination, payload_hash, payload_len, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ins.run("e1", "search-query", "duckduckgo.com", "h1", 42, 1);
    ins.run("e2", "fetch-host", "example.org", "h2", 1024, 2);
    ins.run("e3", "fetch-host", "example.net", "h3", 2048, 3);

    // limit=2 truncates recent to the newest two rows, but the per-seam
    // totals must still account for all three (never understate footprint).
    const eg = bareManager(db).listResearchEgress(2);
    expect(eg.totalsBySeam).toEqual({ "search-query": 1, "fetch-host": 2 });
    expect(eg.recent.map((r) => r.destination)).toEqual(["example.net", "example.org"]);
    expect(eg.recent[0]).toEqual({
      seam: "fetch-host",
      destination: "example.net",
      payloadHash: "h3",
      payloadLen: 2048,
      createdAt: 3,
    });

    // And the cognitionHealth default view carries the same data through.
    const c = cognition(db);
    expect(c.egress.totalsBySeam).toEqual({ "search-query": 1, "fetch-host": 2 });
    expect(c.egress.recent).toHaveLength(3);
  });
});
