/**
 * PLAN-18 retrieval-quality benchmark.
 *
 * The point of this file is to answer one question honestly:
 *
 *   Does adding the SAGE graph channel to RRF measurably improve recall
 *   on queries where the answer chunk has weak surface overlap with the
 *   query but strong graph-structural connection?
 *
 * We run three scenarios on an in-memory fixture:
 *
 *   1. single_hop   — answer shares text with query (control; both
 *                     baselines and the graph channel should find it).
 *   2. two_hop      — answer is reachable only via a 2-hop entity bridge;
 *                     no surface overlap with the query. This is the case
 *                     SAGE was designed for.
 *   3. hub_distract — a high-degree hub entity sits between query and
 *                     correct answer, with many spurious neighbors.
 *                     Tests whether structural propagation degenerates
 *                     into hub-shouting under load.
 *
 * "Vector" and "keyword" baselines are simulated with bag-of-words cosine
 * and substring scoring. This is intentional: an embedding provider would
 * make the benchmark non-deterministic and environment-dependent. The
 * baseline approximates what *any* text-similarity retriever would find,
 * so the delta we measure is "what the graph channel adds on top of text
 * retrieval" — exactly the claim we want to validate.
 *
 * Run: `npx vitest run src/memory/graph-reader.bench.ts`
 */

import { describe, expect, it } from "vitest";
import { _clearGraphReaderCache, graphRead } from "./graph-reader.js";
import { mergeHybridResultsRRF, type HybridGraphResult } from "./hybrid.js";
import { KnowledgeGraphManager } from "./knowledge-graph.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { _clearQueryPlanCache, planQueryHeuristic } from "./query-planner.js";
import { requireNodeSqlite } from "./sqlite.js";

type Db = ReturnType<typeof openDb>;

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
  if (ta.length === 0 || tb.length === 0) {
    return 0;
  }
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  for (const t of ta) {
    ca.set(t, (ca.get(t) ?? 0) + 1);
  }
  for (const t of tb) {
    cb.set(t, (cb.get(t) ?? 0) + 1);
  }
  let dot = 0;
  for (const [t, n] of ca) {
    dot += n * (cb.get(t) ?? 0);
  }
  const na = Math.sqrt([...ca.values()].reduce((s, n) => s + n * n, 0));
  const nb = Math.sqrt([...cb.values()].reduce((s, n) => s + n * n, 0));
  return dot / (na * nb);
}

type Chunk = { id: string; text: string; path: string };

function insertChunks(db: Db, chunks: Chunk[]): void {
  const stmt = db.prepare(
    `INSERT INTO chunks
       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, 'memory', 1, 1, ?, 'bench', ?, '[]', ?)`,
  );
  const now = Date.now();
  for (const c of chunks) {
    stmt.run(c.id, c.path, c.id, c.text, now);
  }
}

