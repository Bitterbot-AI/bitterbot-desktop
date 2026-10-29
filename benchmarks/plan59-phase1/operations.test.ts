import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBoundValidity,
  applyConsolidateCluster,
  clusterDiagnostics,
  describeReembed,
  findBoundValidityCandidates,
  findClusterCandidates,
  parentIdFor,
  qualifyClusters,
  quotedCost,
  SEPARATOR,
} from "./operations.js";
import {
  addHint,
  fakeEmbedding,
  insertChunk,
  openSyntheticStore,
  type SyntheticStore,
} from "./test-support.js";

const NOW = 1_800_000_000_000;
const opened: SyntheticStore[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
});

async function storeWithCluster() {
  const s = await openSyntheticStore();
  opened.push(s);
  for (let i = 1; i <= 4; i++) {
    insertChunk(
      s.db,
      {
        id: `m${i}`,
        path: "sessions/alpha.jsonl",
        startLine: i * 10,
        endLine: i * 10 + 5,
        text: `member ${i} text`,
        importance: 0.2 * i,
        accessCount: i,
        lastAccessedAt: NOW - i * 1000,
      },
      s.hasVec,
    );
  }
  insertChunk(s.db, { id: "other", path: "memory/other.md", text: "unrelated" }, s.hasVec);
  insertChunk(
    s.db,
    {
      id: "demoted",
      path: "sessions/alpha.jsonl",
      parentId: "p0",
      lifecycle: "consolidated",
      lifecycleState: "consolidated",
    },
    s.hasVec,
  );
  insertChunk(
    s.db,
    {
      id: "archived",
      path: "sessions/alpha.jsonl",
      lifecycle: "archived",
      lifecycleState: "archived",
    },
    s.hasVec,
  );
  addHint(s.db, "m1", "m2", 0.9);
  addHint(s.db, "m2", "m3", 0.86);
  addHint(s.db, "m3", "m4", 0.84); // below the bar
  addHint(s.db, "m1", "demoted", 0.95); // already demoted: excluded
  addHint(s.db, "m1", "archived", 0.95); // not live: excluded
  addHint(s.db, "other", "m1", 0.5);
  return s;
}

