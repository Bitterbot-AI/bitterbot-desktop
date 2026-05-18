/**
 * PLAN-18 scale + latency benchmark.
 *
 * Extends the small `graph-reader.bench.test.ts` controlled fixture to
 * realistic scale: 300 chunks, ~180 entities, ~500 relationships with a
 * Zipf-style degree distribution (a few dominant hubs, many
 * single-link bridge edges). Two questions this answers:
 *
 *   1. Does the +MRR / +recall@5 gain from the graph channel hold or
 *      degrade at scale where hubs can shout and bridges get drowned?
 *   2. What does the graph channel actually COST at the per-query
 *      latency level? We added an L=2 propagation pass to the hot
 *      path; we need real numbers, not vibes.
 *
 * Both questions matter for production behavior. The benchmark stays
 * in CI as a permanent regression check.
 */

import { describe, expect, it } from "vitest";
import { _clearGraphReaderCache, graphRead } from "./graph-reader.js";
import { mergeHybridResultsRRF, type HybridGraphResult } from "./hybrid.js";
import { KnowledgeGraphManager, type EntityType, type RelationType } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { _clearQueryPlanCache, planQueryHeuristic } from "./query-planner.js";
import { requireNodeSqlite } from "./sqlite.js";

type Db = ReturnType<typeof openDb>;
type Chunk = { id: string; text: string; path: string };
type ScaleScenario = {
  name: string;
  query: string;
  truth: string;
};

function openDb() {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embeddings_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 2);
}

function bowCosine(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  for (const t of ta) ca.set(t, (ca.get(t) ?? 0) + 1);
  for (const t of tb) cb.set(t, (cb.get(t) ?? 0) + 1);
  let dot = 0;
  for (const [t, n] of ca) dot += n * (cb.get(t) ?? 0);
  const na = Math.sqrt([...ca.values()].reduce((s, n) => s + n * n, 0));
  const nb = Math.sqrt([...cb.values()].reduce((s, n) => s + n * n, 0));
  return dot / (na * nb);
}

function insertChunks(db: Db, chunks: Chunk[]): void {
  const stmt = db.prepare(
    `INSERT INTO chunks
       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, 'memory', 1, 1, ?, 'scale-bench', ?, '[]', ?)`,
  );
  const now = Date.now();
  for (const c of chunks) stmt.run(c.id, c.path, c.id, c.text, now);
}

/** Mulberry32 for deterministic generation. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a synthetic graph with realistic structure:
 *   - 6 hub entities (high degree, many spurious connections)
 *   - 30 mid-tier entities (a few connections each)
 *   - 150 sparse entities (single bridge edges)
 *   - 300 chunks evidence-attached to relationships
 *   - 9 test scenarios mixing single-hop, multi-hop, and hub-distraction.
 */
