import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComputeBackend,
  type ComputeJobSummary,
  type ComputeSnapshot,
  type ComputeWatcher,
  ComputeDeliveryStore,
  registerComputeBackend,
  registerComputeRuntime,
  resetComputeBackendForTest,
  resetComputeRuntimeForTest,
} from "../../compute/awareness/index.js";
import {
  COMPUTE_MAX_INPUT_BYTES,
  COMPUTE_RESULT_MAX_CHARS,
  createComputeTool,
} from "./compute-tool.js";

const snapshot: ComputeSnapshot = {
  version: 1,
  asOf: 0,
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
  ],
  workers: [],
  jobs: [],
};

function backend(over: Partial<ComputeBackend> = {}): ComputeBackend {
  return {
    snapshot: async () => snapshot,
    jobs: async () => [],
    job: async () => null,
    result: async () => null,
    ...over,
  };
}

function fakeWatcher(): ComputeWatcher & { kick: ReturnType<typeof vi.fn> } {
  return {
    kick: vi.fn(),
    pollOnce: async () => null,
    reconcile: async () => 0,
    stop: () => undefined,
    isPolling: () => false,
  };
}

const goodSubmit = {
  action: "submit",
  mode: "private",
  scope: "lab",
  workload: "sha256",
  inputs: ["a", "b", "c"],
};