describe("findClusterCandidates", () => {
  it("builds connected components over live pairs at or above the bar", async () => {
    const s = await storeWithCluster();
    const cands = findClusterCandidates(s.db);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.memberIds).toEqual(["m1", "m2", "m3"]);
    expect(cands[0]!.families).toEqual(["sessions/alpha.jsonl"]);
    expect(cands[0]!.pairCount).toBe(2);
    expect(cands[0]!.minSimilarity).toBeCloseTo(0.86, 10);
    expect(cands[0]!.lastAccessedAt).toBe(NOW - 1000);
    expect(findClusterCandidates(s.db, { minSimilarity: 0.8 })[0]!.memberIds).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  it("caps a component at the configured member count by weighted degree", async () => {
    const s = await openSyntheticStore();
    opened.push(s);
    for (let i = 0; i < 9; i++) insertChunk(s.db, { id: `n${i}`, path: "p" }, s.hasVec);
    for (let i = 1; i < 9; i++) addHint(s.db, "n0", `n${i}`, 0.9); // hub n0
    addHint(s.db, "n1", "n2", 0.9);
    const [c] = findClusterCandidates(s.db, { maxMembers: 3 });
    expect(c!.memberIds).toEqual(["n0", "n1", "n2"]);
  });
});

describe("qualifyClusters", () => {
  it("keeps clusters with two members in the top 5 of enough queries", () => {
    const c = {
      kind: "consolidate_cluster" as const,
      id: "cc",
      families: ["p"],
      memberIds: ["a", "b", "c"],
      pairCount: 2,
      minSimilarity: 0.9,
      lastAccessedAt: null,
    };
    const tops = [
      ["a", "b", "x", "y", "z"],
      ["x", "a", "y", "c", "z"],
      ["a", "x", "y", "z", "w", "b"], // b at rank 6 does not count
      ["b", "c"],
    ];
    expect(qualifyClusters([c], tops, 3)).toHaveLength(1);
    expect(qualifyClusters([c], tops, 3)[0]!.coSurfaceQueries).toBe(3);
    expect(qualifyClusters([c], tops, 4)).toHaveLength(0);
  });
});

describe("applyConsolidateCluster", () => {
  it("creates one parent, demotes the members, deletes nothing, and is confined to its fork", async () => {
    const s = await storeWithCluster();
    const twin = `${s.path}.twin`;
    copyFileSync(s.path, twin);
    const [op] = findClusterCandidates(s.db);
    let embedCalls = 0;
    const result = await applyConsolidateCluster(s.db, op!, {
      embed: async () => {
        embedCalls++;
        return fakeEmbedding(1);
      },
      now: NOW,
    });
    expect(embedCalls).toBe(1);
    expect(result.parentId).toBe(parentIdFor(["m3", "m1", "m2"]));
    expect(result.cost).toMatchObject({ chunksTouched: 4, embeddingCalls: 1 });

    const parent = s.db.prepare(`SELECT * FROM chunks WHERE id = ?`).get(result.parentId) as Record<
      string,
      unknown
    >;
    expect(parent.path).toBe("sessions/alpha.jsonl");
    expect(parent.text).toBe(["member 1 text", "member 2 text", "member 3 text"].join(SEPARATOR));
    expect(parent.importance_score).toBeCloseTo(0.6, 10);
    expect(parent.access_count).toBe(6);
    expect(parent.lifecycle).toBe("generated");
    expect(parent.parent_id).toBeNull();
    expect(parent.start_line).toBe(-1);
    expect(parent.end_line).toBe(-1);

    const members = s.db
      .prepare(
        `SELECT id, parent_id, lifecycle, lifecycle_state, importance_score, hygiene_done, text FROM chunks WHERE id IN ('m1','m2','m3') ORDER BY id`,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    expect(members).toHaveLength(3);
    for (const m of members) {
      expect(m.parent_id).toBe(result.parentId);
      expect(m.lifecycle).toBe("consolidated");
      expect(m.lifecycle_state).toBe("consolidated");
      expect(m.hygiene_done).toBe(1);
      expect(String(m.text)).toMatch(/^member \d text$/);
    }
    expect((members[0] as { importance_score: number }).importance_score).toBeCloseTo(0.1, 10);
    expect((s.db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as { c: number }).c).toBe(8);
    // index rows: parent in, members out, bystanders untouched
    const ftsIds = (
      s.db.prepare(`SELECT id FROM chunks_fts ORDER BY id`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ftsIds).toContain(result.parentId);
    expect(ftsIds).not.toContain("m1");
    expect(ftsIds).toContain("m4");
    expect(ftsIds).toContain("other");
    if (s.hasVec) {
      const vecIds = (s.db.prepare(`SELECT id FROM chunks_vec`).all() as Array<{ id: string }>).map(
        (r) => r.id,
      );
      expect(vecIds).toContain(result.parentId);
      expect(vecIds).not.toContain("m2");
      expect(vecIds).toContain("m4");
    }
    expect(
      (
        s.db.prepare(`SELECT COUNT(*) AS c FROM memory_audit_log WHERE event = 'merged'`).get() as {
          c: number;
        }
      ).c,
    ).toBe(3);

    // m4's only partner is now demoted, so nothing is left to cluster
    expect(findClusterCandidates(s.db, { minSimilarity: 0.8 })).toHaveLength(0);
    // the twin copy (another fork) is untouched
    const t = new DatabaseSync(twin, { readOnly: true });
    expect(
      (
        t.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE parent_id IS NOT NULL`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    expect(t.prepare(`SELECT id FROM chunks WHERE id = ?`).get(result.parentId)).toBeUndefined();
    t.close();
  });

  it("gives parents on one path distinct negative line spans", async () => {
    const s = await openSyntheticStore();
    opened.push(s);
    for (const id of ["a1", "a2", "b1", "b2"]) insertChunk(s.db, { id, path: "p" }, s.hasVec);
    addHint(s.db, "a1", "a2", 0.9);
    addHint(s.db, "b1", "b2", 0.9);
    const cands = findClusterCandidates(s.db);
    expect(cands).toHaveLength(2);
    const ctx = { embed: async () => fakeEmbedding(2), now: NOW };
    const first = await applyConsolidateCluster(s.db, cands[0]!, ctx);
    const second = await applyConsolidateCluster(s.db, cands[1]!, ctx);
    const spans = s.db
      .prepare(
        `SELECT id, start_line, end_line FROM chunks WHERE id IN (?, ?) ORDER BY start_line DESC`,
      )
      .all(first.parentId, second.parentId) as unknown as Array<{
      start_line: number;
      end_line: number;
    }>;
    expect(spans.map((x) => [x.start_line, x.end_line])).toEqual([
      [-1, -1],
      [-2, -2],
    ]);
  });

  it("refuses to re-demote a member that already has a parent", async () => {
    const s = await storeWithCluster();
    const [op] = findClusterCandidates(s.db);
    await applyConsolidateCluster(s.db, op!, { embed: async () => fakeEmbedding(1), now: NOW });
    await expect(
      applyConsolidateCluster(s.db, op!, { embed: async () => fakeEmbedding(1), now: NOW }),
    ).rejects.toThrow(/already demoted/);
  });
});

describe("bound_validity", () => {
  it("finds superseded facts with dated validity and null evidence chunks only", async () => {
    const s = await openSyntheticStore();
    opened.push(s);
    insertChunk(s.db, { id: "e1", path: "memory/facts.md" }, s.hasVec);
    insertChunk(s.db, { id: "e2", path: "memory/facts.md", validTimeEnd: 5 }, s.hasVec);
    insertChunk(
      s.db,
      { id: "e3", path: "sessions/x.jsonl", accessCount: 1, lastAccessedAt: 77 },
      s.hasVec,
    );
    const ins = s.db.prepare(
      `INSERT INTO canonical_facts (id, key, value, valid_until, superseded_by, evidence_chunk_ids) VALUES (?, 'k', 'v', ?, ?, ?)`,
    );
    ins.run("f1", 4000, "f9", JSON.stringify(["e1", "e2", "missing", "e3"]));
    ins.run("f2", 4000, "f9", JSON.stringify(["e2"])); // nothing left to bound
    ins.run("f3", null, "f9", JSON.stringify(["e1"])); // no valid_until
    ins.run("f4", 4000, null, JSON.stringify(["e1"])); // not superseded
    const cands = findBoundValidityCandidates(s.db);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({
      id: "bv_f1",
      factId: "f1",
      validUntil: 4000,
      chunkIds: ["e1", "e3"],
      families: ["memory/facts.md", "sessions/x.jsonl"],
      lastAccessedAt: 77,
    });
    expect(quotedCost(cands[0]!)).toMatchObject({ chunksTouched: 2, embeddingCalls: 0 });

    const r = applyBoundValidity(s.db, cands[0]!, { now: NOW });
    expect(r.changed).toEqual(["e1", "e3"]);
    expect(r.cost.chunksTouched).toBe(2);
    const rows = s.db
      .prepare(`SELECT id, valid_time_end, text FROM chunks ORDER BY id`)
      .all() as unknown as Array<{
      id: string;
      valid_time_end: number | null;
      text: string;
    }>;
    expect(rows.map((x) => [x.id, x.valid_time_end])).toEqual([
      ["e1", 4000],
      ["e2", 5],
      ["e3", 4000],
    ]);
    // idempotent: a second application touches nothing
    expect(applyBoundValidity(s.db, cands[0]!, { now: NOW }).changed).toEqual([]);
    expect(findBoundValidityCandidates(s.db)).toHaveLength(0);
  });
});

describe("describeReembed", () => {
  it("is inapplicable with one embedding model and applicable when another appears", async () => {
    const s = await openSyntheticStore();
    opened.push(s);
    insertChunk(s.db, { id: "a", path: "p" }, s.hasVec);
    insertChunk(s.db, { id: "pending", path: "p", model: "pending" }, s.hasVec);
    expect(describeReembed(s.db, "text-embedding-3-small").applicable).toBe(false);
    insertChunk(s.db, { id: "b", path: "p", model: "text-embedding-ada-002" }, s.hasVec);
    const d = describeReembed(s.db, "text-embedding-3-small");
    expect(d.applicable).toBe(true);
    expect(d.models).toHaveLength(2);
  });
});

describe("clusterDiagnostics", () => {
  it("counts co-surfacing at top 5 and top 10, single-member surfacing and gold ranks", () => {
    const c = {
      kind: "consolidate_cluster" as const,
      id: "cc",
      families: ["p"],
      memberIds: ["a", "b"],
      pairCount: 1,
      minSimilarity: 0.9,
      lastAccessedAt: null,
    };
    const dev = [
      { chunkId: "a", fusedRank: 7, topTenIds: ["x", "y", "z", "w", "v", "u", "a", "b"] },
      { chunkId: "q", fusedRank: null, topTenIds: ["a", "b", "x"] },
      { chunkId: "r", fusedRank: 1, topTenIds: ["r", "x"] },
    ];
    const d = clusterDiagnostics([c], dev);
    expect(d.clusters[0]).toEqual({
      id: "cc",
      members: 2,
      coSurfaceTop5: 1,
      coSurfaceTop10: 2,
      anyMemberTop10: 2,
      goldQueries: 1,
      goldRanks: [7],
    });
    expect(d.clustersWithAnyMemberTop10).toBe(1);
    expect(d.devQueriesWithAnyMemberTop10).toBe(2);
    expect(d.devQueriesWithGoldInCluster).toBe(1);
  });
});