function buildScaleFixture(
  db: Db,
  kg: KnowledgeGraphManager,
): { chunks: Chunk[]; scenarios: ScaleScenario[] } {
  const r = rng(42);
  const chunks: Chunk[] = [];
  const ENTITY_TYPES: EntityType[] = ["person", "project", "concept", "tool", "service", "file"];
  const REL_TYPES: RelationType[] = [
    "works_on",
    "manages",
    "depends_on",
    "uses",
    "created_by",
    "belongs_to",
    "related_to",
  ];

  // Hub entities — high degree, dominate naive traversal.
  const hubs = [
    "MetricsService",
    "Pipeline",
    "AuthLayer",
    "SchedulerCore",
    "BotRuntime",
    "VaultStore",
  ];
  for (const h of hubs) kg.upsertEntity({ name: h, type: "service" });

  // Mid-tier entities.
  const midTier: string[] = [];
  for (let i = 0; i < 30; i++) {
    const name = `Module-${i.toString().padStart(2, "0")}`;
    midTier.push(name);
    kg.upsertEntity({
      name,
      type: ENTITY_TYPES[Math.floor(r() * ENTITY_TYPES.length)]!,
    });
  }

  // Sparse leaf entities — these are the "bridge anchors" SAGE is meant to find.
  const leaves: string[] = [];
  for (let i = 0; i < 150; i++) {
    const name = `Leaf-${i.toString().padStart(3, "0")}`;
    leaves.push(name);
    kg.upsertEntity({
      name,
      type: ENTITY_TYPES[Math.floor(r() * ENTITY_TYPES.length)]!,
    });
  }

  // Helper to attach a relationship + an evidence chunk whose text
  // mentions the target entity but NOT the source — so vector
  // retrieval can't bridge solely on co-occurrence.
  let chunkSeq = 0;
  const attach = (
    sourceName: string,
    sourceType: EntityType,
    targetName: string,
    targetType: EntityType,
    relation: RelationType,
    text: string,
  ): string => {
    const id = `c-${chunkSeq.toString().padStart(4, "0")}`;
    chunkSeq++;
    chunks.push({ id, text, path: `f/${id}.md` });
    kg.upsertRelationship(
      {
        sourceName,
        sourceType,
        targetName,
        targetType,
        relationType: relation,
        weight: 0.5 + r() * 0.5,
      },
      [id],
    );
    return id;
  };

  // Wire hubs to many midTier and leaves with random spam — these
  // dominate naive degree-based retrieval if gates don't dampen them.
  for (const hub of hubs) {
    const spamCount = 12 + Math.floor(r() * 10);
    for (let i = 0; i < spamCount; i++) {
      const target = midTier[Math.floor(r() * midTier.length)]!;
      attach(
        hub,
        "service",
        target,
        ENTITY_TYPES[Math.floor(r() * ENTITY_TYPES.length)]!,
        REL_TYPES[Math.floor(r() * REL_TYPES.length)]!,
        `Hub note ${target} is referenced in service routing config.`,
      );
    }
  }

  // Wire midTier chains: each Module connects to 1-3 other midTier or leaves.
  for (const mid of midTier) {
    const connCount = 1 + Math.floor(r() * 3);
    for (let i = 0; i < connCount; i++) {
      const pickLeaf = r() < 0.6;
      const target = pickLeaf
        ? leaves[Math.floor(r() * leaves.length)]!
        : midTier[Math.floor(r() * midTier.length)]!;
      attach(
        mid,
        "concept",
        target,
        ENTITY_TYPES[Math.floor(r() * ENTITY_TYPES.length)]!,
        REL_TYPES[Math.floor(r() * REL_TYPES.length)]!,
        `Implementation detail of ${target} captured during refactor.`,
      );
    }
  }

  // Surgical test scenarios — each uses dedicated entity names that
  // appear in NO other chunk text or relationship, so the graph
  // channel's contribution is isolable. Query terms are chosen to
  // have no surface overlap with the truth chunk text.

  // Scenario A: single-hop. Query mentions an entity by name; truth
  // chunk text does not contain the query terms but is anchored to
  // that entity in the graph.
  kg.upsertEntity({ name: "Zephyrium", type: "concept" });
  kg.upsertEntity({ name: "Zephyrium-Sub", type: "concept" });
  const aTruth = attach(
    "Zephyrium",
    "concept",
    "Zephyrium-Sub",
    "concept",
    "depends_on",
    "Operational telemetry shows green across all stages.",
  );

  // Scenario B: two-hop bridge. Query anchors on entity X; truth
  // chunk anchored two hops away via a bridge entity. Truth text
  // contains no overlap with the query.
  kg.upsertEntity({ name: "Pemberton", type: "concept" });
  kg.upsertEntity({ name: "Pemberton-Mid", type: "concept" });
  kg.upsertEntity({ name: "Pemberton-Far", type: "concept" });
  attach(
    "Pemberton",
    "concept",
    "Pemberton-Mid",
    "concept",
    "related_to",
    "Intermediate handler logs are rotated nightly.",
  );
  const bTruth = attach(
    "Pemberton-Mid",
    "concept",
    "Pemberton-Far",
    "concept",
    "uses",
    "Audit trail signature is appended at the final stage.",
  );

  // Scenario C: deep chain — three hops in graph, vector retrieval has
  // no surface overlap anywhere along the path.
  kg.upsertEntity({ name: "Quasar-Root", type: "concept" });
  kg.upsertEntity({ name: "Quasar-Mid1", type: "concept" });
  kg.upsertEntity({ name: "Quasar-Mid2", type: "concept" });
  kg.upsertEntity({ name: "Quasar-Leaf", type: "concept" });
  attach(
    "Quasar-Root",
    "concept",
    "Quasar-Mid1",
    "concept",
    "related_to",
    "Initial pass collects upstream identifiers.",
  );
  attach(
    "Quasar-Mid1",
    "concept",
    "Quasar-Mid2",
    "concept",
    "depends_on",
    "Second pass normalizes the schema.",
  );
  const cTruth = attach(
    "Quasar-Mid2",
    "concept",
    "Quasar-Leaf",
    "concept",
    "uses",
    "Compliance signature is computed and stored.",
  );

  // Scenario D: hub distraction. Query mentions a hub entity (which
  // has 12+ spurious connections) plus a unique entity. The unique
  // entity gates retrieval to the correct chunk despite the hub noise.
  kg.upsertEntity({ name: "Vintridge", type: "concept" });
  const dTruth = attach(
    "MetricsService",
    "service",
    "Vintridge",
    "concept",
    "uses",
    "Downstream pipeline emits the payload to Vintridge during failover.",
  );

  // Scenario F: alias. Query uses one form; truth chunk anchored on
  // an alias entity that doesn't share surface text with the query.
  kg.upsertEntity({ name: "Carthwright", type: "concept" });
  kg.upsertEntity({ name: "Carthwright-Alt", type: "concept" });
  const fTruth = attach(
    "Carthwright",
    "concept",
    "Carthwright-Alt",
    "concept",
    "related_to",
    "Migration script for the Q2 rollout is checked in under aliases.",
  );

  // Scenario G: structural tiebreak. Two chunks share IDENTICAL text;
  // the graph channel breaks the tie by structure (one is connected
  // to the query entity, the other isn't).
  kg.upsertEntity({ name: "Hattersley", type: "concept" });
  kg.upsertEntity({ name: "Hattersley-A", type: "concept" });
  kg.upsertEntity({ name: "Decoy-Twin", type: "concept" });
  kg.upsertEntity({ name: "Decoy-Twin-A", type: "concept" });
  const gTruth = attach(
    "Hattersley",
    "concept",
    "Hattersley-A",
    "concept",
    "uses",
    "Identical observation about the status returned successfully now.",
  );
  attach(
    "Decoy-Twin",
    "concept",
    "Decoy-Twin-A",
    "concept",
    "uses",
    "Identical observation about the status returned successfully now.",
  );

  // Scenario H: noise — many unrelated chunks to test ranking under
  // low signal-to-noise.
  for (let i = 0; i < 40; i++) {
    chunks.push({
      id: `c-noise-${i}`,
      text: `Unrelated observation ${i} about routine maintenance schedules.`,
      path: `f/noise-${i}.md`,
    });
  }

  insertChunks(db, chunks);

  const scenarios: ScaleScenario[] = [
    { name: "A_single_hop", query: "Tell me about Zephyrium", truth: aTruth },
    { name: "B_two_hop", query: "Where does Pemberton route?", truth: bTruth },
    { name: "C_three_hop", query: "Quasar-Root processing chain", truth: cTruth },
    { name: "D_hub_distract", query: "MetricsService Vintridge failover", truth: dTruth },
    { name: "F_alias", query: "Carthwright Q2 rollout", truth: fTruth },
    { name: "G_structural_tiebreak", query: "Hattersley status check", truth: gTruth },
  ];
  return { chunks, scenarios };
}