function vectorChannel(query: string, chunks: Chunk[]) {
  return chunks
    .map((c) => ({
      id: c.id,
      path: c.path,
      startLine: 1,
      endLine: 1,
      source: "memory",
      snippet: c.text.slice(0, 120),
      vectorScore: bowCosine(query, c.text),
    }))
    .toSorted((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, 10);
}

function keywordChannel(query: string, chunks: Chunk[]) {
  const qt = tokenize(query);
  return chunks
    .map((c) => {
      const ct = tokenize(c.text);
      let hits = 0;
      for (const t of qt) {
        if (ct.includes(t)) {
          hits++;
        }
      }
      return {
        id: c.id,
        path: c.path,
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: c.text.slice(0, 120),
        textScore: hits / Math.max(1, qt.length),
      };
    })
    .filter((r) => r.textScore > 0)
    .toSorted((a, b) => b.textScore - a.textScore)
    .slice(0, 10);
}

function graphChannelFromReader(
  db: Db,
  kg: KnowledgeGraphManager,
  query: string,
  chunks: Chunk[],
): HybridGraphResult[] {
  const plan = planQueryHeuristic(query);
  const r = graphRead(db, kg, plan, { hops: 2, cacheTtlMs: 0 });
  if (r.chunks.length === 0) {
    return [];
  }
  const byId = new Map(chunks.map((c) => [c.id, c]));
  return r.chunks
    .map((c) => {
      const meta = byId.get(c.chunkId);
      if (!meta) {
        return null;
      }
      return {
        id: c.chunkId,
        path: meta.path,
        startLine: 1,
        endLine: 1,
        source: "memory",
        snippet: meta.text.slice(0, 120),
        graphScore: c.score,
      } as HybridGraphResult;
    })
    .filter((x): x is HybridGraphResult => x !== null);
}

type Scenario = {
  name: string;
  query: string;
  truth: string; // ground-truth chunk id
};

function evalScenario(
  scenario: Scenario,
  chunks: Chunk[],
  graphChannel: HybridGraphResult[],
): { withGraph: { rank: number; mrr: number }; withoutGraph: { rank: number; mrr: number } } {
  const vector = vectorChannel(scenario.query, chunks);
  const keyword = keywordChannel(scenario.query, chunks);

  const without = mergeHybridResultsRRF({ vector, keyword });
  const withG = mergeHybridResultsRRF({ vector, keyword, graph: graphChannel });

  const rankOf = (list: typeof without): number => {
    const idx = list.findIndex((r) => chunks.find((c) => c.id === scenario.truth)?.path === r.path);
    return idx >= 0 ? idx + 1 : Number.POSITIVE_INFINITY;
  };
  const wr = rankOf(without);
  const gr = rankOf(withG);
  return {
    withoutGraph: { rank: wr, mrr: Number.isFinite(wr) ? 1 / wr : 0 },
    withGraph: { rank: gr, mrr: Number.isFinite(gr) ? 1 / gr : 0 },
  };
}

function buildFixture(
  db: Db,
  kg: KnowledgeGraphManager,
): {
  chunks: Chunk[];
  scenarios: Scenario[];
} {
  const chunks: Chunk[] = [
    // single_hop: query and chunk share the word "Bitterbot"
    {
      id: "c-single-1",
      text: "Bitterbot is a personal AI with living memory.",
      path: "f/single-1.md",
    },
    {
      id: "c-single-noise",
      text: "Random unrelated note about kitchen renovations.",
      path: "f/single-n.md",
    },

    // two_hop: query asks about Alice's database; the answer is the
    // Postgres chunk, which deliberately does NOT contain the words
    // "database", "Alice", or "Project-X" — only the proper noun
    // "Postgres". Vector retrieval has no surface bridge from the query
    // to this chunk. Only the graph hop Alice -> Project-X -> Postgres
    // can reach it.
    { id: "c-alice", text: "Alice leads the team and runs reviews.", path: "f/alice.md" },
    {
      id: "c-projectx",
      text: "Project-X is the main initiative this quarter.",
      path: "f/projectx.md",
    },
    {
      id: "c-postgres",
      text: "Postgres handles all writes for the platform.",
      path: "f/postgres.md",
    },
    {
      id: "c-pg-distract",
      text: "Backup procedures live in the ops handbook.",
      path: "f/backup.md",
    },

    // hub_distract: hub entity with 6 spurious neighbors plus one true answer.
    { id: "c-hub-answer", text: "The cron scheduler runs nightly cleanup.", path: "f/cron.md" },
    { id: "c-hub-spam-1", text: "Coffee notes from last week.", path: "f/spam-1.md" },
    { id: "c-hub-spam-2", text: "Meeting notes about office layout.", path: "f/spam-2.md" },
    { id: "c-hub-spam-3", text: "Travel reimbursement policy.", path: "f/spam-3.md" },
    { id: "c-hub-spam-4", text: "Holiday schedule reminder.", path: "f/spam-4.md" },
    { id: "c-hub-spam-5", text: "Lunch order template.", path: "f/spam-5.md" },
  ];
  insertChunks(db, chunks);

  // Single-hop entity graph.
  kg.upsertEntity({ name: "Bitterbot", type: "project" });
  kg.upsertRelationship(
    {
      sourceName: "Bitterbot",
      sourceType: "project",
      targetName: "Bitterbot",
      targetType: "project",
      relationType: "related_to",
      weight: 0.9,
    },
    ["c-single-1"],
  );

  // Two-hop entity graph: Alice -works_on-> Project-X -uses-> Postgres.
  kg.upsertEntity({ name: "Alice", type: "person" });
  kg.upsertEntity({ name: "Project-X", type: "project" });
  kg.upsertEntity({ name: "Postgres", type: "tool" });
  kg.upsertRelationship(
    {
      sourceName: "Alice",
      sourceType: "person",
      targetName: "Project-X",
      targetType: "project",
      relationType: "works_on",
      weight: 0.9,
    },
    ["c-alice"],
  );
  kg.upsertRelationship(
    {
      sourceName: "Project-X",
      sourceType: "project",
      targetName: "Postgres",
      targetType: "tool",
      relationType: "uses",
      weight: 0.85,
    },
    ["c-postgres"],
  );

  // Hub-distraction graph: Maintenance hub points at 6 chunks; only 1 is correct.
  kg.upsertEntity({ name: "Maintenance", type: "concept" });
  kg.upsertEntity({ name: "CronScheduler", type: "tool" });
  kg.upsertRelationship(
    {
      sourceName: "Maintenance",
      sourceType: "concept",
      targetName: "CronScheduler",
      targetType: "tool",
      relationType: "uses",
      weight: 0.9,
    },
    ["c-hub-answer"],
  );
  for (let i = 1; i <= 5; i++) {
    kg.upsertEntity({ name: `Hub-Note-${i}`, type: "concept" });
    kg.upsertRelationship(
      {
        sourceName: "Maintenance",
        sourceType: "concept",
        targetName: `Hub-Note-${i}`,
        targetType: "concept",
        relationType: "related_to",
        weight: 0.6,
      },
      [`c-hub-spam-${i}`],
    );
  }

  const scenarios: Scenario[] = [
    { name: "single_hop", query: "Tell me about Bitterbot", truth: "c-single-1" },
    { name: "two_hop_bridge", query: "What database does Alice work with?", truth: "c-postgres" },
    {
      name: "hub_distract",
      query: "What does Maintenance use for CronScheduler?",
      truth: "c-hub-answer",
    },
  ];
  return { chunks, scenarios };
}

describe("PLAN-18 retrieval-quality benchmark", () => {
  it("measures recall@5, MRR, and rank delta with vs without the graph channel", () => {
    _clearQueryPlanCache();
    _clearGraphReaderCache();
    const db = openDb();
    const kg = new KnowledgeGraphManager(db);
    const { chunks, scenarios } = buildFixture(db, kg);

    type Row = {
      scenario: string;
      rank_without: number | "miss";
      rank_with: number | "miss";
      mrr_without: number;
      mrr_with: number;
      mrr_delta: number;
    };
    const rows: Row[] = [];

    for (const sc of scenarios) {
      const graphChannel = graphChannelFromReader(db, kg, sc.query, chunks);
      const r = evalScenario(sc, chunks, graphChannel);
      rows.push({
        scenario: sc.name,
        rank_without: Number.isFinite(r.withoutGraph.rank) ? r.withoutGraph.rank : "miss",
        rank_with: Number.isFinite(r.withGraph.rank) ? r.withGraph.rank : "miss",
        mrr_without: r.withoutGraph.mrr,
        mrr_with: r.withGraph.mrr,
        mrr_delta: r.withGraph.mrr - r.withoutGraph.mrr,
      });
    }

    const meanMrrWithout = rows.reduce((s, r) => s + r.mrr_without, 0) / Math.max(1, rows.length);
    const meanMrrWith = rows.reduce((s, r) => s + r.mrr_with, 0) / Math.max(1, rows.length);
    const recallAt5 = (col: "rank_without" | "rank_with") =>
      rows.filter((r) => typeof r[col] === "number" && (r[col] as number) <= 5).length /
      rows.length;

    // Print a human-readable report. Visible with `vitest run --reporter=verbose`
    // or by inspecting stdout.
    /* eslint-disable no-console */
    console.log("\n=== PLAN-18 benchmark ===");
    console.log("scenario           rank_without  rank_with  MRR_Δ");
    for (const r of rows) {
      const rw = typeof r.rank_without === "number" ? String(r.rank_without).padStart(2) : "miss";
      const rg = typeof r.rank_with === "number" ? String(r.rank_with).padStart(2) : "miss";
      console.log(
        `${r.scenario.padEnd(18)} ${rw.padStart(11)} ${rg.padStart(10)}  ${r.mrr_delta >= 0 ? "+" : ""}${r.mrr_delta.toFixed(3)}`,
      );
    }
    console.log("\nAggregate:");
    console.log(`  mean MRR without graph : ${meanMrrWithout.toFixed(3)}`);
    console.log(`  mean MRR with graph    : ${meanMrrWith.toFixed(3)}`);
    console.log(`  recall@5 without graph : ${(recallAt5("rank_without") * 100).toFixed(0)}%`);
    console.log(`  recall@5 with graph    : ${(recallAt5("rank_with") * 100).toFixed(0)}%`);
    /* eslint-enable no-console */

    // Hard assertions: the graph channel must (a) not regress single-hop
    // retrieval and (b) measurably improve at least one scenario where
    // surface-text retrieval struggles.
    const single = rows.find((r) => r.scenario === "single_hop")!;
    expect(single.mrr_with).toBeGreaterThanOrEqual(single.mrr_without - 1e-6);

    const twoHop = rows.find((r) => r.scenario === "two_hop_bridge")!;
    expect(twoHop.mrr_with).toBeGreaterThan(twoHop.mrr_without);

    expect(meanMrrWith).toBeGreaterThan(meanMrrWithout);
  });
});
