/**
 * PLAN-57 §4.6: a profile change under the same model puts the index on
 * hold (no vector written, vector search paused) until an explicit
 * migration rebuilds it. A provider or model change keeps its existing
 * automatic reindex path and is not exercised here.
 *
 * Uses the REAL sqlite-vec extension so the vector writes are genuine.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);
let digest = "sha256:one";
const resolveDigest = vi.fn(async () => ({ digest, fingerprint: `fp-${digest}` }));

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
      provider: { id: "local", model: "hf:test.gguf", embedQuery, embedBatch, resolveDigest },
    }),
  };
});

type Mgr = MemoryIndexManager & {
  ingestScratchNote: (text: string, importance: number) => void;
  backfillPendingEmbeddings: (opts?: {
    limit?: number;
  }) => Promise<{ embedded: number; remaining: number }>;
  embeddingMigrationPlan: () => { hold: { conflicts: string[] } | null };
  migrateEmbeddingProfile: () => Promise<void>;
  readMeta: () => { profile?: { modelDigest?: string; dimensions?: number } } | null;
};

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
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
  digest = "sha256:one";
});

describe("embedding profile hold and migration", () => {
  it("records the profile, holds on a digest change under the same model, and migrates on demand", async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-profile-hold-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const indexPath = path.join(fixtureRoot, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "notes.md"),
      "# notes\n\nthe build runs on CI\n",
    );

    const first = await getMemorySearchManager({
      cfg: createCfg(workspaceDir, indexPath),
      agentId: "main",
    });
    const mgr = first.manager as unknown as Mgr;
    await mgr.sync({ reason: "test" });
    expect(resolveDigest).toHaveBeenCalled();
    const metaAfterSync = mgr.readMeta();
    expect(metaAfterSync?.profile).toMatchObject({ modelDigest: "sha256:one", dimensions: 3 });
    expect(mgr.status()).toMatchObject({
      embeddingProfile: { modelDigest: "sha256:one", dimensions: 3, normalise: "l2" },
      computeRouting: "pool",
    });
    expect(mgr.status().embeddingHold).toBeUndefined();
    const hits = await mgr.search("build CI", { maxResults: 3 });
    expect(hits.length).toBeGreaterThan(0);
    embedBatch.mockClear();

    // The weights change under the same model name (an Ollama tag re-pulled,
    // a GGUF replaced in place). Simulate by forcing re-resolution.
    digest = "sha256:two";
    (mgr as unknown as { embeddingProfile: unknown }).embeddingProfile = null;
    await fs.writeFile(
      path.join(workspaceDir, "memory", "more.md"),
      "# more\n\nanother fact here\n",
    );
    (mgr as unknown as { dirty: boolean }).dirty = true;
    await mgr.sync({ reason: "test" });
    expect(mgr.embeddingMigrationPlan().hold?.conflicts[0]).toMatch(/model digest/);
    expect(mgr.status().embeddingHold?.conflicts).toHaveLength(1);
    // Held: nothing embedded, the new file not indexed, vector search paused.
    expect(embedBatch).not.toHaveBeenCalled();
    expect(await mgr.search("build CI", { maxResults: 3 })).toEqual([]);
    const probe = new DatabaseSync(indexPath);
    expect(
      (
        probe.prepare(`SELECT COUNT(*) c FROM chunks WHERE path LIKE '%more.md'`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    probe.close();
    // Scratch notes written while held stay pending rather than getting a foreign vector.
    mgr.ingestScratchNote("held note", 0.9);
    expect((await mgr.backfillPendingEmbeddings()).embedded).toBe(0);

    await mgr.migrateEmbeddingProfile();
    expect(mgr.embeddingMigrationPlan().hold).toBeNull();
    expect(mgr.readMeta()?.profile).toMatchObject({ modelDigest: "sha256:two" });
    expect(embedBatch).toHaveBeenCalled();
    const probe2 = new DatabaseSync(indexPath);
    expect(
      (
        probe2.prepare(`SELECT COUNT(*) c FROM chunks WHERE path LIKE '%more.md'`).get() as {
          c: number;
        }
      ).c,
    ).toBeGreaterThan(0);
    probe2.close();
    expect((await mgr.search("another fact", { maxResults: 3 })).length).toBeGreaterThan(0);
    await mgr.close();
  });
});
