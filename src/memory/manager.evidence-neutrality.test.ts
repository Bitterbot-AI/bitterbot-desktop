/**
 * PLAN-59 Phase 0: observation never alters retrieval.
 *
 * Three managers on three fresh stores built from the same files answer the
 * same queries with mode off, observe and shadow. The returned lists must be
 * identical (same order, same scores, same snippets). Observe and shadow write
 * one retrieval row per returned result (capped at topK) under a digest; off
 * writes nothing; a guest search writes nothing in any mode.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

/** Deterministic unit vectors from the text so vector ranks are stable across stores. */
function vec(text: string): number[] {
  const h = createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest();
  const raw = [h[0]! + 1, h[1]! + 1, h[2]! + 1, h[3]! + 1];
  const norm = Math.hypot(...raw);
  return raw.map((x) => x / norm);
}

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async (text: string) => vec(text),
      embedBatch: async (texts: string[]) => texts.map(vec),
    },
  }),
}));

const NOTES = [
  "# build\n\nthe build runs on CI with pnpm and node 22\n\nthe release gate needs markdownlint\n",
  "# people\n\nVictor reviews the memory pull requests on Tuesday\n\nthe wallet code is restricted\n",
  "# infra\n\nthe gateway serves the control UI on port 19001\n\nsqlite-vec must stay external\n",
  "# dreams\n\nthe dream engine runs every two hours and rewrites MEMORY.md\n\ncuriosity targets expire\n",
];

const QUERIES = [
  "build CI pnpm",
  "who reviews memory pull requests",
  "control UI port",
  "dream engine hours",
];

type Mode = "off" | "observe" | "shadow";

const FIXED_AT = Date.UTC(2026, 9, 1, 0, 0, 0);

const managers: MemoryIndexManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.close();
  }
  for (const r of roots.splice(0)) {
    await fs.rm(r, { recursive: true, force: true });
  }
});

async function openManager(mode: Mode, extra: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `bitterbot-evidence-${mode}-`));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  for (let i = 0; i < NOTES.length; i++) {
    await fs.writeFile(path.join(workspaceDir, "memory", `note-${i}.md`), NOTES[i]!);
  }
  const indexPath = path.join(root, "index.sqlite");
  const cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: true } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          cache: { enabled: false },
          query: { minScore: 0, hybrid: { enabled: true, mergeStrategy: "rrf" } },
        },
      },
      list: [{ id: "main", default: true }],
    },
    memory: {
      dream: { enabled: false },
      consolidation: { enabled: false },
      emotional: { enabled: false },
      coverageDiagnostics: { enabled: false },
      curiosity: { evidence: { mode, ...extra } },
    },
  };
  const { manager } = await getMemorySearchManager({ cfg, agentId: "main" });
  if (!manager) {
    throw new Error("manager missing");
  }
  managers.push(manager);
  await manager.sync({ reason: "test" });
  // The three stores were written at slightly different instants; age-dependent
  // boosts measure from updated_at, so pin every chunk to one timestamp.
  (manager as unknown as { db: DatabaseSync }).db.exec(
    `UPDATE chunks SET created_at = ${FIXED_AT}, updated_at = ${FIXED_AT}, last_accessed_at = NULL`,
  );
  return { manager, indexPath };
}

const count = (file: string, table: string): number => {
  const db = new DatabaseSync(file);
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
  } finally {
    db.close();
  }
};

