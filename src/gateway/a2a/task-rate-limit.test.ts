import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TASKS_PER_MINUTE,
  isTaskCreationRateLimited,
  resetTaskRateLimit,
} from "./task-rate-limit.js";

const T0 = 1_800_000_000_000;

describe("A2A task-creation rate limit", () => {
  beforeEach(() => resetTaskRateLimit());

  it("allows up to the limit, then blocks within the window", () => {
    for (let i = 0; i < DEFAULT_MAX_TASKS_PER_MINUTE; i++) {
      expect(isTaskCreationRateLimited("1.2.3.4", DEFAULT_MAX_TASKS_PER_MINUTE, T0 + i)).toBe(
        false,
      );
    }
    // The (limit + 1)-th within the window is blocked.
    expect(isTaskCreationRateLimited("1.2.3.4", DEFAULT_MAX_TASKS_PER_MINUTE, T0 + 100)).toBe(true);
  });

  it("keys per client — one flooder does not throttle another", () => {
    for (let i = 0; i < DEFAULT_MAX_TASKS_PER_MINUTE + 3; i++) {
      isTaskCreationRateLimited("flooder", DEFAULT_MAX_TASKS_PER_MINUTE, T0 + i);
    }
    // A different client starts fresh.
    expect(isTaskCreationRateLimited("innocent", DEFAULT_MAX_TASKS_PER_MINUTE, T0 + 50)).toBe(
      false,
    );
  });

  it("resets after the window rolls over", () => {
    for (let i = 0; i < DEFAULT_MAX_TASKS_PER_MINUTE + 1; i++) {
      isTaskCreationRateLimited("peer", DEFAULT_MAX_TASKS_PER_MINUTE, T0 + i);
    }
    expect(isTaskCreationRateLimited("peer", DEFAULT_MAX_TASKS_PER_MINUTE, T0 + 100)).toBe(true);
    // > 60s later: a new window.
    expect(isTaskCreationRateLimited("peer", DEFAULT_MAX_TASKS_PER_MINUTE, T0 + 61_000)).toBe(
      false,
    );
  });

  it("honors a custom limit and disables on a non-positive limit", () => {
    expect(isTaskCreationRateLimited("p", 2, T0)).toBe(false);
    expect(isTaskCreationRateLimited("p", 2, T0 + 1)).toBe(false);
    expect(isTaskCreationRateLimited("p", 2, T0 + 2)).toBe(true);
    // Disabled: never limits, no matter how many.
    for (let i = 0; i < 100; i++) {
      expect(isTaskCreationRateLimited("q", 0, T0 + i)).toBe(false);
    }
  });
});
