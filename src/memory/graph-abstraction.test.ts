import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { QueryPlan } from "./query-planner.js";
import {
  buildGraphAbstractions,
  detectCommunities,
  groupCommunities,
  parseSummary,
} from "./graph-abstraction.js";
import { graphRead } from "./graph-reader.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

function plan(p: Partial<QueryPlan>): QueryPlan {
  return {
    explicitEntities: p.explicitEntities ?? [],
    aliases: p.aliases ?? [],
    conceptualRelations: p.conceptualRelations ?? [],
    hardConstraints: p.hardConstraints ?? [],
    answerType: p.answerType ?? "factual",
    pseudoQueries: p.pseudoQueries ?? [],
  } as QueryPlan;
}

// Build a triangle community a-b-c (all "concept" entities).
function seedTriangle(kg: KnowledgeGraphManager): void {
  const edge = (s: string, t: string) =>
    kg.upsertRelationship(
      {
        sourceName: s,
        sourceType: "concept",
        targetName: t,
        targetType: "concept",
        relationType: "related_to",
      },
      [],
    );
  edge("a", "b");
  edge("b", "c");
  edge("a", "c");
}

describe("detectCommunities", () => {
  it("groups two disjoint cliques into two communities", () => {
    const adj = new Map<string, Set<string>>([
      ["a", new Set(["b", "c"])],
      ["b", new Set(["a", "c"])],
      ["c", new Set(["a", "b"])],
      ["x", new Set(["y"])],
      ["y", new Set(["x"])],
    ]);
    const labels = detectCommunities(adj);
    expect(labels.get("a")).toBe(labels.get("b"));
    expect(labels.get("b")).toBe(labels.get("c"));
    expect(labels.get("x")).toBe(labels.get("y"));
    expect(labels.get("a")).not.toBe(labels.get("x"));
    const groups = groupCommunities(labels);
    expect([...groups.values()].some((g) => g.length === 3)).toBe(true);
  });
});

describe("parseSummary", () => {
  it("parses a fenced JSON object", () => {
    expect(parseSummary('```json\n{"name":"Weather","abstract":"about climate"}\n```')).toEqual({
      name: "Weather",
      abstract: "about climate",
    });
  });
  it("rejects a too-short name", () => {
    expect(parseSummary('{"name":"","abstract":"x"}')).toBeNull();
    expect(parseSummary("garbage")).toBeNull();
  });
});

describe("buildGraphAbstractions", () => {
  it("creates a summary node for a community and wires parent pointers", async () => {
    const db = openTestDb();
    const kg = new KnowledgeGraphManager(db);
    seedTriangle(kg);

    const res = await buildGraphAbstractions({
      db,
      kg,
      minCommunitySize: 3,
      llmCall: async () => JSON.stringify({ name: "cluster one", abstract: "covers a, b and c" }),
    });
    expect(res.created).toBe(1);

    const summary = db
      .prepare(`SELECT id, name FROM entities WHERE entity_type = 'summary'`)
      .get() as { id: string; name: string } | undefined;
    expect(summary?.name).toBe("cluster one");

    const summarizes = db
      .prepare(`SELECT COUNT(*) AS c FROM relationships WHERE relation_type = 'summarizes'`)
      .get() as { c: number };
    expect(summarizes.c).toBe(3);

    const parented = db
      .prepare(`SELECT COUNT(*) AS c FROM entities WHERE parent_entity_id = ?`)
      .get(summary!.id) as { c: number };
    expect(parented.c).toBe(3);
  });

  it("is idempotent — a second pass creates nothing new", async () => {
    const db = openTestDb();
    const kg = new KnowledgeGraphManager(db);
    seedTriangle(kg);
    const llmCall = async () => JSON.stringify({ name: "cluster one", abstract: "x" });
    await buildGraphAbstractions({ db, kg, minCommunitySize: 3, llmCall });
    const second = await buildGraphAbstractions({ db, kg, minCommunitySize: 3, llmCall });
    expect(second.created).toBe(0);
  });

  it("does not summarize communities below the minimum size", async () => {
    const db = openTestDb();
    const kg = new KnowledgeGraphManager(db);
    kg.upsertRelationship(
      {
        sourceName: "a",
        sourceType: "concept",
        targetName: "b",
        targetType: "concept",
        relationType: "related_to",
      },
      [],
    );
    const res = await buildGraphAbstractions({
      db,
      kg,
      minCommunitySize: 3,
      llmCall: async () => JSON.stringify({ name: "x y", abstract: "z" }),
    });
    expect(res.created).toBe(0);
  });
});

describe("graphRead coarse-to-fine fallback", () => {
  it("seeds from a summary's members when no flat entity matches the query", async () => {
    const db = openTestDb();
    const kg = new KnowledgeGraphManager(db);
    seedTriangle(kg);
    // Summary name avoids the query term; only its abstract mentions "climate".
    await buildGraphAbstractions({
      db,
      kg,
      minCommunitySize: 3,
      llmCall: async () => JSON.stringify({ name: "cluster one", abstract: "all about climate" }),
    });

    // "climate" matches no entity name (members are a/b/c, summary is "cluster one"),
    // so the flat resolver is empty and the summary fallback must kick in.
    const res = graphRead(db, kg, plan({ explicitEntities: ["climate"] }), { cacheTtlMs: 0 });
    expect(res.seedEntityIds.length).toBeGreaterThan(0);
  });
});
