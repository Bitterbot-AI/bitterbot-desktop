import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HormonalState } from "../memory/hormonal.js";
import {
  buildDreamPlanningSnapshot,
  computeTaskConcurrency,
  maybeSpawnTaskFromCuriosity,
  scanPendingTasksForDream,
} from "./biology.js";
import { startTaskStore, stopTaskStore } from "./store.js";

function hormonalState(p: Partial<HormonalState> = {}): HormonalState {
  return { dopamine: 0.15, cortisol: 0.02, oxytocin: 0.2, lastDecay: 0, ...p };
}

describe("computeTaskConcurrency", () => {
  it("high cortisol → focused single-task mode", () => {
    const policy = computeTaskConcurrency(hormonalState({ cortisol: 0.8 }));
    expect(policy.maxConcurrent).toBe(1);
    expect(policy.rationale).toMatch(/focused/);
    expect(policy.priorityMultiplier).toBeGreaterThan(1);
  });

  it("moderate cortisol → conservative concurrency", () => {
    const policy = computeTaskConcurrency(hormonalState({ cortisol: 0.4 }));
    expect(policy.maxConcurrent).toBe(2);
  });

  it("high dopamine + low cortisol → exploratory breadth", () => {
    const policy = computeTaskConcurrency(hormonalState({ dopamine: 0.75, cortisol: 0.05 }));
    expect(policy.maxConcurrent).toBe(4);
    expect(policy.priorityMultiplier).toBeLessThan(1);
  });

  it("baseline state → baseline concurrency", () => {
    const policy = computeTaskConcurrency(hormonalState());
    expect(policy.maxConcurrent).toBe(3);
    expect(policy.rationale).toBe("baseline");
  });
});

describe("maybeSpawnTaskFromCuriosity", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-biology-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a curiosity-sourced task for a strong gap", () => {
    const task = maybeSpawnTaskFromCuriosity({
      topic: "rust:async-cancellation",
      description: "How does tokio handle cancellation safety across .await points?",
      novelty: 0.8,
      alignment: 0.7,
      effort: 0.3,
    });
    expect(task).not.toBeNull();
    expect(task?.source).toBe("curiosity");
    expect(task?.goal).toMatch(/\[curiosity\]/);
    expect(task?.metadata?.topic).toBe("rust:async-cancellation");
  });

  it("rejects gaps below the novelty threshold", () => {
    const task = maybeSpawnTaskFromCuriosity({
      topic: "noisy:thing",
      description: "yet another",
      novelty: 0.2,
      alignment: 0.9,
      effort: 0.1,
    });
    expect(task).toBeNull();
  });

  it("rejects gaps below the alignment threshold", () => {
    const task = maybeSpawnTaskFromCuriosity({
      topic: "tangent",
      description: "unrelated rabbit hole",
      novelty: 0.9,
      alignment: 0.1,
      effort: 0.5,
    });
    expect(task).toBeNull();
  });

  it("dedupes by topic within the lookback window", () => {
    const a = maybeSpawnTaskFromCuriosity({
      topic: "same:topic",
      description: "first",
      novelty: 0.8,
      alignment: 0.7,
      effort: 0.3,
    });
    const b = maybeSpawnTaskFromCuriosity({
      topic: "same:topic",
      description: "duplicate attempt",
      novelty: 0.85,
      alignment: 0.7,
      effort: 0.3,
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("returns null when the task store isn't started", () => {
    stopTaskStore();
    const task = maybeSpawnTaskFromCuriosity({
      topic: "x",
      description: "y",
      novelty: 0.9,
      alignment: 0.9,
      effort: 0.1,
    });
    expect(task).toBeNull();
  });

  it("respects custom thresholds", () => {
    const task = maybeSpawnTaskFromCuriosity(
      {
        topic: "very-low",
        description: "a",
        novelty: 0.45,
        alignment: 0.45,
        effort: 0.1,
      },
      { noveltyThreshold: 0.4, alignmentThreshold: 0.4 },
    );
    expect(task).not.toBeNull();
  });
});

describe("scanPendingTasksForDream", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-biology-scan-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns only tasks in waiting_external or planning", async () => {
    const a = maybeSpawnTaskFromCuriosity({
      topic: "t1",
      description: "first",
      novelty: 0.8,
      alignment: 0.8,
      effort: 0.1,
    });
    const b = maybeSpawnTaskFromCuriosity({
      topic: "t2",
      description: "second",
      novelty: 0.8,
      alignment: 0.8,
      effort: 0.1,
    });
    expect(a && b).toBeTruthy();
    // Tasks start as 'pending'. We need them transitioned to waiting/planning.
    const { getActiveTaskStore } = await import("./store.js");
    const store = getActiveTaskStore()!;
    store.update(a!.id, { status: "waiting_external" });
    store.update(b!.id, { status: "planning" });

    const pending = scanPendingTasksForDream();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.status).toSorted()).toEqual(["planning", "waiting_external"]);
  });

  it("returns empty when store is not started", () => {
    stopTaskStore();
    expect(scanPendingTasksForDream()).toEqual([]);
  });

  it("includes pendingHints from the latest handoff", async () => {
    const task = maybeSpawnTaskFromCuriosity({
      topic: "with-handoff",
      description: "x",
      novelty: 0.9,
      alignment: 0.9,
      effort: 0.1,
    });
    const { getActiveTaskStore } = await import("./store.js");
    const store = getActiveTaskStore()!;
    store.update(task!.id, { status: "waiting_external" });
    store.writeHandoff({
      taskId: task!.id,
      intent: "blocked on API rate limit",
      pending: ["resume after backoff", "check rate-limit headers"],
    });
    const pending = scanPendingTasksForDream();
    expect(pending[0].pendingHints).toEqual(["resume after backoff", "check rate-limit headers"]);
    expect(pending[0].latestIntent).toBe("blocked on API rate limit");
  });
});

describe("buildDreamPlanningSnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-biology-snapshot-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("combines hormonal policy + pending scan + stall detection", async () => {
    const task = maybeSpawnTaskFromCuriosity({
      topic: "stalled-thing",
      description: "x",
      novelty: 0.9,
      alignment: 0.9,
      effort: 0.5,
    });
    const { getActiveTaskStore } = await import("./store.js");
    const store = getActiveTaskStore()!;
    store.update(task!.id, { status: "waiting_external" });
    // Simulate many wakeups so the snapshot's stalled bucket picks it up.
    for (let i = 0; i < 30; i++) {
      store.update(task!.id, { incrementWakeup: true });
    }
    const snapshot = buildDreamPlanningSnapshot(hormonalState({ cortisol: 0.7 }), {
      wakeupCap: 50,
    });
    expect(snapshot.concurrency.maxConcurrent).toBe(1);
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.stalled).toHaveLength(1);
    expect(snapshot.stalled[0].wakeupCount).toBeGreaterThanOrEqual(25);
  });
});
