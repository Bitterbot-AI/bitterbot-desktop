/**
 * PLAN-52A decision 11 and the continuity profile.
 *
 * Cross-session recall reads other conversations' text and, with tool results,
 * their file reads and command output, so it is owner-only (same semantics as
 * applyOwnerOnlyToolPolicy: only `true` is an owner). `current_session` runs on
 * the user's critical path and gets tighter limits, depth 1 and a wall clock.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RLM_CONFIG, DEFAULT_RLM_CONTINUITY } from "../rlm/types.js";
import {
  readRangeParam,
  resolveDeepRecallLimits,
  resolveDeepRecallScope,
} from "./deep-recall-tool.js";

describe("resolveDeepRecallScope", () => {
  it("lets owners use any scope, default included", () => {
    expect(
      resolveDeepRecallScope({
        requested: "all_sessions",
        defaultScope: "recent_sessions",
        senderIsOwner: true,
      }),
    ).toEqual({ scope: "all_sessions", downgraded: false });
    expect(
      resolveDeepRecallScope({
        requested: undefined,
        defaultScope: "recent_sessions",
        senderIsOwner: true,
      }),
    ).toEqual({ scope: "recent_sessions", downgraded: false });
  });

  it("downgrades non-owners to current_session and says so", () => {
    for (const requested of ["all_sessions", "recent_sessions", undefined] as const) {
      expect(
        resolveDeepRecallScope({
          requested,
          defaultScope: "recent_sessions",
          senderIsOwner: false,
        }),
      ).toEqual({ scope: "current_session", downgraded: true });
    }
  });

  it("never flags current_session as a downgrade", () => {
    expect(
      resolveDeepRecallScope({
        requested: "current_session",
        defaultScope: "recent_sessions",
        senderIsOwner: false,
      }),
    ).toEqual({ scope: "current_session", downgraded: false });
  });
});

describe("resolveDeepRecallLimits", () => {
  it("applies the continuity profile with depth 1 and a wall clock for current_session", () => {
    const limits = resolveDeepRecallLimits({ maxDepth: 3, maxIterations: 15 }, "current_session");
    expect(limits).toEqual({
      maxIterations: DEFAULT_RLM_CONTINUITY.maxIterations,
      maxSubCalls: DEFAULT_RLM_CONTINUITY.maxSubCalls,
      maxBudget: DEFAULT_RLM_CONTINUITY.maxBudget,
      maxDepth: 1,
      wallClockMs: DEFAULT_RLM_CONTINUITY.wallClockMs,
    });
  });

  it("honours memory.rlm.continuity overrides", () => {
    const limits = resolveDeepRecallLimits(
      { continuity: { maxIterations: 4, maxBudget: 0.05, wallClockMs: 10_000 } },
      "current_session",
    );
    expect(limits.maxIterations).toBe(4);
    expect(limits.maxBudget).toBe(0.05);
    expect(limits.wallClockMs).toBe(10_000);
    expect(limits.maxSubCalls).toBe(DEFAULT_RLM_CONTINUITY.maxSubCalls);
    expect(limits.maxDepth).toBe(1);
  });

  it("keeps the research limits (and configured depth, no wall clock) for other scopes", () => {
    expect(resolveDeepRecallLimits(undefined, "all_sessions")).toEqual({
      maxIterations: DEFAULT_RLM_CONFIG.maxIterations,
      maxSubCalls: DEFAULT_RLM_CONFIG.maxSubCalls,
      maxBudget: DEFAULT_RLM_CONFIG.maxBudget,
      maxDepth: DEFAULT_RLM_CONFIG.maxDepth,
      wallClockMs: undefined,
    });
    expect(resolveDeepRecallLimits({ maxDepth: 2 }, "recent_sessions").maxDepth).toBe(2);
  });
});

describe("readRangeParam", () => {
  it("returns undefined for empty or malformed input", () => {
    expect(readRangeParam(undefined)).toBeUndefined();
    expect(readRangeParam("x")).toBeUndefined();
    expect(readRangeParam({})).toBeUndefined();
    expect(readRangeParam({ from_line: -3, to_entry: "   " })).toBeUndefined();
  });

  it("maps the tool's snake_case fields onto TranscriptRange", () => {
    expect(
      readRangeParam({ from_entry: " e1 ", to_entry: "e9", from_line: 3.7, to_line: 121 }),
    ).toEqual({ fromEntryId: "e1", toEntryId: "e9", fromLine: 3, toLine: 121 });
  });
});
