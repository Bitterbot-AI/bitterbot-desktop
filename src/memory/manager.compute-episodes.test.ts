/**
 * PLAN-57 §4.7: the memory manager registers the compute episode sink and a
 * finished job becomes a searchable episode chunk. Real sqlite-vec.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitComputeEpisode,
  getComputeEpisodeSink,
  resetComputeEpisodesForTest,
} from "../compute/awareness/episodes.js";
import {
  getComputeNudgeSink,
  nudgeCompute,
  resetComputeNudgesForTest,
} from "../compute/awareness/nudges.js";
import { getMemorySearchManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));
vi.mock("./embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embeddings.js")>();
  return {
    ...actual,
    createEmbeddingProvider: async () => ({
      requestedProvider: "local",
      provider: { id: "local", model: "hf:test.gguf", embedQuery, embedBatch },
    }),
  };
});

function createCfg(workspaceDir: string, indexPath: string) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "local",
          store: { path: indexPath, vector: { enabled: true } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

let fixtureRoot: string | null = null;
afterEach(async () => {
  resetComputeEpisodesForTest();
  resetComputeNudgesForTest();
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

describe("compute episodes in memory", () => {
  it("registers the sink on the default manager and writes one episode chunk per job outcome", async () => {
    resetComputeEpisodesForTest();
    resetComputeNudgesForTest();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-compute-episodes-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "notes.md"),
      "# notes\n\nthe build runs on CI\n",
    );
    const { manager } = await getMemorySearchManager({
      cfg: createCfg(workspaceDir, path.join(fixtureRoot, "index.sqlite")),
      agentId: "main",
    });
    expect(getComputeEpisodeSink()).not.toBeNull();
    // Phase 6: the nudge sink reaches this manager's hormones.
    expect(getComputeNudgeSink()).not.toBeNull();
    const hormones = (
      manager as unknown as {
        hormonalManager: { getState: () => { dopamine: number; cortisol: number } };
      }
    ).hormonalManager;
    const beforeNudge = hormones.getState();
    expect(nudgeCompute({ kind: "success", reason: "test" })).toBe(true);
    expect(hormones.getState().dopamine).toBeGreaterThan(beforeNudge.dopamine);
    expect(nudgeCompute({ kind: "setback", reason: "test" })).toBe(true);
    expect(hormones.getState().cortisol).toBeGreaterThan(beforeNudge.cortisol);
    const mgr = manager as unknown as {
      sync: (o: { reason: string }) => Promise<void>;
      writeComputeEpisodeChunk: (ep: unknown) => Promise<string | null>;
      db: {
        prepare: (sql: string) => {
          get: (...a: unknown[]) => unknown;
          all: (...a: unknown[]) => unknown[];
        };
      };
      search: (
        q: string,
        o?: { maxResults?: number },
      ) => Promise<Array<{ text: string; path?: string }>>;
    };
    const episode = {
      jobId: "j-42",
      status: "succeeded",
      mode: "private",
      scope: "lab",
      workload: "sha256",
      items: 200,
      worker: "w1",
      verification: "recomputed",
      error: null,
      origin: "agent",
      sessionKey: "agent:main:main",
      at: Date.UTC(2026, 9, 18, 14, 2),
    };
    await mgr.sync({ reason: "test" });
    emitComputeEpisode(episode);
    // The sink is fire-and-forget; wait for the insert.
    for (let i = 0; i < 50; i += 1) {
      const row = mgr.db
        .prepare(`SELECT id FROM chunks WHERE path = ?`)
        .get("compute/episode/j-42");
      if (row) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const rows = mgr.db
      .prepare(`SELECT id, semantic_type, origin, text FROM chunks WHERE path = ?`)
      .all("compute/episode/j-42") as Array<{
      id: string;
      semantic_type: string;
      origin: string;
      text: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "compute_j-42_succeeded",
      semantic_type: "episode",
      origin: "compute",
    });
    expect(rows[0]!.text).toContain(
      "Compute job j-42 (sha256 x200, private in lab on worker w1) succeeded",
    );
    // The same transition twice is a no-op; a different outcome is a new chunk.
    expect(await mgr.writeComputeEpisodeChunk(episode)).toBeNull();
    expect(await mgr.writeComputeEpisodeChunk({ ...episode, status: "failed" })).toBe(
      "compute_j-42_failed",
    );
    const hits = await mgr.search("compute job j-42", { maxResults: 5 });
    expect(hits.some((h) => h.path === "compute/episode/j-42")).toBe(true);
    expect(hits.find((h) => h.path === "compute/episode/j-42")?.snippet).toContain(
      "Compute job j-42",
    );
    // Closing the manager hands the sink back; a closed manager writes nothing.
    await manager.close();
    expect(getComputeEpisodeSink()).toBeNull();
    expect(getComputeNudgeSink()).toBeNull();
    expect(await mgr.writeComputeEpisodeChunk({ ...episode, status: "expired" })).toBeNull();
  }, 60_000);

  it("attaches the sinks even when the first build is a status probe, and on later cache hits", async () => {
    resetComputeEpisodesForTest();
    resetComputeNudgesForTest();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-compute-episodes-status-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "notes.md"), "# notes\n\nhello\n");
    const cfg = createCfg(workspaceDir, path.join(fixtureRoot, "index.sqlite"));
    // A gateway's first manager build is usually a status probe (health
    // refresh, hormonal accessor). The sinks must not depend on who built it.
    const probe = await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" });
    expect(probe.manager).not.toBeNull();
    expect(getComputeEpisodeSink()).not.toBeNull();
    expect(getComputeNudgeSink()).not.toBeNull();
    // If something cleared the sinks (a previous manager closed), the next
    // get re-attaches them to the live cached instance.
    resetComputeEpisodesForTest();
    resetComputeNudgesForTest();
    const again = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(again.manager).toBe(probe.manager);
    expect(getComputeEpisodeSink()).not.toBeNull();
    expect(getComputeNudgeSink()).not.toBeNull();
    await (probe.manager as unknown as { close: () => Promise<void> }).close();
    expect(getComputeEpisodeSink()).toBeNull();
    expect(getComputeNudgeSink()).toBeNull();
  });
});
