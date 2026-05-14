import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../config/config.js";
import type { HormonalState } from "../memory/hormonal.js";
import { acquireTaskSlot, resetActiveTaskTrackerForTests } from "./active-task-tracker.js";
import {
  isHormonalGateEnabled,
  peekHormonalAccessorState,
  startHormonalAccessor,
  stopHormonalAccessor,
} from "./hormonal-accessor.js";

const cfg = {} as BitterbotConfig;

function state(p: Partial<HormonalState>): HormonalState {
  return { dopamine: 0.15, cortisol: 0.02, oxytocin: 0.2, lastDecay: 0, ...p };
}

describe("hormonal-accessor", () => {
  beforeEach(() => {
    resetActiveTaskTrackerForTests();
  });

  afterEach(() => {
    stopHormonalAccessor();
    resetActiveTaskTrackerForTests();
    delete process.env.BITTERBOT_TASKS_HORMONAL_GATE;
    delete process.env.BITTERBOT_TASKS_HORMONAL_REFRESH_MS;
  });

  it("registers a getter that returns the static state when staticState is provided", () => {
    const ok = startHormonalAccessor(cfg, { staticState: state({ cortisol: 0.8 }) });
    expect(ok).toBe(true);
    const slot = acquireTaskSlot({ jobId: "j1" });
    // High cortisol → focused single-task mode (maxConcurrent=1).
    expect(slot.policy.maxConcurrent).toBe(1);
    expect(slot.policy.rationale).toMatch(/cortisol/);
  });

  it("the active-task-tracker reads via the accessor getter on each call", () => {
    startHormonalAccessor(cfg, { staticState: state({ dopamine: 0.75 }) });
    const a = acquireTaskSlot({ jobId: "j1" });
    expect(a.policy.maxConcurrent).toBe(4);
  });

  it("polls the refresh fn at the configured cadence", async () => {
    let counter = 0.0;
    const refresh = vi.fn(async () => {
      counter += 0.1;
      return state({ cortisol: counter });
    });
    startHormonalAccessor(cfg, { refresh, refreshMs: 20 });
    // Immediate first refresh.
    await new Promise((r) => setTimeout(r, 5));
    expect(refresh).toHaveBeenCalled();
    const before = peekHormonalAccessorState();
    expect(before?.cortisol).toBeGreaterThan(0);

    // Wait for at least one more tick.
    await new Promise((r) => setTimeout(r, 60));
    const after = peekHormonalAccessorState();
    expect(after && before).toBeTruthy();
    expect(after!.cortisol).toBeGreaterThan(before!.cortisol);
  });

  it("survives the refresh fn throwing — cache stays null, no exception bubbles", async () => {
    let calls = 0;
    const refresh = vi.fn(async () => {
      calls += 1;
      throw new Error("provider down");
    });
    // Long interval so only the initial immediate call fires during this test.
    startHormonalAccessor(cfg, { refresh, refreshMs: 60_000 });
    await new Promise((r) => setTimeout(r, 25));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(peekHormonalAccessorState()).toBeNull();
  });

  it("is disabled when BITTERBOT_TASKS_HORMONAL_GATE=0", () => {
    process.env.BITTERBOT_TASKS_HORMONAL_GATE = "0";
    expect(isHormonalGateEnabled()).toBe(false);
    const ok = startHormonalAccessor(cfg, { staticState: state({ cortisol: 0.9 }) });
    expect(ok).toBe(false);
    // The active-task-tracker has no getter; falls back to baseline.
    const slot = acquireTaskSlot({ jobId: "j1" });
    expect(slot.policy.rationale).toBe("baseline");
  });

  it("start is idempotent", () => {
    startHormonalAccessor(cfg, { staticState: state({ cortisol: 0.3 }) });
    const second = startHormonalAccessor(cfg, { staticState: state({ cortisol: 0.9 }) });
    expect(second).toBe(true);
    // The second call is a no-op; the original static state is still in effect.
    const slot = acquireTaskSlot({ jobId: "j1" });
    expect(slot.policy.maxConcurrent).toBe(2);
  });

  it("stop clears the cached state and unregisters the getter", () => {
    startHormonalAccessor(cfg, { staticState: state({ cortisol: 0.7 }) });
    expect(peekHormonalAccessorState()?.cortisol).toBe(0.7);
    stopHormonalAccessor();
    expect(peekHormonalAccessorState()).toBeNull();
    // After stop, the tracker falls back to baseline.
    const slot = acquireTaskSlot({ jobId: "j1" });
    expect(slot.policy.rationale).toBe("baseline");
  });
});
