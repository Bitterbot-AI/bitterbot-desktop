import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import { openSkillLifecycleStore, withSkillLifecycleStore } from "./skill-lifecycle-from-config.js";

function configFor(dbPath: string): BitterbotConfig {
  return {
    agents: {
      defaults: {
        memorySearch: {
          store: { path: dbPath },
        },
      },
    },
  } as unknown as BitterbotConfig;
}

describe("openSkillLifecycleStore", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-lifecycle-from-config-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("opens the DB at the configured path and returns a usable store", () => {
    const dbPath = path.join(tmp, "memory.sqlite");
    const handle = openSkillLifecycleStore({ config: configFor(dbPath), agentId: "test-agent" });
    expect(handle).not.toBeNull();
    if (!handle) return;
    handle.store.recordUsage({
      skillName: "first-skill",
      success: true,
      origin: "agent_authored",
      timestamp: 1000,
    });
    const row = handle.store.get("first-skill");
    expect(row?.usageCount).toBe(1);
    expect(row?.origin).toBe("agent_authored");
    handle.close();
  });

  it("creates the parent directory if missing", async () => {
    const dbPath = path.join(tmp, "nested", "deeper", "memory.sqlite");
    const handle = openSkillLifecycleStore({ config: configFor(dbPath), agentId: "x" });
    expect(handle).not.toBeNull();
    handle?.close();
    const stat = await fs.stat(path.dirname(dbPath));
    expect(stat.isDirectory()).toBe(true);
  });

  it("substitutes {agentId} in the configured path", () => {
    const dbPath = path.join(tmp, "memory-{agentId}.sqlite");
    const handle = openSkillLifecycleStore({
      config: configFor(dbPath),
      agentId: "victor",
    });
    expect(handle).not.toBeNull();
    handle?.close();
  });

  it("opens cleanly when the same DB is reopened (idempotent migrations)", () => {
    const dbPath = path.join(tmp, "memory.sqlite");
    const first = openSkillLifecycleStore({ config: configFor(dbPath), agentId: "x" });
    first?.store.recordUsage({ skillName: "persist", success: true, timestamp: 1 });
    first?.close();

    const second = openSkillLifecycleStore({ config: configFor(dbPath), agentId: "x" });
    expect(second).not.toBeNull();
    // Migrations are idempotent; reopened DB should retain prior writes.
    expect(second?.store.get("persist")?.usageCount).toBe(1);
    second?.close();
  });

  it("close() releases the handle without throwing", () => {
    const dbPath = path.join(tmp, "memory.sqlite");
    const handle = openSkillLifecycleStore({ config: configFor(dbPath), agentId: "x" });
    expect(() => handle?.close()).not.toThrow();
    // Calling close twice should be a no-op (logs internally; no exception bubbled).
    expect(() => handle?.close()).not.toThrow();
  });

  it("returns null when the agentId is explicitly empty", () => {
    const dbPath = path.join(tmp, "memory.sqlite");
    const handle = openSkillLifecycleStore({ config: configFor(dbPath), agentId: "" });
    expect(handle).toBeNull();
  });

  it("returns null when the path is unwritable", () => {
    // /dev/null is a character device, not a directory — opening a sqlite
    // file under it is guaranteed to fail across platforms that support
    // the device. On Windows the equivalent failure mode is exercised by
    // an invalid drive prefix; we test the Unix branch and skip on win32.
    if (process.platform === "win32") {
      return;
    }
    const handle = openSkillLifecycleStore({
      config: configFor("/dev/null/cannot-open.sqlite"),
      agentId: "x",
    });
    expect(handle).toBeNull();
  });
});

describe("withSkillLifecycleStore", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-lifecycle-from-config-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("invokes the callback with a real store and closes after", async () => {
    const dbPath = path.join(tmp, "memory.sqlite");
    let seenName: string | undefined;
    await withSkillLifecycleStore({ config: configFor(dbPath), agentId: "x" }, async (store) => {
      expect(store).not.toBeNull();
      store?.recordUsage({ skillName: "alpha", success: true });
      seenName = store?.get("alpha")?.skillName;
    });
    expect(seenName).toBe("alpha");
  });

  it("invokes the callback with null when the open fails", async () => {
    if (process.platform === "win32") {
      return;
    }
    let received: unknown = "untouched";
    await withSkillLifecycleStore(
      { config: configFor("/dev/null/no-open.sqlite"), agentId: "x" },
      async (store) => {
        received = store;
      },
    );
    expect(received).toBeNull();
  });

  it("forwards the callback's return value", async () => {
    const dbPath = path.join(tmp, "memory.sqlite");
    const out = await withSkillLifecycleStore(
      { config: configFor(dbPath), agentId: "x" },
      async (store) => {
        store?.recordUsage({ skillName: "ret", success: true });
        return store?.get("ret")?.usageCount ?? 0;
      },
    );
    expect(out).toBe(1);
  });

  it("closes the store even when the callback throws", async () => {
    const dbPath = path.join(tmp, "memory.sqlite");
    await expect(
      withSkillLifecycleStore({ config: configFor(dbPath), agentId: "x" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent open should succeed — the prior handle was released.
    const handle = openSkillLifecycleStore({ config: configFor(dbPath), agentId: "x" });
    expect(handle).not.toBeNull();
    handle?.close();
  });
});
