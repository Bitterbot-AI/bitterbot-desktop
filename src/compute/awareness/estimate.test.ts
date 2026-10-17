import { beforeEach, describe, expect, it } from "vitest";
import type { ComputeSnapshot, ComputeWorker } from "./backend.js";
import {
  estimateCompute,
  recordComputeDuration,
  resetComputeEstimatesForTest,
} from "./estimate.js";

function worker(over: Partial<ComputeWorker> & { id: string }): ComputeWorker {
  return {
    online: true,
    paused: false,
    gpu: false,
    cpuThreads: 1,
    memoryMib: 512,
    pools: ["lab"],
    projects: [],
    modes: ["private"],
    ...over,
  };
}

function snap(workers: ComputeWorker[]): ComputeSnapshot {
  return { version: 1, asOf: 0, reachable: true, pools: [], workers, jobs: [] };
}

describe("estimateCompute", () => {
  beforeEach(() => resetComputeEstimatesForTest());

  it("uses priors until a worker has history, and says so", () => {
    const e = estimateCompute({
      snapshot: snap([worker({ id: "gpu", gpu: true }), worker({ id: "cpu" })]),
      workload: "embeddings",
      items: 100,
    });
    expect(e.recommended?.worker).toBe("gpu");
    expect(e.recommended?.basis).toBe("prior");
    expect(e.note).toMatch(/priors/);
    // GPU prior 40 ms/item + 1.5 s overhead = ~6 s; CPU is ineligible for embeddings.
    expect(e.recommended?.estSeconds).toBe(6);
    expect(e.options.find((o) => o.worker === "cpu")?.ineligible).toBe("no GPU");
  });

  it("learns the median duration per worker and workload", () => {
    for (const ms of [8_000, 1_000, 2_000]) {
      recordComputeDuration({
        workerId: "gpu",
        workload: "embeddings",
        items: 100,
        durationMs: ms,
      });
    }
    const e = estimateCompute({
      snapshot: snap([worker({ id: "gpu", gpu: true })]),
      workload: "embeddings",
      items: 100,
    });
    // median per item = 20 ms -> 2 s + 1.5 s overhead -> 4 s (rounded)
    expect(e.recommended).toMatchObject({ basis: "history", estSeconds: 4 });
    expect(e.note).toMatch(/median/);
  });

  it("explains every ineligible worker", () => {
    const e = estimateCompute({
      snapshot: snap([
        worker({ id: "offline", online: false, gpu: true }),
        worker({ id: "paused", paused: true, gpu: true }),
        worker({ id: "elsewhere", gpu: true, pools: ["other"] }),
        worker({ id: "wrong-model", gpu: true, modelDigest: "bbbb" }),
        worker({ id: "no-gpu", gpuUnavailableReason: "driver missing" }),
      ]),
      workload: "embeddings",
      items: 10,
      scope: "lab",
      modelDigest: "aaaa",
    });
    const why = Object.fromEntries(e.options.map((o) => [o.worker, o.ineligible]));
    expect(why).toEqual({
      offline: "offline",
      paused: "paused",
      elsewhere: "not in lab",
      "wrong-model": "different embedding model",
      "no-gpu": "no GPU (driver missing)",
    });
    expect(e.recommended).toBeNull();
    expect(e.note).toMatch(/No eligible worker/);
  });

  it("prefers the fastest option, then free over paid, then GPU", () => {
    const e = estimateCompute({
      snapshot: snap([
        worker({ id: "paid-fast", gpu: true, modes: ["paid"] }),
        worker({ id: "free-fast", gpu: true, modes: ["private"] }),
      ]),
      workload: "sha256",
      items: 10,
    });
    expect(e.recommended?.worker).toBe("free-fast");
    expect(e.options.find((o) => o.worker === "paid-fast")?.cost).toEqual({
      amount: 10,
      unit: "credits",
    });
    expect(e.options.find((o) => o.worker === "free-fast")?.cost).toEqual({
      amount: 0,
      unit: "free",
    });
  });

  it("with no workers says local is the only option", () => {
    const e = estimateCompute({ snapshot: snap([]), workload: "sha256", items: 3 });
    expect(e.options).toEqual([]);
    expect(e.recommended).toBeNull();
    expect(e.note).toMatch(/Local processing/);
  });

  it("ignores nonsense samples", () => {
    recordComputeDuration({ workerId: "w", workload: "sha256", items: 0, durationMs: 100 });
    recordComputeDuration({ workerId: "w", workload: "sha256", items: 5, durationMs: -1 });
    const e = estimateCompute({
      snapshot: snap([worker({ id: "w" })]),
      workload: "sha256",
      items: 5,
    });
    expect(e.recommended?.basis).toBe("prior");
  });
});
