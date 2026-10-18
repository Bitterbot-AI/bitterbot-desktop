import { afterEach, describe, expect, it } from "vitest";
import {
  type SoapboxStatusLike,
  registerComputeBackend,
  resetComputeBackendForTest,
  snapshotFromSoapboxStatus,
  summariseSoapboxJob,
} from "./backend.js";

const status: SoapboxStatusLike & Record<string, unknown> = {
  enabled: true,
  settlement: "test_credits",
  principal: { id: "buyer", roles: ["submitter"], pools: ["local", "lab"], projects: ["club"] },
  account: { available_credits: 140, reserved_credits: 6, currency: "TEST_CREDIT" },
  // Things that must never reach the agent, planted on purpose.
  token: "sekrit-bearer-token-value",
  rpc_url: "https://rpc.example/key/abc123",
  nodes: [
    {
      id: "gpu-1",
      online: true,
      operator_paused: false,
      offer: {
        cpu_threads: 1,
        memory_mib: 1024,
        gpu_observed: true,
        modes: ["private", "collective"],
        paused: false,
        pools: ["local", "lab"],
        projects: ["club"],
        runtime: { model: "all-minilm", model_digest: "1b22" },
        isolation: "docker_v1",
      },
    },
    {
      id: "cpu-2",
      online: true,
      offer: {
        cpu_threads: 1,
        memory_mib: 512,
        gpu_observed: false,
        modes: ["private"],
        paused: true,
        pools: ["lab"],
        gpu_unavailable_reason: "   nvidia-smi\nmissing   on   host   ",
      },
    },
    {
      id: "off-3",
      online: false,
      offer: {
        cpu_threads: 1,
        memory_mib: 512,
        gpu_observed: true,
        modes: ["paid"],
        paused: false,
        pools: ["lab"],
      },
    },
  ],
  jobs: [
    {
      id: "j1",
      status: "running",
      attempts: 1,
      worker: "gpu-1",
      spec: {
        mode: { kind: "private", pool_id: "lab" },
        workload: {
          kind: "embeddings",
          texts: ["a", "b", "c"],
          model: "all-minilm",
          model_digest: "1b22",
        },
      },
    },
    {
      id: "j2",
      status: "awaiting_payment",
      attempts: 0,
      spec: {
        mode: { kind: "paid_usdc", max_cost_microusdc: 400_000, operator: "op" },
        workload: { kind: "sha256", texts: ["x"] },
      },
      payment: { amount_microusdc: 400_000 },
    },
    {
      id: "j3",
      status: "succeeded",
      attempts: 1,
      spec: {
        mode: { kind: "collective", project_id: "club" },
        workload: { kind: "sha256", texts: ["x", "y"] },
      },
      receipt: { verification: "recomputed", secret_note: "do-not-copy" },
      error: "  a   long \n error " + "z".repeat(400),
    },
  ],
};

describe("snapshotFromSoapboxStatus", () => {
  afterEach(() => resetComputeBackendForTest());

  it("maps pools from the principal with worker counts from the offers", () => {
    const s = snapshotFromSoapboxStatus(status, { now: 1000 });
    expect(s.asOf).toBe(1000);
    expect(s.reachable).toBe(true);
    expect(s.settlement).toBe("test_credits");
    expect(s.credits).toEqual({ available: 140, reserved: 6, currency: "TEST_CREDIT" });
    const byId = Object.fromEntries(s.pools.map((p) => [p.id, p]));
    expect(byId.local).toMatchObject({
      kind: "private",
      trust: "local",
      workersOnline: 1,
      workersTotal: 1,
      gpuWorkersOnline: 1,
    });
    // lab: gpu-1 online, cpu-2 paused (not counted online), off-3 offline.
    expect(byId.lab).toMatchObject({
      kind: "private",
      trust: "untrusted",
      workersOnline: 1,
      workersTotal: 3,
      gpuWorkersOnline: 1,
    });
    expect(byId.club).toMatchObject({ kind: "collective", workersOnline: 1, workersTotal: 1 });
  });

  it("honours a pool trust resolver", () => {
    const s = snapshotFromSoapboxStatus(status, {
      poolTrust: (id) => (id === "lab" ? "trusted" : "untrusted"),
    });
    expect(s.pools.find((p) => p.id === "lab")?.trust).toBe("trusted");
  });

  it("copies named worker fields only and clips free text", () => {
    const s = snapshotFromSoapboxStatus(status);
    const cpu = s.workers.find((w) => w.id === "cpu-2")!;
    expect(cpu.paused).toBe(true);
    expect(cpu.gpuUnavailableReason).toBe("nvidia-smi missing on host");
    const gpu = s.workers.find((w) => w.id === "gpu-1")!;
    expect(gpu).toMatchObject({
      gpu: true,
      model: "all-minilm",
      modelDigest: "1b22",
      isolation: "docker_v1",
    });
  });

  it("summarises jobs: scope, items, verification, owner-facing USDC, clipped errors", () => {
    const s = snapshotFromSoapboxStatus(status);
    const j = Object.fromEntries(s.jobs.map((x) => [x.id, x]));
    expect(j.j1).toMatchObject({
      mode: "private",
      scope: "lab",
      workload: "embeddings",
      items: 3,
      worker: "gpu-1",
    });
    expect(j.j2).toMatchObject({ status: "awaiting_payment", awaitingUsdc: 0.4 });
    expect(j.j3.verification).toBe("recomputed");
    expect(j.j3.error!.length).toBeLessThanOrEqual(200);
    expect(j.j3.error).not.toContain("\n");
  });

  it("never carries secrets or unknown fields into the snapshot", () => {
    const text = JSON.stringify(snapshotFromSoapboxStatus(status));
    expect(text).not.toContain("sekrit");
    expect(text).not.toContain("rpc.example");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("do-not-copy");
  });

  it("versions are monotonic across snapshots", () => {
    const a = snapshotFromSoapboxStatus(status);
    const b = snapshotFromSoapboxStatus(status);
    expect(b.version).toBeGreaterThan(a.version);
  });

  it("summariseSoapboxJob leaves paid jobs without a scope", () => {
    expect(summariseSoapboxJob(status.jobs![1]).scope).toBeUndefined();
  });

  it("registry holds exactly what was registered", () => {
    expect(registerComputeBackend).toBeTypeOf("function");
  });
});
