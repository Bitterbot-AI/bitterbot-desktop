import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  peekSessionStore,
  type SessionEntry,
  saveSessionStore,
} from "./sessions.js";

describe("Session Store Cache", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let testDir: string;
  let storePath: string;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-cache-test-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    testDir = path.join(fixtureRoot, `case-${caseId++}`);
    fs.mkdirSync(testDir, { recursive: true });
    storePath = path.join(testDir, "sessions.json");

    // Clear cache before each test
    clearSessionStoreCacheForTest();

    // Reset environment variable
    delete process.env.BITTERBOT_SESSION_CACHE_TTL_MS;
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    delete process.env.BITTERBOT_SESSION_CACHE_TTL_MS;
  });

  it("should load session store from disk on first call", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    // Write test data
    await saveSessionStore(storePath, testStore);

    // Load it
    const loaded = loadSessionStore(storePath);
    expect(loaded).toEqual(testStore);
  });

  it("should cache session store on first load when file is unchanged", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    await saveSessionStore(storePath, testStore);

    const readSpy = vi.spyOn(fs, "readFileSync");

    // First load - from disk
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Second load - should return cached data (no extra disk read)
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2).toEqual(testStore);
    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it("should not allow cached session mutations to leak across loads", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        cliSessionIds: { openai: "sess-1" },
        skillsSnapshot: {
          prompt: "skills",
          skills: [{ name: "alpha" }],
        },
      },
    };

    await saveSessionStore(storePath, testStore);

    const loaded1 = loadSessionStore(storePath);
    loaded1["session:1"].cliSessionIds = { openai: "mutated" };
    if (loaded1["session:1"].skillsSnapshot?.skills?.length) {
      loaded1["session:1"].skillsSnapshot.skills[0].name = "mutated";
    }

    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:1"].cliSessionIds?.openai).toBe("sess-1");
    expect(loaded2["session:1"].skillsSnapshot?.skills?.[0]?.name).toBe("alpha");
  });

  it("should refresh cache when store file changes on disk", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    await saveSessionStore(storePath, testStore);

    // First load - from disk
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Modify file on disk while cache is valid
    const modifiedStore: Record<string, SessionEntry> = {
      "session:99": { sessionId: "id-99", updatedAt: Date.now() },
    };
    fs.writeFileSync(storePath, JSON.stringify(modifiedStore, null, 2));
    const bump = new Date(Date.now() + 2000);
    fs.utimesSync(storePath, bump, bump);

    // Second load - should return the updated store
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2).toEqual(modifiedStore);
  });

  it("should invalidate cache on write", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    await saveSessionStore(storePath, testStore);

    // Load - should cache
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Update store
    const updatedStore: Record<string, SessionEntry> = {
      "session:1": {
        ...testStore["session:1"],
        displayName: "Updated Session 1",
      },
    };

    // Save - should invalidate cache
    await saveSessionStore(storePath, updatedStore);

    // Load again - should get new data from disk
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:1"].displayName).toBe("Updated Session 1");
  });

  it("should respect BITTERBOT_SESSION_CACHE_TTL_MS=0 to disable cache", async () => {
    process.env.BITTERBOT_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();

    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    await saveSessionStore(storePath, testStore);

    // First load
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Modify file on disk
    const modifiedStore: Record<string, SessionEntry> = {
      "session:2": {
        sessionId: "id-2",
        updatedAt: Date.now(),
        displayName: "Test Session 2",
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(modifiedStore, null, 2));

    // Second load - should read from disk (cache disabled)
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2).toEqual(modifiedStore); // Should be modified, not cached
  });

  it("should handle non-existent store gracefully", () => {
    const nonExistentPath = path.join(testDir, "non-existent.json");

    // Should return empty store
    const loaded = loadSessionStore(nonExistentPath);
    expect(loaded).toEqual({});
  });

  it("should handle invalid JSON gracefully", async () => {
    // Write invalid JSON
    fs.writeFileSync(storePath, "not valid json {");

    // Should return empty store
    const loaded = loadSessionStore(storePath);
    expect(loaded).toEqual({});
  });

  describe("peekSessionStore (read-only, no copy)", () => {
    it("returns the cached object itself on a hit and a fresh copy from loadSessionStore", async () => {
      await saveSessionStore(storePath, {
        "agent:a:one": { sessionId: "id-1", updatedAt: 1 },
        "agent:a:two": { sessionId: "id-2", updatedAt: 2 },
      });
      const first = peekSessionStore(storePath);
      const second = peekSessionStore(storePath);
      // Same object: the hot read path does not pay for a deep copy.
      expect(second).toBe(first);
      expect(Object.keys(first)).toEqual(["agent:a:one", "agent:a:two"]);
      // loadSessionStore still hands out a copy that is safe to mutate.
      const copy = loadSessionStore(storePath);
      expect(copy).not.toBe(first);
      expect(copy).toEqual(first);
      copy["agent:a:one"]!.updatedAt = 999;
      expect(peekSessionStore(storePath)["agent:a:one"]!.updatedAt).toBe(1);
    });

    it("sees a store rewritten on disk (mtime change) without a stale hit", async () => {
      await saveSessionStore(storePath, { "agent:a:one": { sessionId: "id-1", updatedAt: 1 } });
      expect(Object.keys(peekSessionStore(storePath))).toEqual(["agent:a:one"]);
      // Rewrite with a different mtime.
      await new Promise((r) => setTimeout(r, 20));
      await saveSessionStore(storePath, {
        "agent:a:one": { sessionId: "id-1", updatedAt: 1 },
        "agent:a:three": { sessionId: "id-3", updatedAt: 3 },
      });
      fs.utimesSync(storePath, new Date(), new Date(Date.now() + 5_000));
      expect(Object.keys(peekSessionStore(storePath))).toContain("agent:a:three");
    });

    it("falls back to a disk load when the cache is disabled", async () => {
      process.env.BITTERBOT_SESSION_CACHE_TTL_MS = "0";
      await saveSessionStore(storePath, { "agent:a:one": { sessionId: "id-1", updatedAt: 1 } });
      const a = peekSessionStore(storePath);
      const b = peekSessionStore(storePath);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });
});