describe("evidence telemetry is neutral to search (PLAN-59 Phase 0)", () => {
  it("returns identical ordered results in off, observe and shadow mode and writes rows only when on", async () => {
    const now = Date.UTC(2026, 9, 28, 12, 0, 0);
    const off = await openManager("off");
    const observe = await openManager("observe", { topK: 3 });
    const shadow = await openManager("shadow");

    let returnedTotal = 0;
    for (const q of QUERIES) {
      const a = await off.manager.search(q, { maxResults: 5, now, sessionKey: "agent:main:s1" });
      const b = await observe.manager.search(q, {
        maxResults: 5,
        now,
        sessionKey: "agent:main:s1",
      });
      const c = await shadow.manager.search(q, { maxResults: 5, now, sessionKey: "agent:main:s1" });
      expect(a.length).toBeGreaterThan(0);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(c)).toBe(JSON.stringify(a));
      returnedTotal += a.length;
    }
    expect(count(off.indexPath, "retrieval_hits")).toBe(0);
    // observe capped at topK 3 per query, shadow at the default 10 (>= every list here)
    expect(count(observe.indexPath, "retrieval_hits")).toBe(
      QUERIES.length * 3 <= returnedTotal ? QUERIES.length * 3 : returnedTotal,
    );
    expect(count(shadow.indexPath, "retrieval_hits")).toBe(returnedTotal);

    // every observe row carries a digest, a chunk id that exists, a rank and a session digest;
    // the query text is in no row
    const db = new DatabaseSync(observe.indexPath);
    try {
      const rows = db
        .prepare(
          `SELECT r.query_id, r.query_digest, r.session_digest, r.chunk_id, r.rank, r.fused_score,
                  r.channel_ranks_json, r.caller, r.embedding_model, r.scoring_version, c.id AS chunk
             FROM retrieval_hits r LEFT JOIN chunks c ON c.id = r.chunk_id ORDER BY r.id`,
        )
        .all() as unknown as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.chunk).toBe(r.chunk_id);
        expect(String(r.query_digest)).toMatch(/^[0-9a-f]{32}$/);
        expect(String(r.session_digest)).toMatch(/^[0-9a-f]{32}$/);
        expect(typeof r.fused_score).toBe("number");
        expect(r.embedding_model).toBe("mock-embed");
        expect(r.scoring_version).toBe("gccrf-v2");
        expect(r.caller).toBeNull();
        expect(JSON.parse(String(r.channel_ranks_json))).toEqual(expect.any(Object));
      }
      const perQuery = db
        .prepare(
          `SELECT query_id, COUNT(*) AS n, MAX(rank) AS top FROM retrieval_hits GROUP BY query_id`,
        )
        .all() as unknown as Array<{ n: number; top: number }>;
      expect(perQuery).toHaveLength(QUERIES.length);
      for (const p of perQuery) {
        expect(p.n).toBeLessThanOrEqual(3);
        expect(p.top).toBe(p.n);
      }
      const dump = db
        .prepare(
          `SELECT group_concat(query_digest || session_digest || caller, ' ') AS s FROM retrieval_hits`,
        )
        .get() as { s: string | null };
      for (const q of QUERIES) {
        expect(dump.s ?? "").not.toContain(q);
      }
    } finally {
      db.close();
    }
  });

  it("records the caller tag and skips guest searches", async () => {
    const observe = await openManager("observe");
    // The first sync above rebuilt the index through an atomic reindex, which
    // swaps the database file; the writer must follow the new handle.
    await observe.manager.search("build CI pnpm", { maxResults: 3, caller: "memory_search" });
    const before = count(observe.indexPath, "retrieval_hits");
    expect(before).toBeGreaterThan(0);
    const guest = await observe.manager.guestSearch("build CI pnpm", { maxResults: 3 });
    expect(Array.isArray(guest)).toBe(true);
    expect(count(observe.indexPath, "retrieval_hits")).toBe(before);
    const db = new DatabaseSync(observe.indexPath);
    try {
      const callers = db.prepare(`SELECT DISTINCT caller FROM retrieval_hits`).all() as Array<{
        caller: string | null;
      }>;
      expect(callers).toEqual([{ caller: "memory_search" }]);
    } finally {
      db.close();
    }
    expect(observe.manager.getEvidenceTelemetry()?.stats()).toMatchObject({
      mode: "observe",
      retrievalHits: before,
    });
  });

  it("a telemetry writer that throws never breaks search", async () => {
    const observe = await openManager("observe");
    const telemetry = observe.manager.getEvidenceTelemetry();
    expect(telemetry).not.toBeNull();
    const spy = vi.spyOn(telemetry!, "recordRetrieval").mockImplementation(() => {
      throw new Error("telemetry exploded");
    });
    const results = await observe.manager.search("build CI pnpm", { maxResults: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
