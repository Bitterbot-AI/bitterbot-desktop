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

function cognition(db: DatabaseSync, cfg: Record<string, unknown> = {}) {
  const proto = MemoryIndexManager.prototype as unknown as {
    cognitionHealth(this: { db: DatabaseSync; cfg: Record<string, unknown> }): {
      directiveFunnel: Record<string, number>;
      insightPromotion: { promoted: number; rejectedByLeg: Record<string, number> };
      research: { outcomes: Record<string, number>; egressToday: number; egressCapPerDay: number };
    };
  };
  return proto.cognitionHealth.call({ db, cfg });
}

describe("cognitionHealth", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = makeDb();
  });

  it("counts the directive funnel by stage from the audit log", () => {
    const ins = db.prepare(
      `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
       VALUES (?, 'd1', ?, ?, 'epistemic_directives', '{}')`,
    );
    ins.run("a1", "directive_created", 1);
    ins.run("a2", "directive_injected", 2);
    ins.run("a3", "directive_injected", 3);
    ins.run("a4", "directive_answered", 4);
    ins.run("a5", "directive_resolved", 5);
    // An unrelated actor's rows are ignored.
    db.prepare(
      `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
       VALUES ('x', 'c', 'directive_created', 6, 'other', '{}')`,
    ).run();

    const c = cognition(db);
    expect(c.directiveFunnel).toEqual({ created: 1, injected: 2, answered: 1, resolved: 1 });
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
  });
});
