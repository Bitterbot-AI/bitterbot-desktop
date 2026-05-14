/**
 * Test the dream-mode bias logic extracted from
 * `DreamEngine.selectModes` for PLAN-17 Phase 2 E.2.
 *
 * The math lives in `src/tasks/biology.ts`'s
 * `computeDreamTaskAdjustments` so the dream engine itself stays one
 * import away — no need to spin up the full DreamEngine to verify the
 * bias policy.
 *
 * Plus one integration assertion via the in-process bus: when the task
 * store has a pending task and `scanPendingTasksForDream` is invoked,
 * the helper produces the expected adjustments.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDreamTaskAdjustments,
  scanPendingTasksForDream,
  type PendingTaskSummary,
} from "../tasks/biology.js";
import { getActiveTaskStore, startTaskStore, stopTaskStore } from "../tasks/store.js";

function pending(overrides: Partial<PendingTaskSummary> = {}): PendingTaskSummary {
  return {
    taskId: overrides.taskId ?? "task-x",
    goal: overrides.goal ?? "do the thing",
    status: overrides.status ?? "waiting_external",
    wakeupCount: overrides.wakeupCount ?? 0,
    ageHours: overrides.ageHours ?? 1.2,
    pendingHints: overrides.pendingHints ?? [],
    latestIntent: overrides.latestIntent ?? null,
  };
}

describe("computeDreamTaskAdjustments (PLAN-17 Phase 2 E.2 math)", () => {
  it("returns empty adjustments when nothing is pending", () => {
    const r = computeDreamTaskAdjustments([]);
    expect(r.adjustments).toEqual({});
    expect(r.pendingCount).toBe(0);
    expect(r.stalledCount).toBe(0);
  });

  it("bumps simulation by +0.2 when at least one task is pending", () => {
    const r = computeDreamTaskAdjustments([pending({ status: "planning" })]);
    expect(r.adjustments.simulation).toBe(0.2);
    expect(r.pendingCount).toBe(1);
  });

  it("bumps replay by +0.1 when any task is waiting_external", () => {
    const r = computeDreamTaskAdjustments([
      pending({ status: "planning" }),
      pending({ status: "waiting_external", taskId: "task-y" }),
    ]);
    expect(r.adjustments.simulation).toBe(0.2);
    expect(r.adjustments.replay).toBe(0.1);
  });

  it("does not bump replay when all pending tasks are in planning", () => {
    const r = computeDreamTaskAdjustments([
      pending({ status: "planning", taskId: "a" }),
      pending({ status: "planning", taskId: "b" }),
    ]);
    expect(r.adjustments.simulation).toBe(0.2);
    expect(r.adjustments.replay).toBeUndefined();
  });

  it("counts stalled tasks (wakeupCount > 0)", () => {
    const r = computeDreamTaskAdjustments([
      pending({ taskId: "fresh", wakeupCount: 0 }),
      pending({ taskId: "stalled-1", wakeupCount: 1 }),
      pending({ taskId: "stalled-2", wakeupCount: 5 }),
    ]);
    expect(r.stalledCount).toBe(2);
    expect(r.pendingCount).toBe(3);
  });

  it("does not bump weights above the configured maximums (single-call shape)", () => {
    // The helper is a pure additive: it returns deltas, never absolute weights.
    // Verify the deltas are bounded to the documented constants.
    const r = computeDreamTaskAdjustments([
      pending({ status: "waiting_external", taskId: "a" }),
      pending({ status: "waiting_external", taskId: "b" }),
      pending({ status: "waiting_external", taskId: "c" }),
    ]);
    expect(r.adjustments.simulation).toBe(0.2);
    expect(r.adjustments.replay).toBe(0.1);
    // No other modes should receive a bump from this helper.
    expect(Object.keys(r.adjustments).toSorted()).toEqual(["replay", "simulation"]);
  });
});

describe("scanPendingTasksForDream → computeDreamTaskAdjustments end-to-end", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-dream-bias-"));
    startTaskStore({ dbPath: path.join(dir, "tasks.sqlite") });
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("scan + adjust returns simulation+0.2 / replay+0.1 when a waiting_external task exists", () => {
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "research X", doneCriteria: "Y" });
    store.update(t.id, { status: "waiting_external" });

    const scanned = scanPendingTasksForDream();
    expect(scanned).toHaveLength(1);

    const adj = computeDreamTaskAdjustments(scanned);
    expect(adj.adjustments.simulation).toBe(0.2);
    expect(adj.adjustments.replay).toBe(0.1);
    expect(adj.pendingCount).toBe(1);
    expect(adj.stalledCount).toBe(0);
  });

  it("returns zero bias when no tasks are pending (running/completed tasks excluded)", () => {
    const store = getActiveTaskStore()!;
    const a = store.create({ goal: "g", doneCriteria: "d" });
    const b = store.create({ goal: "g", doneCriteria: "d" });
    store.update(a.id, { status: "running" });
    store.update(b.id, { status: "completed", output: "out" });

    const scanned = scanPendingTasksForDream();
    expect(scanned).toHaveLength(0);

    const adj = computeDreamTaskAdjustments(scanned);
    expect(adj.adjustments).toEqual({});
    expect(adj.pendingCount).toBe(0);
  });

  it("counts stalled correctly after wakeup increments", () => {
    const store = getActiveTaskStore()!;
    const t = store.create({ goal: "g", doneCriteria: "d" });
    store.update(t.id, { status: "waiting_external" });
    store.update(t.id, { incrementWakeup: true });
    store.update(t.id, { incrementWakeup: true });

    const scanned = scanPendingTasksForDream();
    const adj = computeDreamTaskAdjustments(scanned);
    expect(adj.pendingCount).toBe(1);
    expect(adj.stalledCount).toBe(1); // wakeupCount === 2, > 0
  });
});
