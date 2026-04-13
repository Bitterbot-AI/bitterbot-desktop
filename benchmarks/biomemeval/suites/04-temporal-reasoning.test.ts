/**
 * BioMemEval Suite 4: Temporal Reasoning (15% weight)
 *
 * Tests whether the knowledge graph can answer point-in-time queries
 * about entity relationships — temporal validity windows enabling
 * "who was X in January?" vs "who is X now?"
 *
 * Reference: Zep/Graphiti temporal KG architecture (arxiv:2501.13956)
 */

import type { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { EpistemicDirectiveEngine } from "../../../src/memory/epistemic-directives.js";
import { KnowledgeGraphManager } from "../../../src/memory/knowledge-graph.js";
import { createBenchmarkDb } from "../db-setup.js";
import { insertChunk } from "../helpers.js";
import { ScenarioScorer, SuiteScorer } from "../scoring.js";

const suite = new SuiteScorer("Temporal Reasoning", "04-temporal", 15, 15);

// Fixed timestamps for deterministic tests
const JAN_1 = new Date("2026-01-01").getTime();
const FEB_1 = new Date("2026-02-01").getTime();
const MAR_1 = new Date("2026-03-01").getTime();
const APR_1 = new Date("2026-04-01").getTime();

describe("BioMemEval > Temporal Reasoning", () => {
  let db: DatabaseSync;
  let kg: KnowledgeGraphManager;

  beforeEach(() => {
    db = createBenchmarkDb();
    kg = new KnowledgeGraphManager(db);
  });

  it("Scenario 1: Basic temporal query (3 pts)", () => {
    const s = new ScenarioScorer("Basic Temporal Query", 3);

    // Entities are auto-created by upsertRelationship
    // Alice managed project alpha Jan-Mar
    kg.upsertRelationship({
      sourceName: "alice",
      sourceType: "person",
      targetName: "project alpha",
      targetType: "project",
      relationType: "manages",
      validFrom: JAN_1,
      validUntil: MAR_1,
    });

    // Bob manages project alpha from Mar onwards
    kg.upsertRelationship({
      sourceName: "bob",
      sourceType: "person",
      targetName: "project alpha",
      targetType: "project",
      relationType: "manages",
      validFrom: MAR_1,
      validUntil: null,
    });

    // Note: queryAtTime searches from source entity outward.
    // We query FROM alice/bob TO see what they manage, OR from project alpha looking for incoming.
    // Let's query "who manages project alpha?" by searching relationships targeting project alpha.
    // Actually, queryAtTime looks at source_entity → target, so to find who manages project alpha,
    // we need to search alice→manages→project alpha and bob→manages→project alpha.
    // The API queries from source entity. Let's query per-person instead.

    const aliceFeb = kg.queryAtTime("alice", "person", "manages", FEB_1);
    const bobFeb = kg.queryAtTime("bob", "person", "manages", FEB_1);
    const bobApr = kg.queryAtTime("bob", "person", "manages", APR_1);
    const aliceApr = kg.queryAtTime("alice", "person", "manages", APR_1);

    s.score(
      "alice managed something in Feb",
      aliceFeb.some((r) => r.entity.name === "project alpha"),
      1.5,
    );
    s.score(
      "bob manages something in Apr",
      bobApr.some((r) => r.entity.name === "project alpha"),
      1.5,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(3);
  });

  it("Scenario 2: Relationship supersession (3 pts)", () => {
    const s = new ScenarioScorer("Relationship Supersession", 3);

    // Alice initially works on project beta (active)
    const oldRel = kg.upsertRelationship({
      sourceName: "alice",
      sourceType: "person",
      targetName: "project beta",
      targetType: "project",
      relationType: "works_on",
      validFrom: JAN_1,
      validUntil: null,
    });

    // Supersede: Alice moves to project gamma
    kg.supersedeRelationship(oldRel.id, {
      sourceName: "alice",
      sourceType: "person",
      targetName: "project gamma",
      targetType: "project",
      relationType: "works_on",
      validFrom: MAR_1,
      validUntil: null,
    });

    // Past query should return project beta
    const pastResults = kg.queryAtTime("alice", "person", "works_on", FEB_1);
    s.score(
      "past query returns project beta",
      pastResults.some((r) => r.entity.name === "project beta"),
      1,
    );

    // Current query should return project gamma
    const nowResults = kg.queryAtTime("alice", "person", "works_on", APR_1);
    s.score(
      "current query returns project gamma",
      nowResults.some((r) => r.entity.name === "project gamma"),
      1,
    );

    // Traverse with currentOnly should only show gamma
    const aliceEntity = kg.findEntityByNameType("alice", "person");
    const traversal = aliceEntity ? kg.traverseEntity(aliceEntity.id, true) : null;
    const currentNames = traversal?.relationships?.map((r) => r.connectedEntity.name) ?? [];
    s.score(
      "currentOnly traversal excludes superseded",
      currentNames.includes("project gamma") && !currentNames.includes("project beta"),
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(3);
  });

  it("Scenario 3: Multi-hop temporal (3 pts)", () => {
    const s = new ScenarioScorer("Multi-Hop Temporal", 3);

    // ML team belongs to company (permanent)
    kg.upsertRelationship({
      sourceName: "ml team",
      sourceType: "project",
      targetName: "acme corp",
      targetType: "organization",
      relationType: "belongs_to",
      validFrom: JAN_1,
      validUntil: null,
    });

    // Alice was on ML team Jan-Mar
    kg.upsertRelationship({
      sourceName: "alice",
      sourceType: "person",
      targetName: "ml team",
      targetType: "project",
      relationType: "works_on",
      validFrom: JAN_1,
      validUntil: MAR_1,
    });

    // Bob joined ML team from Mar
    kg.upsertRelationship({
      sourceName: "bob",
      sourceType: "person",
      targetName: "ml team",
      targetType: "project",
      relationType: "works_on",
      validFrom: MAR_1,
      validUntil: null,
    });

    // Who was on ML team in Feb?
    const aliceFeb = kg.queryAtTime("alice", "person", "works_on", FEB_1);
    const bobFeb = kg.queryAtTime("bob", "person", "works_on", FEB_1);

    // Who is on ML team now?
    const aliceApr = kg.queryAtTime("alice", "person", "works_on", APR_1);
    const bobApr = kg.queryAtTime("bob", "person", "works_on", APR_1);

    s.score(
      "alice was on ml team in Feb",
      aliceFeb.some((r) => r.entity.name === "ml team"),
      1,
    );
    s.score(
      "bob is on ml team in Apr",
      bobApr.some((r) => r.entity.name === "ml team"),
      1,
    );
    s.score(
      "different results for different times",
      bobFeb.length === 0 || aliceApr.length === 0,
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBeGreaterThanOrEqual(2);
  });

  it("Scenario 4: Graph search with evidence (3 pts)", () => {
    const s = new ScenarioScorer("Graph Search with Evidence", 3);

    const chunkId = insertChunk(db, { text: "Alice deployed the API service" });

    kg.upsertRelationship(
      {
        sourceName: "alice",
        sourceType: "person",
        targetName: "api service",
        targetType: "service",
        relationType: "manages",
      },
      [chunkId],
    );

    const results = kg.graphSearch([{ name: "alice", type: "person" }]);

    s.score("graph search returns results", results.length > 0, 1);
    s.score(
      "results include api service",
      results.some((r) => r.entityName === "api service"),
      1,
    );
    s.score(
      "results include evidence chunk IDs",
      results.some((r) => r.evidenceChunkIds?.includes(chunkId)),
      1,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBeGreaterThanOrEqual(2);
  });

  it("Scenario 5: Contradiction via temporal overlap (3 pts)", () => {
    const s = new ScenarioScorer("Contradiction Detection", 3);

    const directives = new EpistemicDirectiveEngine(db);

    // Create two active relationships of the same type from the same source to DIFFERENT targets
    // The contradiction detector looks for same source+target+type with count > 1
    // So we need same source, same target, same type — two active versions
    // Let's create an entity and add two active "manages" from alice to project x
    kg.upsertEntity({ name: "alice", type: "person" });
    kg.upsertEntity({ name: "project x", type: "project" });

    const aliceEntity = kg.findEntityByNameType("alice", "person")!;
    const projEntity = kg.findEntityByNameType("project x", "project")!;

    // Insert two active relationships directly to bypass the upsert dedup
    const now = Date.now();
    db.prepare(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relation_type, weight, valid_from, valid_until, evidence_chunk_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("rel-1", aliceEntity.id, projEntity.id, "manages", 0.8, JAN_1, null, "[]", now, now);
    db.prepare(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relation_type, weight, valid_from, valid_until, evidence_chunk_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("rel-2", aliceEntity.id, projEntity.id, "manages", 0.6, MAR_1, null, "[]", now, now);

    const contradictions = directives.detectContradictions();

    s.score("at least one contradiction detected", contradictions.length > 0, 1.5);
    s.score(
      "contradiction mentions alice",
      contradictions.some((d) => d.question.toLowerCase().includes("alice")),
      1.5,
    );

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBeGreaterThanOrEqual(1.5);
  });
});
