import { afterEach, describe, expect, it } from "vitest";
import {
  type ComputeBackend,
  type ComputeJobSummary,
  registerComputeBackend,
  resetComputeBackendForTest,
  snapshotFromSoapboxStatus,
} from "../../compute/awareness/index.js";
import { COMPUTE_RESULT_MAX_CHARS, createComputeTool } from "./compute-tool.js";

const jobs: ComputeJobSummary[] = [
  {
    id: "j1",
    status: "running",
    mode: "private",
    scope: "lab",
    workload: "embeddings",
    items: 3,
    attempts: 1,
    worker: "gpu-1",
  },
  {
    id: "j2",
    status: "awaiting_payment",
    mode: "paid_usdc",
    workload: "sha256",
    items: 1,
    attempts: 0,
    awaitingUsdc: 0.4,
  },
  {
    id: "j3",
    status: "succeeded",
    mode: "collective",
    scope: "club",
    workload: "sha256",
    items: 2,
    attempts: 1,
    verification: "recomputed",
  },
];

function fakeBackend(over: Partial<ComputeBackend> = {}): ComputeBackend {
  const snapshot = snapshotFromSoapboxStatus(
    {
      enabled: true,
      settlement: "test_credits",
      principal: { id: "me", roles: ["submitter"], pools: ["local", "lab"], projects: [] },
      account: { available_credits: 12, reserved_credits: 0, currency: "TEST_CREDIT" },
      // planted, must never surface
      ...({ token: "sekrit-token", rpc_url: "https://rpc.example/k/abc" } as object),
      nodes: [
        {
          id: "gpu-1",
          online: true,
          offer: {
            cpu_threads: 1,
            memory_mib: 1024,
            gpu_observed: true,
            modes: ["private"],
            paused: false,
            pools: ["local", "lab"],
          },
        },
      ],
    },
    { now: 1_700_000_000_000 },
  );
  snapshot.jobs = jobs;
  return {
    snapshot: async () => snapshot,
    jobs: async (opts) =>
      jobs.filter((j) => !opts?.status || j.status === opts.status).slice(0, opts?.limit ?? 10),
    job: async (id) => jobs.find((j) => j.id === id) ?? null,
    result: async (id) =>
      id === "j3"
        ? {
            id,
            status: "succeeded",
            result: { hashes: ["aa", "bb"] },
            receipt: { verification: "recomputed" },
            verification: "recomputed",
          }
        : null,
    ...over,
  };
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? "").join("\n");
}

describe("compute tool", () => {
  afterEach(() => resetComputeBackendForTest());

  it("does not exist without a backend (zero cost on a node with no pool)", () => {
    expect(createComputeTool({ config: {} })).toBeUndefined();
  });

  it("does not exist when compute.enabled is false, even with a backend", () => {
    registerComputeBackend(fakeBackend());
    expect(createComputeTool({ config: { compute: { enabled: false } } })).toBeUndefined();
  });

  it("exists with a backend and is read-only: no submit, cancel or fund action", () => {
    registerComputeBackend(fakeBackend());
    const tool = createComputeTool({ config: {} })!;
    expect(tool.name).toBe("compute");
    const schema = JSON.stringify(tool.parameters);
    for (const forbidden of ["submit", "cancel", "fund", "approve", "pay"]) {
      expect(schema).not.toContain(`"${forbidden}"`);
    }
    expect(tool.description).toMatch(/cannot fund paid jobs/);
  });

  it("status renders pools, workers, in-flight jobs and jobs needing the owner", async () => {
    registerComputeBackend(fakeBackend());
    const tool = createComputeTool({ config: {} })!;
    const res = await tool.execute("1", { action: "status" });
    const out = text(res);
    expect(out).toContain('"as_of": "2023-11-14T22:13:20.000Z"');
    expect(out).toContain('"id": "lab"');
    expect(out).toContain('"gpu_workers_online": 1');
    const details = res.details as {
      jobs_in_flight: unknown[];
      jobs_needing_owner: Array<{ id: string }>;
    };
    expect(details.jobs_in_flight).toHaveLength(1);
    expect(details.jobs_needing_owner.map((j) => j.id)).toEqual(["j2"]);
  });

  it("never leaks planted secrets through any action", async () => {
    registerComputeBackend(fakeBackend());
    const tool = createComputeTool({ config: {} })!;
    for (const args of [
      { action: "status" },
      { action: "jobs" },
      { action: "job", job_id: "j1" },
      { action: "result", job_id: "j3" },
      { action: "estimate", workload: "sha256", items: 4 },
    ]) {
      const out = text(await tool.execute("x", args));
      expect(out).not.toContain("sekrit");
      expect(out).not.toContain("rpc.example");
    }
  });

  it("jobs clamps the limit and honours status_filter", async () => {
    const calls: unknown[] = [];
    registerComputeBackend(
      fakeBackend({
        jobs: async (opts) => {
          calls.push(opts);
          return jobs;
        },
      }),
    );
    const tool = createComputeTool({ config: {} })!;
    await tool.execute("1", { action: "jobs", limit: 500, status_filter: "running" });
    await tool.execute("2", { action: "jobs", limit: 0 });
    expect(calls).toEqual([
      { limit: 50, status: "running" },
      { limit: 1, status: undefined },
    ]);
  });

  it("job and result report not-found without throwing", async () => {
    registerComputeBackend(fakeBackend());
    const tool = createComputeTool({ config: {} })!;
    expect((await tool.execute("1", { action: "job", job_id: "nope" })).details).toEqual({
      found: false,
      job_id: "nope",
    });
    expect((await tool.execute("2", { action: "result", job_id: "nope" })).details).toEqual({
      found: false,
      job_id: "nope",
    });
  });

  it("result carries the verification level and summarises oversized payloads", async () => {
    registerComputeBackend(
      fakeBackend({
        result: async (id) => ({
          id,
          status: "succeeded",
          result: { blob: "y".repeat(COMPUTE_RESULT_MAX_CHARS + 10) },
          receipt: null,
          verification: "shape_only_trusted_worker",
        }),
      }),
    );
    const tool = createComputeTool({ config: {} })!;
    const details = (await tool.execute("1", { action: "result", job_id: "big" }))
      .details as Record<string, unknown>;
    expect(details.verification).toBe("shape_only_trusted_worker");
    expect(details.result).toBeNull();
    expect(String(details.result_summary)).toMatch(/too large to inline/);
  });

  it("estimate validates its inputs and returns a recommendation with the local alternative", async () => {
    registerComputeBackend(fakeBackend());
    const tool = createComputeTool({ config: {} })!;
    await expect(
      tool.execute("1", { action: "estimate", workload: "video", items: 3 }),
    ).rejects.toThrow(/workload must be one of/);
    await expect(
      tool.execute("2", { action: "estimate", workload: "sha256", items: 0 }),
    ).rejects.toThrow(/at least 1/);
    const details = (
      await tool.execute("3", { action: "estimate", workload: "embeddings", items: 20 })
    ).details as {
      recommended: { worker: string } | null;
      local_alternative: string;
    };
    expect(details.recommended?.worker).toBe("gpu-1");
    expect(details.local_alternative).toMatch(/always available/);
  });

  it("rejects unknown actions", async () => {
    registerComputeBackend(fakeBackend());
    const tool = createComputeTool({ config: {} })!;
    await expect(tool.execute("1", { action: "fund" })).rejects.toThrow(/Unknown action/);
  });
});
