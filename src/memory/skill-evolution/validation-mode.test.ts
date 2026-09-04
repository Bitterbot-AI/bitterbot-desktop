import { describe, expect, it } from "vitest";
import {
  countCapabilityTasks,
  resolveEffectiveValidationMode,
  TASKS_MODE_MIN_CAPABILITY_TASKS,
} from "./validation-mode.js";

describe("effective validation mode (PLAN-44 D-2)", () => {
  it("explicit config always wins", () => {
    expect(resolveEffectiveValidationMode("records", 99)).toEqual({
      mode: "records",
      source: "config",
    });
    expect(resolveEffectiveValidationMode("tasks", 0)).toEqual({ mode: "tasks", source: "config" });
  });

  it("auto-flips to tasks once the corpus carries enough reviewed capability tasks", () => {
    expect(resolveEffectiveValidationMode(undefined, TASKS_MODE_MIN_CAPABILITY_TASKS - 1)).toEqual({
      mode: "records",
      source: "auto",
    });
    expect(resolveEffectiveValidationMode(undefined, TASKS_MODE_MIN_CAPABILITY_TASKS)).toEqual({
      mode: "tasks",
      source: "auto",
    });
  });

  it("counts only non-regression tasks", () => {
    expect(countCapabilityTasks(null)).toBe(0);
    expect(
      countCapabilityTasks({
        version: "v",
        tasks: [
          { id: "a", prompt: "p", checker: { kind: "exact", value: "1" }, suite: "regression" },
          { id: "b", prompt: "p", checker: { kind: "exact", value: "1" }, suite: "capability" },
          { id: "c", prompt: "p", checker: { kind: "exact", value: "1" } },
        ],
      }),
    ).toBe(2);
  });
});
