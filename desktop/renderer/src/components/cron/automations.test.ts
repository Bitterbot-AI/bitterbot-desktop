import { describe, expect, it } from "vitest";
import { describeCondition, monitorHealth, type MonitorRow } from "./MonitorsSection";
import { describeTask, type TaskRow } from "./TasksSection";

const monitor = (overrides: Partial<MonitorRow> = {}): MonitorRow => ({
  id: "mon_1",
  name: "Widget",
  url: "https://shop.test/widget",
  enabled: true,
  intervalMs: 600_000,
  condition: { kind: "changed" },
  health: { consecutiveErrors: 0 },
  ...overrides,
});

describe("monitorHealth", () => {
  it("separates a monitor that cannot be checked from one that failed once", () => {
    expect(
      monitorHealth(
        monitor({ health: { consecutiveErrors: 3, lastError: "the server answered 503" } }),
      ),
    ).toEqual({ tone: "bad", text: "Cannot be checked: the server answered 503" });
    expect(
      monitorHealth(monitor({ health: { consecutiveErrors: 1, lastError: "timed out" } })).tone,
    ).toBe("warn");
  });

  it("covers off, never checked and healthy", () => {
    expect(monitorHealth(monitor({ enabled: false })).text).toBe("Off");
    expect(monitorHealth(monitor()).text).toBe("Not checked yet");
    expect(
      monitorHealth(monitor({ health: { consecutiveErrors: 0, lastCheckAt: Date.now() } })).tone,
    ).toBe("ok");
  });
});

describe("describeCondition", () => {
  it("says each condition in plain words", () => {
    expect(describeCondition({ kind: "changed" })).toBe("when it changes");
    expect(describeCondition({ kind: "contains", text: "In stock" })).toBe(
      'when it contains "In stock"',
    );
    expect(describeCondition({ kind: "below", value: 80 })).toBe("when it goes below 80");
  });
});

const task = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: "task-1",
  goal: "Plan the trip",
  status: "waiting_external",
  lastSeenAt: Date.now(),
  hasWakeup: false,
  stranded: false,
  output: null,
  ...overrides,
});

describe("describeTask", () => {
  it("calls a stuck task stuck, whatever its status says", () => {
    expect(describeTask(task({ stranded: true, status: "running" }))).toMatchObject({
      tone: "bad",
    });
  });

  it("tells a parked task with a wakeup from one waiting on a person", () => {
    expect(describeTask(task({ hasWakeup: true })).text).toContain("a time set to pick it up");
    expect(describeTask(task()).tone).toBe("warn");
  });

  it("covers working, done, failed and stopped", () => {
    expect(describeTask(task({ status: "running" })).text).toBe("Working on it");
    expect(describeTask(task({ status: "completed" })).text).toBe("Done");
    expect(describeTask(task({ status: "failed" })).tone).toBe("bad");
    expect(describeTask(task({ status: "stopped" })).text).toBe("Stopped");
  });
});
