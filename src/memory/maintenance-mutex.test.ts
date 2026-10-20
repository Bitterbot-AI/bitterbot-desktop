/**
 * PLAN-46 Phase 4 (invariant I4): the maintenance mutex runs jobs one at a time,
 * FIFO, so two heavy maintenance jobs cannot interleave writes or pile onto the
 * event loop together.
 */
import { describe, expect, it } from "vitest";
import { MaintenanceMutex } from "./maintenance-mutex.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("MaintenanceMutex (PLAN-46 Phase 4)", () => {
  it("runs jobs one at a time — no overlap even when started concurrently", async () => {
    const mutex = new MaintenanceMutex();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const job = (label: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      order.push(label);
      active -= 1;
    };
    await Promise.all([
      mutex.run("a", job("a")),
      mutex.run("b", job("b")),
      mutex.run("c", job("c")),
    ]);
    expect(maxActive).toBe(1); // never two at once
    expect(order).toEqual(["a", "b", "c"]); // FIFO
  });

  it("exposes the running label and clears it after", async () => {
    const mutex = new MaintenanceMutex();
    expect(mutex.running).toBeNull();
    const p = mutex.run("consolidation", async () => {
      expect(mutex.running).toBe("consolidation");
      await tick();
    });
    await p;
    expect(mutex.running).toBeNull();
  });

  it("a throwing job releases the lock so the next job still runs", async () => {
    const mutex = new MaintenanceMutex();
    const boom = mutex.run("boom", async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    let ran = false;
    await mutex.run("next", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(mutex.running).toBeNull();
  });

  it("returns the job's value", async () => {
    const mutex = new MaintenanceMutex();
    expect(await mutex.run("v", async () => 42)).toBe(42);
  });
});
