import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import { DreamEngine } from "./dream-engine.js";
import { MemoryIndexManager } from "./manager.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock",
      embedQuery: async () => [1],
      embedBatch: async () => [],
    },
  }),
}));

const roots: string[] = [];
const managers: MemoryIndexManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function open(mode?: "off", dreamEnabled = false, agentId = "main") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-learning-default-"));
  roots.push(root);
  const cfg: BitterbotConfig = {
    compute: { enabled: false },
    p2p: { enabled: false },
    agents: {
      defaults: {
        workspace: path.join(root, "workspace"),
        memorySearch: {
          provider: "openai",
          model: "mock",
          store: { path: path.join(root, "index.sqlite"), vector: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      list: [
        { id: "main", default: true, agentDir: path.join(root, "agent") },
        { id: "other", agentDir: path.join(root, "other") },
      ],
    },
    memory: {
      dream: { enabled: dreamEnabled },
      consolidation: { enabled: false },
      emotional: { enabled: false },
      curiosity: { enabled: false },
      ...(mode ? { proceduralLearning: { mode } } : {}),
    },
  };
  await fs.mkdir(path.join(root, "workspace"), { recursive: true });
  const manager = await MemoryIndexManager.get({ cfg, agentId, purpose: "status" });
  if (!manager) throw new Error("manager missing");
  managers.push(manager);
  return { manager, file: path.join(root, "agent", "procedural-learning.sqlite") };
}

it("opens the default store lazily, isolates agents, caches it, and closes it with the manager", async () => {
  const a = await open();
  const b = await open();
  expect(existsSync(a.file)).toBe(false);
  const service = a.manager.proceduralLearning();
  if (!service) throw new Error("default learning service missing");
  expect(existsSync(a.file)).toBe(true);
  expect(service.store.config).toMatchObject({
    mode: "shadow",
    experienceMemory: { enabled: true },
  });
  expect(a.manager.proceduralLearning()).toBe(service);
  service.store.audit("isolation-probe", "a");
  const other = b.manager.proceduralLearning();
  expect(other?.store.db.prepare("SELECT * FROM learning_audit").all()).toEqual([]);
  expect(service.strategies).toBe(service.strategies);
  await a.manager.close();
  expect(a.manager.proceduralLearning()).toBeNull();
  expect(() => service.store.db.prepare("SELECT 1")).toThrow();
});

it("schedules one learning lane when the creative cycle skips and drains it before closing", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lane = vi.spyOn(DreamEngine.prototype, "runLearningLane").mockReturnValue(pending);
  const creative = vi.spyOn(DreamEngine.prototype, "run");
  const { manager } = await open(undefined, true);
  expect(await manager.dream({ scheduled: true })).toBeNull();
  expect(await manager.dream({ scheduled: true })).toBeNull();
  expect(lane).toHaveBeenCalledTimes(1);
  expect(lane).toHaveBeenCalledWith(expect.stringMatching(/^idle-/), true);
  expect(creative).not.toHaveBeenCalled();
  const service = manager.proceduralLearning()!;
  const close = manager.close();
  await Promise.resolve();
  expect(service.store.db.prepare("SELECT 1").get()).toBeDefined();
  release();
  await close;
  expect(() => service.store.db.prepare("SELECT 1")).toThrow();
});

it("does not start learning while the user is active or from a secondary agent", async () => {
  const lane = vi.spyOn(DreamEngine.prototype, "runLearningLane").mockResolvedValue();
  const active = await open(undefined, true);
  active.manager.stimulateFromLiveMessage("A new request");
  expect(await active.manager.dream({ scheduled: true })).toBeNull();
  const secondary = await open(undefined, true, "other");
  expect(await secondary.manager.dream({ scheduled: true })).toBeNull();
  expect(lane).not.toHaveBeenCalled();
});

it("creates no procedural database when explicitly off", async () => {
  const { manager, file } = await open("off");
  expect(manager.proceduralLearning()).toBeNull();
  expect(existsSync(file)).toBe(false);
});
