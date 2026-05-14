import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HormonalState } from "../memory/hormonal.js";
import {
  acquireTaskSlot,
  getInflightTaskCount,
  registerHormonalStateGetter,
  releaseTaskSlot,
  resetActiveTaskTrackerForTests,
} from "./active-task-tracker.js";

function state(cortisol: number, dopamine = 0.15): HormonalState {
  return { cortisol, dopamine, oxytocin: 0.2, lastDecay: 0 };
}

describe("active-task-tracker", () => {
  beforeEach(() => {
    resetActiveTaskTrackerForTests();
  });

  afterEach(() => {
    resetActiveTaskTrackerForTests();
    delete process.env.BITTERBOT_TASKS_MAX_CONCURRENT;
  });

  it("baseline state allows 3 concurrent task slots", () => {
    const a = acquireTaskSlot({ jobId: "j1", hormonalState: state(0.02) });
    const b = acquireTaskSlot({ jobId: "j2", hormonalState: state(0.02) });
    const c = acquireTaskSlot({ jobId: "j3", hormonalState: state(0.02) });
    const d = acquireTaskSlot({ jobId: "j4", hormonalState: state(0.02) });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("at_capacity");
    expect(getInflightTaskCount()).toBe(3);
  });

  it("high cortisol collapses concurrency to 1", () => {
    const a = acquireTaskSlot({ jobId: "j1", hormonalState: state(0.8) });
    const b = acquireTaskSlot({ jobId: "j2", hormonalState: state(0.8) });
    expect(a.ok).toBe(true);
    expect(a.policy.maxConcurrent).toBe(1);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("at_capacity");
  });

  it("high dopamine allows 4 concurrent slots", () => {
    for (let i = 0; i < 4; i += 1) {
      const r = acquireTaskSlot({ jobId: `j${i}`, hormonalState: state(0.02, 0.7) });
      expect(r.ok).toBe(true);
    }
    const fifth = acquireTaskSlot({ jobId: "j-extra", hormonalState: state(0.02, 0.7) });
    expect(fifth.ok).toBe(false);
  });

  it("releaseTaskSlot frees capacity", () => {
    acquireTaskSlot({ jobId: "j1", hormonalState: state(0.8) });
    expect(acquireTaskSlot({ jobId: "j2", hormonalState: state(0.8) }).ok).toBe(false);
    releaseTaskSlot("j1");
    expect(acquireTaskSlot({ jobId: "j2", hormonalState: state(0.8) }).ok).toBe(true);
  });

  it("uses the registered hormonal getter when no explicit state is passed", () => {
    registerHormonalStateGetter(() => state(0.7));
    const a = acquireTaskSlot({ jobId: "j1" });
    const b = acquireTaskSlot({ jobId: "j2" });
    expect(a.policy.maxConcurrent).toBe(1);
    expect(b.ok).toBe(false);
  });

  it("falls back to baseline hormonal state when no getter is registered", () => {
    const a = acquireTaskSlot({ jobId: "j1" });
    expect(a.policy.maxConcurrent).toBe(3);
    expect(a.policy.rationale).toBe("baseline");
  });

  it("BITTERBOT_TASKS_MAX_CONCURRENT raises the baseline cap", () => {
    process.env.BITTERBOT_TASKS_MAX_CONCURRENT = "6";
    for (let i = 0; i < 6; i += 1) {
      expect(acquireTaskSlot({ jobId: `j${i}` }).ok).toBe(true);
    }
    expect(acquireTaskSlot({ jobId: "j-extra" }).ok).toBe(false);
  });
});
