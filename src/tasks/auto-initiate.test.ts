import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "./store.js";
import {
  deriveOracle,
  maybeInitiateGoal,
  summarizeGoal,
  type GoalInitiationDeps,
} from "./auto-initiate.js";

const TRIVIAL = "what time is it?";
const LARGE =
  "Refactor the auth module across all three packages, add tests for each, " +
  "then migrate the session store, and finally open a PR with the changes.";

// Minimal fake store: captures createTask inputs and returns a task with an id.
// (*.test.ts is excluded from the project typecheck, so a partial cast is fine.)
function fakeStore() {
  const created: Array<Record<string, unknown>> = [];
  const store = {
    create: (input: Record<string, unknown>) => {
      const task = { id: `task-${created.length + 1}`, status: "pending", ...input };
      created.push(input);
      return task;
    },
  } as unknown as TaskStore;
  return { store, created };
}

function deps(over: Partial<GoalInitiationDeps> = {}): GoalInitiationDeps {
  return {
    judgeCall: null,
    capacity: () => ({ ok: true }),
    ...over,
  };
}

describe("maybeInitiateGoal - inline path", () => {
  it("returns inline for a trivial prompt without touching the store", async () => {
    const { store, created } = fakeStore();
    const d = await maybeInitiateGoal({ prompt: TRIVIAL }, deps({ store }));
    expect(d.mode).toBe("inline");
    expect(created).toHaveLength(0);
  });
});

describe("maybeInitiateGoal - goal path", () => {
  it("creates a task for a large multi-step prompt and returns ack + first slice", async () => {
    const { store, created } = fakeStore();
    const d = await maybeInitiateGoal(
      { prompt: LARGE, agentSessionKey: "sess-1" },
      deps({ store }),
    );
    expect(d.mode).toBe("task");
    if (d.mode !== "task") return;
    expect(created).toHaveLength(1);
    expect(d.taskId).toBe("task-1");
    expect(d.ack).toContain(d.taskId);
    expect(d.ack.toLowerCase()).toContain("just answer"); // opt-out surfaced
    expect(d.firstSlice).toContain(d.taskId);
    expect(d.firstSlice.toLowerCase()).toContain("done criteria");
  });

  it("pins the complexity verdict, oracle kind, and session key into task metadata", async () => {
    const { store, created } = fakeStore();
    await maybeInitiateGoal({ prompt: LARGE, agentSessionKey: "sess-9" }, deps({ store }));
    const input = created[0];
    expect(input.agentSessionKey).toBe("sess-9");
    expect(input.source).toBe("user");
    const meta = input.metadata as Record<string, unknown>;
    expect(meta.autoInitiated).toBe(true);
    expect(meta.oracleKind).toBeDefined();
    expect((meta.complexity as Record<string, unknown>).tier).toBe("goal");
  });
});

describe("maybeInitiateGoal - gray band", () => {
  // LARGE under high cortisol raises thresholds so 0.567 lands in the gray band.
  const grayDeps = (over: Partial<GoalInitiationDeps>) =>
    deps({ modulators: { cortisol: 1 }, ...over });

  it("escalates when the judge says GOAL", async () => {
    const { store, created } = fakeStore();
    const judge = vi.fn(async () => "GOAL");
    const d = await maybeInitiateGoal({ prompt: LARGE }, grayDeps({ store, judgeCall: judge }));
    expect(judge).toHaveBeenCalledTimes(1);
    expect(d.mode).toBe("task");
    expect(created).toHaveLength(1);
  });

  it("stays inline when the judge says INLINE", async () => {
    const { store, created } = fakeStore();
    const judge = vi.fn(async () => "INLINE");
    const d = await maybeInitiateGoal({ prompt: LARGE }, grayDeps({ store, judgeCall: judge }));
    expect(judge).toHaveBeenCalledTimes(1);
    expect(d.mode).toBe("inline");
    expect(created).toHaveLength(0);
  });

  it("degrades to inline when no judge is registered", async () => {
    const { store, created } = fakeStore();
    const d = await maybeInitiateGoal({ prompt: LARGE }, grayDeps({ store, judgeCall: null }));
    expect(d.mode).toBe("inline");
    expect(created).toHaveLength(0);
  });

  it("degrades to inline when the judge throws", async () => {
    const { store, created } = fakeStore();
    const judge = vi.fn(async () => {
      throw new Error("judge unavailable");
    });
    const d = await maybeInitiateGoal({ prompt: LARGE }, grayDeps({ store, judgeCall: judge }));
    expect(d.mode).toBe("inline");
    expect(created).toHaveLength(0);
  });
});

describe("maybeInitiateGoal - backstops", () => {
  it("defers to inline when at task capacity (no task created)", async () => {
    const { store, created } = fakeStore();
    const d = await maybeInitiateGoal(
      { prompt: LARGE },
      deps({ store, capacity: () => ({ ok: false, reason: "test full" }) }),
    );
    expect(d.mode).toBe("inline");
    expect(d.reason).toMatch(/capacity/i);
    expect(created).toHaveLength(0);
  });

  it("stays inline when no store is available", async () => {
    const d = await maybeInitiateGoal({ prompt: LARGE }, deps({ store: null }));
    expect(d.mode).toBe("inline");
  });

  it("degrades to inline when the store throws on create", async () => {
    const store = {
      create: () => {
        throw new Error("db locked");
      },
    } as unknown as TaskStore;
    const d = await maybeInitiateGoal({ prompt: LARGE }, deps({ store }));
    expect(d.mode).toBe("inline");
    expect(d.reason).toMatch(/creation failed/i);
  });
});

describe("deriveOracle (mechanical-first, never vacuous)", () => {
  it("prefers a PR oracle", () => {
    const o = deriveOracle("do the work and open a PR", "do the work");
    expect(o.kind).toBe("mechanical");
    expect(o.doneCriteria.toLowerCase()).toContain("pull request");
  });

  it("prefers a tests oracle", () => {
    const o = deriveOracle("add tests for the parser", "add tests for the parser");
    expect(o.kind).toBe("mechanical");
    expect(o.doneCriteria.toLowerCase()).toContain("test");
  });

  it("prefers a files-build oracle when files are referenced", () => {
    const o = deriveOracle("update src/foo.ts and src/bar.ts", "update files");
    expect(o.kind).toBe("mechanical");
    expect(o.doneCriteria.toLowerCase()).toContain("build");
  });

  it("falls back to a judged oracle that is never empty", () => {
    const o = deriveOracle(
      "come up with a strategy for growth",
      "come up with a strategy for growth",
    );
    expect(o.kind).toBe("judged");
    expect(o.doneCriteria.length).toBeGreaterThan(10);
  });
});

describe("summarizeGoal", () => {
  it("takes the first sentence and bounds the length", () => {
    expect(summarizeGoal("Do the thing. Then more.")).toBe("Do the thing.");
    const long = "x".repeat(400);
    expect(summarizeGoal(long).length).toBeLessThanOrEqual(200);
  });
});
