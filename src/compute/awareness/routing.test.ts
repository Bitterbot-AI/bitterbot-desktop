import { afterEach, describe, expect, it } from "vitest";
import type { ComputeSnapshot, ComputeWorker } from "./backend.js";
import { recordComputeDuration, resetComputeEstimatesForTest } from "./estimate.js";
import { CooldownBook, LOCAL_WORKER_ID, chooseEmbeddingRoute } from "./routing.js";

const NOW = 1_700_000_000_000;

function worker(over: Partial<ComputeWorker> = {}): ComputeWorker {
  return {
    id: "gpu-1",
    online: true,
    paused: false,
    gpu: true,
    cpuThreads: 8,
    memoryMib: 16_000,
    pools: ["lab"],
    projects: [],
    modes: ["private"],
    model: "nomic-embed-text",
    modelDigest: "sha256:aaaa",
    ...over,
  };
}

function snapshot(workers: ComputeWorker[], over: Partial<ComputeSnapshot> = {}): ComputeSnapshot {
  return {
    version: 1,
    asOf: NOW,
    reachable: true,
    pools: [
      {
        id: "lab",
        kind: "private",
        trust: "trusted",
        workersOnline: 1,
        workersTotal: 1,
        gpuWorkersOnline: 1,
      },
      {
        id: "proj",
        kind: "collective",
        trust: "untrusted",
        workersOnline: 1,
        workersTotal: 1,
        gpuWorkersOnline: 1,
      },
    ],
    workers,
    jobs: [],
    ...over,
  };
}

const trust = (id: string) =>
  (id === "lab" ? "trusted" : id === "local" ? "local" : "untrusted") as const;

function route(over: Partial<Parameters<typeof chooseEmbeddingRoute>[0]> = {}) {
  return chooseEmbeddingRoute({
    snapshot: snapshot([worker()]),
    items: 64,
    cls: "normal",
    modelDigest: "sha256:aaaa",
    dimensions: 768,
    poolTrust: trust,
    cooldowns: new CooldownBook(),
    marginMs: 500,
    now: NOW,
    ...over,
  });
}

describe("chooseEmbeddingRoute", () => {
  afterEach(() => resetComputeEstimatesForTest());

  it("stays local until local has a measured batch, then picks a faster GPU worker", () => {
    expect(route()).toMatchObject({ kind: "local", reason: "no local timing yet" });
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 4000,
    });
    const r = route();
    expect(r).toMatchObject({ kind: "pool", poolId: "lab", workerId: "gpu-1", trust: "trusted" });
  });

  it("stays local when the pool does not beat local by the margin", () => {
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 64,
      durationMs: 2000,
    });
    expect(route({ marginMs: 5000 })).toMatchObject({ kind: "local" });
  });

  it("never routes confidential content, and keeps personal content off untrusted pools", () => {
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 4000,
    });
    expect(route({ cls: "confidential" })).toMatchObject({
      kind: "local",
      reason: "confidential content stays local",
    });
    const untrustedOnly = snapshot([worker({ pools: ["proj"], projects: [] })]);
    expect(route({ cls: "personal", snapshot: untrustedOnly })).toMatchObject({ kind: "local" });
    expect(route({ cls: "normal", snapshot: untrustedOnly })).toMatchObject({
      kind: "pool",
      poolId: "proj",
      trust: "untrusted",
    });
  });

  it("prefers the most restrictive pool a worker serves", () => {
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 4000,
    });
    const both = snapshot([worker({ pools: ["proj", "lab"] })]);
    expect(route({ cls: "normal", snapshot: both })).toMatchObject({
      kind: "pool",
      poolId: "lab",
      trust: "trusted",
    });
  });

  it("rejects offline, paused, CPU, other-model, cooled-down and local-pool workers", () => {
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 4000,
    });
    expect(route({ snapshot: snapshot([worker({ online: false })]) })).toMatchObject({
      kind: "local",
    });
    expect(route({ snapshot: snapshot([worker({ paused: true })]) })).toMatchObject({
      kind: "local",
    });
    expect(route({ snapshot: snapshot([worker({ gpu: false })]) })).toMatchObject({
      kind: "local",
      reason: "gpu-1: no GPU",
    });
    expect(route({ snapshot: snapshot([worker({ modelDigest: "sha256:bbbb" })]) })).toMatchObject({
      kind: "local",
      reason: "gpu-1: different model",
    });
    expect(route({ snapshot: snapshot([worker({ pools: ["local"] })]) })).toMatchObject({
      kind: "local",
    });
    const cooldowns = new CooldownBook();
    cooldowns.enter("gpu-1", "digest_mismatch", NOW, 60_000);
    expect(route({ cooldowns })).toMatchObject({
      kind: "local",
      reason: "gpu-1: cooldown (digest_mismatch)",
    });
    expect(route({ cooldowns, now: NOW + 61_000 })).toMatchObject({ kind: "pool" });
  });

  it("stays local without a digest, without dimensions, or with an unreachable coordinator", () => {
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 4000,
    });
    expect(route({ modelDigest: undefined })).toMatchObject({ kind: "local" });
    expect(route({ dimensions: undefined })).toMatchObject({ kind: "local" });
    expect(route({ snapshot: snapshot([worker()], { reachable: false }) })).toMatchObject({
      kind: "local",
    });
    expect(route({ snapshot: null })).toMatchObject({ kind: "local" });
  });

  it("is deterministic: fastest learned worker first, ties by id", () => {
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 40_000,
    });
    recordComputeDuration({
      workerId: "gpu-2",
      workload: "embeddings",
      items: 64,
      durationMs: 640,
    });
    const two = snapshot([worker({ id: "gpu-1" }), worker({ id: "gpu-2" })]);
    expect(route({ snapshot: two })).toMatchObject({ kind: "pool", workerId: "gpu-2" });
    resetComputeEstimatesForTest();
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 40_000,
    });
    expect(route({ snapshot: two })).toMatchObject({ kind: "pool", workerId: "gpu-1" });
  });
});

describe("CooldownBook", () => {
  it("expires entries and lists active ones", () => {
    const b = new CooldownBook();
    b.enter("w", "timeout", NOW, 1000, "slow");
    expect(b.active("w", NOW + 999)).toMatchObject({ reason: "timeout", detail: "slow" });
    expect(b.list(NOW)).toHaveLength(1);
    expect(b.active("w", NOW + 1000)).toBeNull();
    expect(b.list(NOW + 1000)).toHaveLength(0);
  });
});