describe("compute tool, Phase 2 (submit and cancel)", () => {
  let store: ComputeDeliveryStore | null = null;
  afterEach(() => {
    resetComputeBackendForTest();
    resetComputeRuntimeForTest();
    store?.close();
    store = null;
  });

  function arm(opts: { submit?: boolean; runtime?: boolean } = {}) {
    const submit = vi.fn(async () => ({ id: "job-1", status: "queued" }));
    const cancel = vi.fn(async () => ({ ok: true, status: "cancelled" }));
    registerComputeBackend(backend(opts.submit === false ? {} : { submit, cancel }));
    store = ComputeDeliveryStore.inMemory();
    const watcher = fakeWatcher();
    if (opts.runtime !== false) {
      registerComputeRuntime({ store, watcher });
    }
    return { submit, cancel, watcher, store };
  }

  it("stays read-only when the backend cannot submit or no runtime is registered", () => {
    arm({ submit: false });
    let tool = createComputeTool({ config: {}, senderIsOwner: true })!;
    expect(JSON.stringify(tool.parameters)).not.toContain('"submit"');
    resetComputeBackendForTest();
    resetComputeRuntimeForTest();
    store?.close();
    arm({ runtime: false });
    tool = createComputeTool({ config: {}, senderIsOwner: true })!;
    expect(JSON.stringify(tool.parameters)).not.toContain('"submit"');
    expect(tool.description).not.toContain("- submit:");
  });

  it("offers submit and cancel when both are available, and never a funding action", () => {
    arm();
    const tool = createComputeTool({ config: {}, senderIsOwner: true })!;
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain('"submit"');
    expect(schema).toContain('"cancel"');
    for (const forbidden of ["fund", "approve", "pay", "paid_usdc"]) {
      expect(schema).not.toContain(`"${forbidden}"`);
    }
  });

  it("refuses submit and cancel on a non-owner turn without touching the backend", async () => {
    const { submit, cancel } = arm();
    const tool = createComputeTool({ config: {}, senderIsOwner: false })!;
    const res = await tool.execute("c1", goodSubmit);
    expect(res.details).toMatchObject({ ok: false });
    expect(String((res.details as { error: string }).error)).toMatch(/only the owner/);
    const c = await tool.execute("c2", { action: "cancel", job_id: "x" });
    expect(c.details).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects paid modes and bad inputs before anything reaches the coordinator", async () => {
    const { submit } = arm();
    const tool = createComputeTool({ config: {}, senderIsOwner: true })!;
    await expect(tool.execute("1", { ...goodSubmit, mode: "paid_usdc" })).rejects.toThrow(
      /Paid compute is off/,
    );
    await expect(tool.execute("1b", { ...goodSubmit, mode: "paid" })).rejects.toThrow(
      /Credit-paid jobs cannot be started/,
    );
    await expect(tool.execute("2", { ...goodSubmit, mode: "whatever" })).rejects.toThrow(
      /private, collective or paid_usdc/,
    );
    await expect(tool.execute("3", { ...goodSubmit, inputs: [] })).rejects.toThrow(
      /inputs required/,
    );
    await expect(
      tool.execute("4", { ...goodSubmit, inputs: Array.from({ length: 129 }, () => "x") }),
    ).rejects.toThrow(/1 to 128/);
    await expect(
      tool.execute("5", { ...goodSubmit, inputs: ["y".repeat(COMPUTE_MAX_INPUT_BYTES + 1)] }),
    ).rejects.toThrow(/exceed/);
    await expect(tool.execute("6", { ...goodSubmit, workload: "embeddings" })).rejects.toThrow(
      /model and model_digest/,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits, records an agent origin in the session, kicks the watcher, and reports a missing task link honestly", async () => {
    const { submit, watcher, store } = arm();
    const tool = createComputeTool({
      config: {},
      senderIsOwner: true,
      agentSessionKey: "agent:main:task-7",
    })!;
    const res = await tool.execute("call-42", { ...goodSubmit, task_id: "t-1" });
    expect(submit).toHaveBeenCalledWith({
      mode: { kind: "private", poolId: "lab" },
      workload: "sha256",
      inputs: ["a", "b", "c"],
      model: undefined,
      modelDigest: undefined,
      idempotencyKey: "agent:call-42",
    });
    expect(watcher.kick).toHaveBeenCalledTimes(1);
    expect(store.originOf("job-1")).toMatchObject({
      origin: "agent",
      sessionKey: "agent:main:task-7",
    });
    expect(res.details).toMatchObject({ ok: true, job_id: "job-1", status: "queued", items: 3 });
    // No task store is active in this test, so the link reports its failure rather than pretending.
    expect((res.details as { task: { linked: boolean; error: string } }).task).toMatchObject({
      linked: false,
      error: "task store is not active",
    });
  });

  it("cancels only jobs this agent started", async () => {
    const { cancel, store } = arm();
    store.recordOrigin("mine", "agent", "agent:main:main");
    store.recordOrigin("theirs", "owner", null);
    const tool = createComputeTool({ config: {}, senderIsOwner: true })!;
    expect((await tool.execute("1", { action: "cancel", job_id: "theirs" })).details).toMatchObject(
      { ok: false },
    );
    expect(
      (await tool.execute("2", { action: "cancel", job_id: "unknown" })).details,
    ).toMatchObject({ ok: false });
    expect(cancel).not.toHaveBeenCalled();
    expect((await tool.execute("3", { action: "cancel", job_id: "mine" })).details).toMatchObject({
      ok: true,
      status: "cancelled",
    });
    expect(cancel).toHaveBeenCalledWith("mine");
  });

  it("writes an oversized result to the workspace and returns the path", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-compute-ws-"));
    try {
      arm();
      registerComputeBackend(
        backend({
          result: async (id) => ({
            id,
            status: "succeeded",
            result: { blob: "z".repeat(COMPUTE_RESULT_MAX_CHARS + 5) },
            receipt: null,
            verification: "recomputed",
          }),
        }),
      );
      const tool = createComputeTool({ config: {}, workspaceDir })!;
      const details = (await tool.execute("1", { action: "result", job_id: "../../etc/passwd" }))
        .details as Record<string, unknown>;
      const file = String(details.result_path);
      expect(file.startsWith(path.join(workspaceDir, "compute"))).toBe(true);
      expect(path.basename(file)).toBe(".._.._etc_passwd.json");
      expect(fs.existsSync(file)).toBe(true);
      expect(details.result).toBeNull();
      expect(String(details.result_summary)).toContain("written to");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("renderJob keeps the read surface unchanged", () => {
  it("still lists in-flight jobs", async () => {
    const running: ComputeJobSummary = {
      id: "r",
      status: "running",
      mode: "private",
      workload: "sha256",
      items: 1,
      attempts: 1,
    };
    registerComputeBackend(backend({ snapshot: async () => ({ ...snapshot, jobs: [running] }) }));
    const tool = createComputeTool({ config: {} })!;
    const details = (await tool.execute("1", { action: "status" })).details as {
      jobs_in_flight: unknown[];
    };
    expect(details.jobs_in_flight).toHaveLength(1);
    resetComputeBackendForTest();
  });
});
