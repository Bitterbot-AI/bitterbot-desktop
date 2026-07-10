/**
 * PLAN-34 Phase 1 — the directive loop's read/inject/answer/resolve state
 * machine. The contract under test: reads never mutate attempts; attempts
 * count real injections at most once per session key; the maxAsks ceiling
 * scopes to user-answerable types (graph_bridge is exempt); two-tier
 * resolution (answered stops injection immediately, resolved_at only after
 * next-cycle survival, contradicted answers never resolve); expireOld
 * softens for asked questions; canonical conflicts become questions; the
 * funnel writes audit rows.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EpistemicDirectiveEngine,
  MAX_ASKS,
  USER_ANSWERABLE_TYPES,
} from "./epistemic-directives.js";
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

function auditEvents(db: DatabaseSync, directiveId: string): string[] {
  return (
    db
      .prepare(
        `SELECT event FROM memory_audit_log
         WHERE chunk_id = ? AND actor = 'epistemic_directives' ORDER BY timestamp`,
      )
      .all(directiveId) as Array<{ event: string }>
  ).map((r) => r.event);
}

function getAttempts(db: DatabaseSync, id: string): number {
  return (
    db.prepare(`SELECT attempts FROM epistemic_directives WHERE id = ?`).get(id) as {
      attempts: number;
    }
  ).attempts;
}

describe("EpistemicDirectiveEngine — PLAN-34 Phase 1 loop", () => {
  let db: DatabaseSync;
  let engine: EpistemicDirectiveEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new EpistemicDirectiveEngine(db);
  });

  it("listOpenDirectives is side-effect-free and user-answerable-only", () => {
    const q = engine.createDirective({ type: "knowledge_gap", question: "What DB do you use?" })!;
    engine.createDirective({ type: "graph_bridge", question: "capture richer triples" });

    const open = engine.listOpenDirectives(5);
    expect(open.map((d) => d.id)).toEqual([q.id]); // graph_bridge excluded
    expect(open.every((d) => USER_ANSWERABLE_TYPES.has(d.directiveType))).toBe(true);
    engine.listOpenDirectives(5);
    engine.listOpenDirectives(5);
    expect(getAttempts(db, q.id)).toBe(0); // reads never mutate
  });

  it("getDirectivesForSession without a session key never increments attempts", () => {
    const q = engine.createDirective({ type: "contradiction", question: "A or B?" })!;
    engine.getDirectivesForSession();
    engine.getDirectivesForSession(undefined);
    expect(getAttempts(db, q.id)).toBe(0);
  });

  it("injection increments once per session key, not per turn", () => {
    const q = engine.createDirective({ type: "contradiction", question: "A or B?" })!;
    engine.getDirectivesForSession({ sessionKey: "s1" });
    engine.getDirectivesForSession({ sessionKey: "s1" }); // same conversation, later turn
    expect(getAttempts(db, q.id)).toBe(1);
    engine.getDirectivesForSession({ sessionKey: "s2" });
    expect(getAttempts(db, q.id)).toBe(2);
    expect(auditEvents(db, q.id)).toEqual([
      "directive_created",
      "directive_injected",
      "directive_injected",
    ]);
  });

  it("user-answerable questions demote after MAX_ASKS sessions; graph_bridge keeps injecting", () => {
    const q = engine.createDirective({ type: "knowledge_gap", question: "gap?" })!;
    const bridge = engine.createDirective({ type: "graph_bridge", question: "nudge" })!;
    for (let i = 0; i < MAX_ASKS + 2; i++) {
      engine.getDirectivesForSession({ sessionKey: `s${i}` });
    }
    expect(getAttempts(db, q.id)).toBe(MAX_ASKS); // stopped being returned at the ceiling
    const injected = engine.getDirectivesForSession({ sessionKey: "s-final" });
    expect(injected.map((d) => d.id)).toEqual([bridge.id]); // PLAN-18 mechanism preserved
    expect(getAttempts(db, bridge.id)).toBeGreaterThan(MAX_ASKS);
    // Demoted, not deleted: still queryable for the extractor.
    expect(engine.listOpenDirectives(5).map((d) => d.id)).toEqual([q.id]);
  });

  it("two-tier resolution: answered stops injection immediately, resolves only after the cutoff", () => {
    const q = engine.createDirective({ type: "contradiction", question: "A or B?" })!;
    expect(engine.markAnswered(q.id, "B")).toBe(true);

    expect(engine.getDirectivesForSession({ sessionKey: "s1" })).toHaveLength(0);
    expect(engine.listOpenDirectives(5)).toHaveLength(0);
    expect(engine.getDirective(q.id)!.status).toBe("answered");
    expect(engine.getDirective(q.id)!.resolvedAt).toBeNull();

    // Same-cycle finalize: answered AFTER the cutoff — survival window open.
    expect(engine.finalizeAnswered(Date.now() - 60_000)).toBe(0);
    // Next cycle: answered BEFORE the cutoff — resolves.
    expect(engine.finalizeAnswered(Date.now() + 60_000)).toBe(1);
    const d = engine.getDirective(q.id)!;
    expect(d.resolvedAt).not.toBeNull();
    expect(d.resolution).toBe("B");
    expect(auditEvents(db, q.id)).toContain("directive_answered");
    expect(auditEvents(db, q.id)).toContain("directive_resolved");
  });

  it("contradicted answers never set resolved_at", () => {
    const q = engine.createDirective({ type: "contradiction", question: "A or B?" })!;
    engine.markAnswered(q.id, "B");
    expect(engine.finalizeAnswered(Date.now() + 60_000, () => true)).toBe(0);
    expect(engine.getDirective(q.id)!.resolvedAt).toBeNull();
    expect(auditEvents(db, q.id)).toContain("directive_answer_contradicted");
    // And it stays out of injection (status is 'answered').
    expect(engine.getDirectivesForSession({ sessionKey: "sX" })).toHaveLength(0);
  });

  it("expireOld deletes never-asked questions but only demotes asked ones (late answers still land)", () => {
    const engineShortExpiry = new EpistemicDirectiveEngine(db, { expiryDays: 0 });
    const asked = engineShortExpiry.createDirective({ type: "knowledge_gap", question: "asked?" })!;
    const neverAsked = engineShortExpiry.createDirective({
      type: "knowledge_gap",
      question: "never asked?",
    })!;
    db.prepare(`UPDATE epistemic_directives SET attempts = 2 WHERE id = ?`).run(asked.id);
    // expiryDays=0 → everything created before "now" is past expiry.
    engineShortExpiry.expireOld();

    expect(engineShortExpiry.getDirective(neverAsked.id)).toBeNull(); // deleted
    const survivor = engineShortExpiry.getDirective(asked.id)!;
    expect(survivor.status).toBe("expired"); // demoted, not deleted
    expect(engineShortExpiry.getDirectivesForSession({ sessionKey: "s" })).toHaveLength(0);
    // A late answer still resolves through the normal path.
    expect(engineShortExpiry.markAnswered(asked.id, "late answer")).toBe(true);
    expect(engineShortExpiry.finalizeAnswered(Date.now() + 60_000)).toBe(1);
  });

  it("sweepCanonicalConflicts turns conflict events into contradiction questions and dedupes by key", () => {
    const insertConflict = db.prepare(
      `INSERT INTO canonical_conflicts
         (id, key, kind, current_value, proposed_value, current_source, proposed_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertConflict.run(
      "c1",
      "project.repo",
      "tier_rejection",
      "A",
      "B",
      "user_directive",
      "extraction",
      Date.now(),
    );
    insertConflict.run(
      "c2",
      "project.repo",
      "rapid_supersede",
      "B",
      "C",
      "extraction",
      "extraction",
      Date.now(),
    );

    expect(engine.sweepCanonicalConflicts()).toBe(1); // one question per key
    const open = engine.listOpenDirectives(5);
    expect(open).toHaveLength(1);
    expect(open[0].directiveType).toBe("contradiction");
    expect(open[0].question).toContain("project.repo");
    expect(open[0].sourceEntityIds).toEqual(["canonical:project.repo"]);

    const conflicts = db
      .prepare(`SELECT consumed_at, directive_id FROM canonical_conflicts ORDER BY id`)
      .all() as Array<{ consumed_at: number | null; directive_id: string | null }>;
    expect(conflicts.every((c) => c.consumed_at !== null)).toBe(true);
    expect(conflicts.every((c) => c.directive_id === open[0].id)).toBe(true);

    // Re-sweep: nothing unconsumed left.
    expect(engine.sweepCanonicalConflicts()).toBe(0);
  });
});
