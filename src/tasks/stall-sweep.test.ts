import { describe, expect, it } from "vitest";
import { findStrandedTasks, TASK_STALE_MS } from "./stall-sweep.js";
import type { Task } from "./types.js";

const now = 10 * TASK_STALE_MS;
const task = (id: string, overrides: Partial<Task> = {}): Task =>
  ({
    id,
    goal: `goal ${id}`,
    status: "waiting_external",
    lastSeenAt: now - 2 * TASK_STALE_MS,
    ...overrides,
  }) as Task;

describe("findStrandedTasks", () => {
  it("finds unfinished tasks untouched for a day with nothing set to resume them", () => {
    const stranded = findStrandedTasks(
      [
        task("old-no-wakeup"),
        task("old-with-wakeup"),
        task("fresh", { lastSeenAt: now - 1000 }),
        task("done", { status: "completed" }),
        task("stopped", { status: "stopped" }),
        task("running-but-silent", { status: "running" }),
      ],
      new Set(["old-with-wakeup"]),
      now,
    );

    expect(stranded.map((t) => t.id)).toEqual(["old-no-wakeup", "running-but-silent"]);
  });

  it("treats exactly a day as not yet stranded", () => {
    expect(
      findStrandedTasks([task("edge", { lastSeenAt: now - TASK_STALE_MS })], new Set(), now),
    ).toEqual([]);
  });
});
