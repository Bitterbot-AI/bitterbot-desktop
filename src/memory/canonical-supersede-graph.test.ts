/**
 * PLAN-55 Phase 2, consumer 4: graph edges about the key that point at the
 * old value get the existing `supersede` belief action.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalChangeEvent } from "./canonical-events.js";
import { keyGraphShape, propagateToKnowledgeGraph } from "./canonical-supersede-graph.js";
import { KnowledgeGraphManager, type RelationType } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { addSuppression, factKeyValueHash } from "./memory-suppressions.js";

let db: DatabaseSync;
let kg: KnowledgeGraphManager;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  kg = new KnowledgeGraphManager(db);
});

const event = (over: Partial<CanonicalChangeEvent>): CanonicalChangeEvent => ({
  key: "relationship.spouse.name",
  oldValue: "Donna",
  newValue: "Dana",
  op: "supersede",
  tier: 3,
  source: "owner",
  scope: "global",
  evidence: { ref: null, chunkIds: [] },
  factId: "f",
  at: 1,
  ...over,
});

type Edge = { src: string; tgt: string; rel: string; open: boolean };
const edges = (): Edge[] =>
  (
    db
      .prepare(
        `SELECT s.name AS src, t.name AS tgt, r.relation_type AS rel, r.valid_until IS NULL AS open
           FROM relationships r
           JOIN entities s ON s.id = r.source_entity_id
           JOIN entities t ON t.id = r.target_entity_id
          ORDER BY s.name, r.relation_type, open`,
      )
      .all() as unknown as Array<{ src: string; tgt: string; rel: string; open: number }>
  ).map((r) => ({ ...r, open: r.open === 1 }));

const supersedeBeliefs = (): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM relationship_belief_history WHERE action = 'supersede'`)
      .get() as { n: number }
  ).n;

describe("knowledge-graph propagation", () => {
  it("maps key segments to relations and names a subject only when the key has one", () => {
    const employer = keyGraphShape("user.employer");
    expect([...employer.relations]).toContain("works_at");
    expect([...employer.subjects]).toEqual([]);
    const lang = keyGraphShape("project.bitterbot.language");
    expect([...lang.relations]).toEqual(["uses"]);
    expect([...lang.subjects]).toEqual(["bitterbot"]);
    expect([...keyGraphShape("identity.user.home_city").relations]).toContain("lives_in");
    expect([...keyGraphShape("relationship.spouse_of").relations]).toEqual(["spouse_of"]);
    expect([...keyGraphShape("pet.dog.name").relations]).toEqual([]);
  });

  it("user.employer Acme -> Beta supersedes victor works_at acme", () => {
    kg.upsertRelationship({
      sourceName: "Victor",
      sourceType: "person",
      targetName: "Acme",
      targetType: "organization",
      relationType: "works_at" as RelationType,
    });
    const r = propagateToKnowledgeGraph(
      db,
      kg,
      event({ key: "user.employer", oldValue: "Acme", newValue: "Beta" }),
    );
    expect(r).toEqual({ superseded: 1 });
    expect(edges()).toEqual([
      { src: "victor", tgt: "acme", rel: "works_at", open: false },
      { src: "victor", tgt: "beta", rel: "works_at", open: true },
    ]);
  });

  it("project.bitterbot.language rust -> typescript leaves orchestrator uses rust alone", () => {
    kg.upsertRelationship({
      sourceName: "orchestrator",
      sourceType: "project",
      targetName: "rust",
      targetType: "concept",
      relationType: "uses",
    });
    kg.upsertRelationship({
      sourceName: "bitterbot",
      sourceType: "project",
      targetName: "rust",
      targetType: "concept",
      relationType: "uses",
    });
    propagateToKnowledgeGraph(
      db,
      kg,
      event({ key: "project.bitterbot.language", oldValue: "rust", newValue: "typescript" }),
    );
    expect(edges()).toEqual([
      { src: "bitterbot", tgt: "rust", rel: "uses", open: false },
      { src: "bitterbot", tgt: "typescript", rel: "uses", open: true },
      { src: "orchestrator", tgt: "rust", rel: "uses", open: true },
    ]);
  });

  it("ignores an edge at the old value whose relation the key does not describe", () => {
    kg.upsertRelationship({
      sourceName: "Donna",
      sourceType: "person",
      targetName: "Bitterbot",
      targetType: "project",
      relationType: "works_on",
    });
    expect(propagateToKnowledgeGraph(db, kg, event({}))).toEqual({ superseded: 0 });
  });

  it("supersedes the matching edge with one to the new value and records the belief", () => {
    kg.upsertRelationship({
      sourceName: "Donna",
      sourceType: "person",
      targetName: "Victor",
      targetType: "person",
      relationType: "spouse_of",
    });
    kg.upsertRelationship({
      sourceName: "Donna",
      sourceType: "person",
      targetName: "Bitterbot",
      targetType: "project",
      relationType: "works_on",
    });
    expect(propagateToKnowledgeGraph(db, kg, event({}))).toEqual({ superseded: 1 });
    expect(edges()).toEqual([
      { src: "dana", tgt: "victor", rel: "spouse_of", open: true },
      { src: "donna", tgt: "victor", rel: "spouse_of", open: false },
      { src: "donna", tgt: "bitterbot", rel: "works_on", open: true },
    ]);
    expect(supersedeBeliefs()).toBe(1);
    // Idempotent: the closed edge no longer matches.
    expect(propagateToKnowledgeGraph(db, kg, event({}))).toEqual({ superseded: 0 });
  });

  it("closes without replacement on the owner's retire; ignores soft retires and adds", () => {
    kg.upsertRelationship({
      sourceName: "Victor",
      sourceType: "person",
      targetName: "Acme",
      targetType: "organization",
      relationType: "works_at" as RelationType,
    });
    const base = event({ key: "user.employer", oldValue: "Acme" });
    propagateToKnowledgeGraph(db, kg, { ...base, op: "add", oldValue: null });
    propagateToKnowledgeGraph(db, kg, {
      ...base,
      op: "retire",
      newValue: null,
      retireReason: "decay",
    });
    expect(edges().every((e) => e.open)).toBe(true);
    propagateToKnowledgeGraph(db, kg, {
      ...base,
      op: "retire",
      newValue: null,
      retireReason: "owner",
    });
    expect(edges()).toEqual([{ src: "victor", tgt: "acme", rel: "works_at", open: false }]);
  });

  it("does not write a replacement to a value the owner retired for the key", () => {
    kg.upsertRelationship({
      sourceName: "Donna",
      sourceType: "person",
      targetName: "Victor",
      targetType: "person",
      relationType: "spouse_of",
    });
    addSuppression(db, {
      kind: "fact_key_value",
      hash: factKeyValueHash("relationship.spouse.name", "Dana"),
    });
    propagateToKnowledgeGraph(db, kg, event({}));
    expect(edges()).toEqual([{ src: "donna", tgt: "victor", rel: "spouse_of", open: false }]);
  });
});
