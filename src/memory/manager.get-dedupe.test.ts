/**
 * Regression test for the duplicate cold-boot memory build. The manager is only
 * inserted into the cache after its (multi-second, synchronous) constructor
 * returns, so concurrent first-time callers each used to build a full manager,
 * doubling the ~20-minute warm-up. get() now caches the in-flight promise, so
 * concurrent gets for the same key share one build.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

let providerBuilds = 0;

vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
  watch: () => ({ on: () => {}, close: async () => {} }),
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => {
    providerBuilds += 1;
    // Small delay so two concurrent get() calls overlap during this await —
    // the exact window where the pre-fix race double-built the manager.
    await new Promise((r) => setTimeout(r, 20));
    return {
      requestedProvider: "openai",
      provider: {
        id: "openai",
        model: "text-embedding-3-small",
        embedQuery: async () => [0.1, 0.2, 0.3],
        embedBatch: async () => [],
      },
      openAi: {
        baseUrl: "https://api.openai.com/v1",
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        model: "text-embedding-3-small",
      },
    };
  },
}));

let fixtureRoot: string;
let managers: Array<MemoryIndexManager | null> = [];

function createCfg(workspaceDir: string, indexPath: string) {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          store: { path: indexPath, vector: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-dedupe-"));
  await fs.mkdir(path.join(fixtureRoot, "workspace", "memory"), { recursive: true });
});

afterAll(async () => {
  for (const m of managers) {
    try {
      await m?.close?.();
    } catch {
      // ignore
    }
  }
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("MemoryIndexManager.get de-dupes concurrent builds", () => {
  it("builds once when called concurrently for the same key", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const indexPath = path.join(fixtureRoot, "index.sqlite");
    const cfg = createCfg(workspaceDir, indexPath);

    providerBuilds = 0;
    const [a, b] = await Promise.all([
      getMemorySearchManager({ cfg, agentId: "main" }),
      getMemorySearchManager({ cfg, agentId: "main" }),
    ]);
    managers = [a.manager, b.manager];

    expect(a.manager).not.toBeNull();
    expect(b.manager).not.toBeNull();
    // Same instance returned to both concurrent callers...
    expect(a.manager).toBe(b.manager);
    // ...and the expensive build ran exactly once.
    expect(providerBuilds).toBe(1);
  });
});
