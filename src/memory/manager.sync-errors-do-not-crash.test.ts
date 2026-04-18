import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    })),
  },
}));

vi.mock("./embeddings.js", () => {
  return {
    createEmbeddingProvider: async () => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: "mock-embed",
        embedQuery: async () => [0, 0, 0],
        embedBatch: async () => {
          throw new Error("openai embeddings failed: 400 bad request");
        },
      },
    }),
  };
});

describe("memory manager sync failures", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does not raise unhandledRejection when watch-triggered sync fails", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath },
            sync: { watch: true, watchDebounceMs: 0, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager;
    // The behavior under test is just the fire-and-forget `.catch` wiring in
    // scheduleWatchSync — we don't need to run a real reindex to verify it.
    // Stubbing sync() keeps the test fast and independent of embedding providers.
    const syncSpy = vi.spyOn(manager, "sync").mockRejectedValue(new Error("mock sync failure"));

    // Call the internal scheduler directly; it uses fire-and-forget sync.
    (manager as unknown as { scheduleWatchSync: () => void }).scheduleWatchSync();

    // Wait for the debounce setTimeout(0) to fire and the spy to capture the sync promise.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(syncSpy).toHaveBeenCalled();
    const syncPromise = syncSpy.mock.results[0]?.value as Promise<void> | undefined;
    expect(syncPromise).toBeDefined();
    await syncPromise?.catch(() => undefined);
    // Flush microtasks so any unhandledRejection has a chance to surface.
    await new Promise((resolve) => setImmediate(resolve));

    process.off("unhandledRejection", handler);
    expect(unhandled).toHaveLength(0);
  });
});