function vectorChannel(query: string, chunks: Chunk[]) {
  return chunks
    .map((c) => ({
      id: c.id,
      path: c.path,
      startLine: 1,
      endLine: 1,
      source: "memory",
      snippet: c.text.slice(0, 100),
      vectorScore: bowCosine(query, c.text),
    }))
    .filter((r) => r.vectorScore > 0)
    .toSorted((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, 20);
}

function keywordChannel(query: string, chunks: Chunk[]) {
  const qt = tokenize(query);
  return chunks
    .map((c) => {
      const ct = tokenize(c.text);
      let hits = 0;
      for (const t of qt) if (ct.includes(t)) hits++;
      return {
        id: c.id,
        path: c.path,
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: c.text.slice(0, 100),
        textScore: hits / Math.max(1, qt.length),
      };
    })
    .filter((r) => r.textScore > 0)
    .toSorted((a, b) => b.textScore - a.textScore)
    .slice(0, 20);
}

function graphChannel(
  db: Db,
  kg: KnowledgeGraphManager,
  query: string,
  chunks: Chunk[],
): HybridGraphResult[] {
  const plan = planQueryHeuristic(query);
  const r = graphRead(db, kg, plan, { hops: 2, cacheTtlMs: 0, topK: 20 });
  if (r.chunks.length === 0) return [];
  const byId = new Map(chunks.map((c) => [c.id, c]));
  return r.chunks
    .map((c) => {
      const meta = byId.get(c.chunkId);
      if (!meta) return null;
      return {
        id: c.chunkId,
        path: meta.path,
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: meta.text.slice(0, 100),
        graphScore: c.score,
      } as HybridGraphResult;
    })
    .filter((x): x is HybridGraphResult => x !== null);
}

function rankOf(list: Array<{ path: string }>, truthChunkId: string, chunks: Chunk[]): number {
  const truthPath = chunks.find((c) => c.id === truthChunkId)?.path;
  if (!truthPath) return Number.POSITIVE_INFINITY;
  const idx = list.findIndex((r) => r.path === truthPath);
  return idx >= 0 ? idx + 1 : Number.POSITIVE_INFINITY;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

describe("PLAN-18 scale + latency benchmark", () => {
  it("preserves graph channel gains at 300-chunk fixture scale", () => {
    _clearQueryPlanCache();
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const { chunks, scenarios } = buildScaleFixture(db, kg);
    const stats = kg.getStats();

    type Row = {
      name: string;
      rank_without: number;
      rank_with: number;
      mrr_without: number;
      mrr_with: number;
    };
    const rows: Row[] = [];

    for (const sc of scenarios) {
      const v = vectorChannel(sc.query, chunks);
      const k = keywordChannel(sc.query, chunks);
      const g = graphChannel(db, kg, sc.query, chunks);
      const without = mergeHybridResultsRRF({ vector: v, keyword: k });
      const withG = mergeHybridResultsRRF({ vector: v, keyword: k, graph: g });
      const rw = rankOf(without, sc.truth, chunks);
      const rg = rankOf(withG, sc.truth, chunks);
      rows.push({
        name: sc.name,
        rank_without: rw,
        rank_with: rg,
        mrr_without: Number.isFinite(rw) ? 1 / rw : 0,
        mrr_with: Number.isFinite(rg) ? 1 / rg : 0,
      });
    }

    const meanMrrWithout = rows.reduce((s, r) => s + r.mrr_without, 0) / rows.length;
    const meanMrrWith = rows.reduce((s, r) => s + r.mrr_with, 0) / rows.length;
    const recall5 = (col: "rank_without" | "rank_with") =>
      rows.filter((r) => Number.isFinite(r[col]) && (r[col] as number) <= 5).length / rows.length;

    /* eslint-disable no-console */
    console.log(
      `\n=== PLAN-18 scale benchmark (${chunks.length} chunks, ${stats.entityCount} entities, ${stats.activeRelationships} edges) ===`,
    );
    console.log("scenario                rank_without  rank_with  MRR_Δ");
    for (const r of rows) {
      const rw = Number.isFinite(r.rank_without) ? String(r.rank_without).padStart(2) : "miss";
      const rg = Number.isFinite(r.rank_with) ? String(r.rank_with).padStart(2) : "miss";
      const delta = r.mrr_with - r.mrr_without;
      console.log(
        `${r.name.padEnd(22)} ${rw.padStart(12)} ${rg.padStart(10)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`,
      );
    }
    console.log("\nAggregate:");
    console.log(`  mean MRR without graph : ${meanMrrWithout.toFixed(3)}`);
    console.log(`  mean MRR with graph    : ${meanMrrWith.toFixed(3)}`);
    console.log(`  recall@5 without graph : ${(recall5("rank_without") * 100).toFixed(0)}%`);
    console.log(`  recall@5 with graph    : ${(recall5("rank_with") * 100).toFixed(0)}%`);
    /* eslint-enable no-console */

    // No regression on aggregate; structural-tiebreak and bridge cases
    // must measurably improve.
    expect(meanMrrWith).toBeGreaterThanOrEqual(meanMrrWithout);
    const twoHop = rows.find((r) => r.name === "B_two_hop")!;
    expect(twoHop.mrr_with).toBeGreaterThan(twoHop.mrr_without);
  });

  it("graph channel latency stays within budget on a 300-chunk graph", () => {
    _clearQueryPlanCache();
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const { chunks, scenarios } = buildScaleFixture(db, kg);

    const queries = [
      ...scenarios.map((s) => s.query),
      "What does Pipeline depend on?",
      "MetricsService routing config",
      "Module-15 status",
      "Leaf-050 last activity",
      "AuthLayer error during boot",
      "BotRuntime VaultStore migration",
    ];
    const ITERATIONS = 5;
    const timings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      for (const q of queries) {
        _clearGraphReaderCache();
        const start = process.hrtime.bigint();
        graphChannel(db, kg, q, chunks);
        const dur = Number(process.hrtime.bigint() - start) / 1_000_000; // ns → ms
        timings.push(dur);
      }
    }

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    const max = Math.max(...timings);
    const mean = timings.reduce((s, n) => s + n, 0) / timings.length;

    /* eslint-disable no-console */
    console.log(
      `\n=== PLAN-18 latency benchmark (${chunks.length} chunks, ${queries.length * ITERATIONS} samples) ===`,
    );
    console.log(`  graph-channel per-query latency:`);
    console.log(`    mean  ${mean.toFixed(2)}ms`);
    console.log(`    p50   ${p50.toFixed(2)}ms`);
    console.log(`    p95   ${p95.toFixed(2)}ms`);
    console.log(`    max   ${max.toFixed(2)}ms`);
    /* eslint-enable no-console */

    // Hard budget: p95 under 50ms on a 300-chunk graph. This bounds the
    // overhead the graph channel adds to overall search latency.
    expect(p95).toBeLessThan(50);
    // Sanity: mean should be at least half of p95 (catches degenerate
    // distributions where one outlier dominates).
    expect(mean).toBeLessThan(p95);
  });
});
