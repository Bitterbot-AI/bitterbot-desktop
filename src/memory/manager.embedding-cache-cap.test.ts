import { describe, expect, it } from "vitest";
import { installEmbeddingManagerFixture } from "./embedding-manager.test-harness.js";

const fx = installEmbeddingManagerFixture({
  fixturePrefix: "bitterbot-mem-cache-",
  largeTokens: 1250,
  smallTokens: 200,
  createCfg: ({ workspaceDir, indexPath, tokens }) => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: false } },
          chunking: { tokens, overlap: 0 },
          cache: { enabled: true, maxEntries: 2 },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  }),
});

describe("memory embedding cache cap", () => {
  it("keeps the cap on every cache write, not only at the end of a full sync", () => {
    const manager = fx.getManagerSmall();
    const write = (
      manager as unknown as {
        upsertEmbeddingCache: (entries: Array<{ hash: string; embedding: number[] }>) => void;
      }
    ).upsertEmbeddingCache.bind(manager);
    write(Array.from({ length: 5 }, (_, i) => ({ hash: `h${i}`, embedding: [i, 1] })));
    const cache = manager.status().cache as { entries?: number; maxEntries?: number };
    expect(cache.maxEntries).toBe(2);
    expect(cache.entries).toBe(2);
  });
});
