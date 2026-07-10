import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskPlan } from "./types.js";
import { TaskStore, getActiveTaskStore, startTaskStore, stopTaskStore } from "./store.js";

const samplePlan: TaskPlan = {
  steps: [
    { id: "step-1", title: "Draft outline", status: "pending" },
    { id: "step-2", title: "Write body", status: "pending" },
    { id: "step-3", title: "Polish + cite", status: "pending" },
  ],
};

describe("TaskStore", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tasks-"));
    dbPath = path.join(dir, "tasks.sqlite");
  });

  afterEach(() => {
    stopTaskStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates and retrieves a task", () => {
    const store = TaskStore.open(dbPath);
    try {
      const created = store.create({
        goal: "Refactor cron docs",
        doneCriteria: "docs/automation/cron.md updated, lint clean",
        plan: samplePlan,
        source: "user",
      });
      expect(created.id).toMatch(/^task-/);
      expect(created.status).toBe("pending");
      expect(created.wakeupCount).toBe(0);
      expect(created.plan?.steps).toHaveLength(3);

      const fetched = store.get(created.id);
      expect(fetched?.goal).toBe("Refactor cron docs");
      expect(fetched?.plan?.steps[0].title).toBe("Draft outline");
    } finally {
      store.close();
    }
  });

  it("rejects a parentTaskId that doesn't exist", () => {
    const store = TaskStore.open(dbPath);
    try {
      expect(() =>
        store.create({
          goal: "child",
          doneCriteria: "x",
          parentTaskId: "task-missing",
        }),
      ).toThrow(/parent task .* not found/);
    } finally {
      store.close();
    }
  });

  it("supports parent/child relationships and lookup", () => {
    const store = TaskStore.open(dbPath);
    try {
      const parent = store.create({ goal: "parent goal", doneCriteria: "p" });
      const child = store.create({
        goal: "child goal",
        doneCriteria: "c",
        parentTaskId: parent.id,
      });
      expect(child.parentTaskId).toBe(parent.id);

      const children = store.list({ parentTaskId: parent.id });
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(child.id);
    } finally {
      store.close();
    }
  });

  it("updates fields and bumps lastSeen + updatedAt", async () => {
    const store = TaskStore.open(dbPath);
    try {
      const created = store.create({ goal: "g", doneCriteria: "d" });
      await new Promise((r) => setTimeout(r, 5));
      const updated = store.update(created.id, {
        status: "running",
        currentRunId: "run-xyz",
      });
      expect(updated.status).toBe("running");
      expect(updated.currentRunId).toBe("run-xyz");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      expect(updated.lastSeenAt).toBeGreaterThanOrEqual(created.lastSeenAt);
    } finally {
      store.close();
    }
  });

  it("blocks transitions out of terminal status", () => {
    const store = TaskStore.open(dbPath);
    try {
      const t = store.create({ goal: "g", doneCriteria: "d" });
      store.update(t.id, { status: "completed", output: "crystal-abc" });
      expect(() => store.update(t.id, { status: "running" })).toThrow(/terminal/);
      // Setting the same terminal status again is a no-op (allowed).
      const reaffirmed = store.update(t.id, { status: "completed" });
      expect(reaffirmed.status).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("setStepStatus mutates plan + advances cursor", () => {
    const store = TaskStore.open(dbPath);
    try {
      const t = store.create({ goal: "g", doneCriteria: "d", plan: samplePlan });
      const afterStep1 = store.setStepStatus(t.id, "step-1", "completed", "outline-crystal-1");
      expect(afterStep1.plan?.steps[0].status).toBe("completed");
      expect(afterStep1.plan?.steps[0].output).toBe("outline-crystal-1");
      // Cursor should now point at the first non-completed step (step-2).
      expect(afterStep1.plan?.cursor).toBe(1);

      const afterStep2 = store.setStepStatus(t.id, "step-2", "in_progress");
      expect(afterStep2.plan?.cursor).toBe(1); // step-2 is in_progress, cursor stays
    } finally {
      store.close();
    }
  });

  it("setStepStatus errors on missing step", () => {
    const store = TaskStore.open(dbPath);
    try {
      const t = store.create({ goal: "g", doneCriteria: "d", plan: samplePlan });
      expect(() => store.setStepStatus(t.id, "step-missing", "completed")).toThrow(
        /step .* not found/,
      );
    } finally {
      store.close();
    }
  });

  it("incrementWakeup bumps wakeupCount atomically", () => {
    const store = TaskStore.open(dbPath);
    try {
      const t = store.create({ goal: "g", doneCriteria: "d" });
      const a = store.update(t.id, { incrementWakeup: true });
      const b = store.update(a.id, { incrementWakeup: true });
      const c = store.update(b.id, { incrementWakeup: true });
      expect(a.wakeupCount).toBe(1);
      expect(b.wakeupCount).toBe(2);
      expect(c.wakeupCount).toBe(3);
    } finally {
      store.close();
    }
  });

  it("list filters by status, source, and parent", () => {
    const store = TaskStore.open(dbPath);
    try {
      const a = store.create({ goal: "a", doneCriteria: "x", source: "user" });
      const b = store.create({ goal: "b", doneCriteria: "x", source: "curiosity" });
      const c = store.create({
        goal: "c",
        doneCriteria: "x",
        source: "user",
        parentTaskId: a.id,
      });
      store.update(b.id, { status: "running" });

      expect(
        store
          .list({ status: "pending" })
          .map((t) => t.id)
          .toSorted(),
      ).toEqual([a.id, c.id].toSorted());
      expect(store.list({ status: ["running", "completed"] }).map((t) => t.id)).toEqual([b.id]);
      expect(store.list({ source: "curiosity" }).map((t) => t.id)).toEqual([b.id]);
      expect(
        store
          .list({ parentTaskId: null })
          .map((t) => t.id)
          .toSorted(),
      ).toEqual([a.id, b.id].toSorted());
    } finally {
      store.close();
    }
  });

  it("persists rows across reopens", () => {
    const s1 = TaskStore.open(dbPath);
    const created = s1.create({ goal: "persisted", doneCriteria: "x", plan: samplePlan });
    s1.update(created.id, { status: "running", currentRunId: "run-1" });
    s1.close();

    const s2 = TaskStore.open(dbPath);
    try {
      const fetched = s2.get(created.id);
      expect(fetched?.status).toBe("running");
      expect(fetched?.currentRunId).toBe("run-1");
      expect(fetched?.plan?.steps).toHaveLength(3);
    } finally {
      s2.close();
    }
  });

  it("singleton start/stop is idempotent", () => {
    const a = startTaskStore({ dbPath });
    const b = startTaskStore({ dbPath });
    expect(a).toBe(b);
    expect(getActiveTaskStore()).toBe(a);
    stopTaskStore();
    expect(getActiveTaskStore()).toBeNull();
  });

  it("emits change events on create/update/delete", () => {
    const store = TaskStore.open(dbPath);
    const events: string[] = [];
    const unsub = store.onChange((e) => events.push(`${e.type}:${e.task.status}`));
    try {
      const t = store.create({ goal: "g", doneCriteria: "d" });
      store.update(t.id, { status: "running" });
      store.delete(t.id);
      expect(events).toEqual(["created:pending", "updated:running", "deleted:running"]);
    } finally {
      unsub();
      store.close();
    }
  });

  it("count totals match status filters", () => {
    const store = TaskStore.open(dbPath);
    try {
      const a = store.create({ goal: "a", doneCriteria: "x" });
      const b = store.create({ goal: "b", doneCriteria: "x" });
      const c = store.create({ goal: "c", doneCriteria: "x" });
      store.update(b.id, { status: "running" });
      store.update(c.id, { status: "completed" });
      expect(store.count()).toBe(3);
      expect(store.count({ status: "pending" })).toBe(1);
      expect(store.count({ status: ["running", "completed"] })).toBe(2);
      // Suppress unused-var warning on `a`.
      expect(a.status).toBe("pending");
    } finally {
      store.close();
    }
  });

  describe("legacy curiosity sweep (PLAN-34 Phase 0)", () => {
    const WEEK_MS = 168 * 3_600_000;

    it("stops pending curiosity tasks older than 168h; leaves everything else alone", () => {
      const store = TaskStore.open(dbPath);
      try {
        const stale = store.create({
          goal: "[curiosity] stale",
          doneCriteria: "x",
          source: "curiosity",
        });
        const fresh = store.create({
          goal: "[curiosity] fresh",
          doneCriteria: "x",
          source: "curiosity",
        });
        const running = store.create({
          goal: "[curiosity] running",
          doneCriteria: "x",
          source: "curiosity",
        });
        store.update(running.id, { status: "running" });
        const user = store.create({ goal: "user task", doneCriteria: "x" });

        // Sweep "in the future": stale/fresh/running/user were all created
        // now, so a sweep at now + 8 days sees them past the 168h horizon —
        // except we re-create `fresh` semantics by sweeping at now + 1h for
        // the negative case first.
        expect(store.sweepLegacyCuriosityTasks(Date.now() + 3_600_000)).toBe(0);
        expect(store.get(fresh.id)?.status).toBe("pending");

        const stopped = store.sweepLegacyCuriosityTasks(Date.now() + WEEK_MS + 3_600_000);
        expect(stopped).toBe(2); // stale + fresh (both pending curiosity)
        expect(store.get(stale.id)?.status).toBe("stopped");
        expect(store.get(fresh.id)?.status).toBe("stopped");
        expect(store.get(running.id)?.status).toBe("running");
        expect(store.get(user.id)?.status).toBe("pending");
      } finally {
        store.close();
      }
    });

    it("is idempotent — a second sweep matches nothing", () => {
      const store = TaskStore.open(dbPath);
      try {
        store.create({ goal: "[curiosity] old", doneCriteria: "x", source: "curiosity" });
        const later = Date.now() + WEEK_MS + 3_600_000;
        expect(store.sweepLegacyCuriosityTasks(later)).toBe(1);
        expect(store.sweepLegacyCuriosityTasks(later)).toBe(0);
      } finally {
        store.close();
      }
    });

    it("runs automatically at store open", () => {
      const first = TaskStore.open(dbPath);
      const t = first.create({
        goal: "[curiosity] abandoned",
        doneCriteria: "x",
        source: "curiosity",
      });
      first.close();

      // Backdate past the 168h horizon, then reopen: the constructor sweep
      // must stop it without any explicit call.
      const raw = new DatabaseSync(dbPath);
      raw
        .prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`)
        .run(Date.now() - WEEK_MS - 3_600_000, t.id);
      raw.close();

      const reopened = TaskStore.open(dbPath);
      try {
        expect(reopened.get(t.id)?.status).toBe("stopped");
      } finally {
        reopened.close();
      }
    });
  });
});
