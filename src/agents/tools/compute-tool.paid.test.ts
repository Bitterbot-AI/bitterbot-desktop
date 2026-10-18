import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/heartbeat-considerations.js", () => ({ recordConsideration: vi.fn() }));

import {
  type ComputeBackend,
  type ComputeSnapshot,
  type ComputeWatcher,
  ComputeDeliveryStore,
  computeQuoteHash,
  registerComputeBackend,
  registerComputeRuntime,
  resetComputeBackendForTest,
  resetComputeRuntimeForTest,
} from "../../compute/awareness/index.js";
import type { BitterbotConfig } from "../../config/config.js";
import { recordConsideration } from "../../infra/heartbeat-considerations.js";
import { resetReviewServiceForTest } from "../../review/runtime.js";
import { ReviewService } from "../../review/service.js";
import { ReviewStore } from "../../review/store.js";
import { createComputeTool } from "./compute-tool.js";

const snapshot = (paid?: ComputeSnapshot["paid"]): ComputeSnapshot => ({
  version: 1,
  asOf: 0,
  reachable: true,
  ...(paid ? { paid } : {}),
  pools: [],
  workers: [],
  jobs: [],
});

const quoteFor = (jobId: string) => {
  const q = { jobId, amountUsdc: 0.5, payee: "0xoperator", network: "base-sepolia" };
  return { ...q, quoteHash: computeQuoteHash(q) };
};

const paidSubmit = {
  action: "submit",
  mode: "paid_usdc",
  max_cost_usdc: 1,
  workload: "sha256",
  inputs: ["a", "b"],
};

const paidCfg = { compute: { paid: { enabled: true, maxUsdcPerJob: 2 } } } as BitterbotConfig;

describe("compute tool, Phase 4 (paid_usdc submit becomes a hold, never a payment)", () => {
  let dir: string;
  let reviewStore: ReviewStore;
  let service: ReviewService;
  let store: ComputeDeliveryStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-compute-paid-"));
    reviewStore = ReviewStore.open(path.join(dir, "review.sqlite"));
    service = new ReviewService({ store: reviewStore, executors: new Map() });
    resetReviewServiceForTest(service);
    store = ComputeDeliveryStore.inMemory();
    vi.mocked(recordConsideration).mockClear();
  });

  afterEach(async () => {
    resetComputeBackendForTest();
    resetComputeRuntimeForTest();
    resetReviewServiceForTest(null);
    store.close();
    reviewStore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function arm(paid?: ComputeSnapshot["paid"]) {
    const submit = vi.fn(async () => ({ id: "job-p", status: "awaiting_payment" }));
    const quote = vi.fn(async (id: string) => quoteFor(id));
    const fund = vi.fn(async () => ({ txHash: "0xnever", status: "never" }));
    const backend: ComputeBackend = {
      snapshot: async () => snapshot(paid),
      jobs: async () => [],
      job: async () => null,
      result: async () => null,
      submit,
      cancel: async () => ({ ok: true }),
      quote,
      fund,
    };
    registerComputeBackend(backend);
    const watcher: ComputeWatcher = {
      kick: vi.fn(),
      pollOnce: async () => null,
      reconcile: async () => 0,
      stop: () => undefined,
      isPolling: () => false,
    };
    registerComputeRuntime({ store, watcher });
    return { submit, quote, fund, watcher };
  }

  it("submits a paid job on an owner turn, holds its quote for the owner and funds nothing", async () => {
    const { submit, quote, fund, watcher } = arm({ available: true });
    const tool = createComputeTool({
      config: paidCfg,
      senderIsOwner: true,
      agentSessionKey: "agent:main:main",
    })!;
    expect(tool.description).toContain("paid_usdc");
    const res = await tool.execute("call-1", paidSubmit);
    const details = res.details as {
      ok: boolean;
      job_id: string;
      status: string;
      mode: string;
      awaiting_payment: Record<string, unknown>;
    };
    expect(details).toMatchObject({
      ok: true,
      job_id: "job-p",
      status: "awaiting_payment",
      mode: "paid_usdc",
    });
    expect(details.awaiting_payment).toMatchObject({
      quoted: true,
      amount_usdc: 0.5,
      payee: "0xoperator",
    });
    expect(typeof details.awaiting_payment.review_id).toBe("string");
    expect(String(details.awaiting_payment.how)).toContain("bitterbot compute approve");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toMatchObject({
      mode: { kind: "paid_usdc", maxCostUsdc: 1 },
      workload: "sha256",
      inputs: ["a", "b"],
      idempotencyKey: "agent:call-1",
    });
    expect(quote).toHaveBeenCalledWith("job-p");
    expect(fund).not.toHaveBeenCalled();
    expect(watcher.kick).toHaveBeenCalled();
    expect(store.originOf("job-p")).toMatchObject({
      origin: "agent",
      sessionKey: "agent:main:main",
    });
    const holds = service.pendingFor("compute", { job_id: "job-p" });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      cls: "spend",
      tool: "compute",
      sessionKey: "agent:main:main",
    });
    expect(holds[0]!.preview).toContain("0.5 USDC");
    expect(holds[0]!.params).toMatchObject({
      action: "fund",
      job_id: "job-p",
      quote_hash: quoteFor("job-p").quoteHash,
    });
    expect(vi.mocked(recordConsideration)).toHaveBeenCalledWith(
      expect.objectContaining({ category: "compute-payment", decision: "deferred" }),
    );
    // Submitting the same call again does not create a second hold.
    await tool.execute("call-1", paidSubmit);
    expect(service.pendingFor("compute", { job_id: "job-p" })).toHaveLength(1);
  });

  it("refuses paid_usdc when the coordinator does not offer paid work, without submitting", async () => {
    const { submit } = arm({ available: false, reason: "invite required" });
    const tool = createComputeTool({ config: paidCfg, senderIsOwner: true })!;
    const res = await tool.execute("c", paidSubmit);
    expect(res.details).toMatchObject({ ok: false });
    expect(String((res.details as { error: string }).error)).toMatch(/invite required/);
    expect(submit).not.toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
  });

  it("validates the paid request before the coordinator sees it", async () => {
    const { submit } = arm({ available: true });
    const tool = createComputeTool({ config: paidCfg, senderIsOwner: true })!;
    await expect(tool.execute("1", { ...paidSubmit, max_cost_usdc: 3 })).rejects.toThrow(
      /per-job cap/,
    );
    await expect(tool.execute("2", { ...paidSubmit, max_cost_usdc: 0 })).rejects.toThrow(
      /positive/,
    );
    const noCeiling: Record<string, unknown> = { ...paidSubmit };
    delete noCeiling.max_cost_usdc;
    await expect(tool.execute("3", noCeiling)).rejects.toThrow();
    await expect(tool.execute("4", { ...paidSubmit, mode: "paid" })).rejects.toThrow(/Credit-paid/);
    expect(submit).not.toHaveBeenCalled();
    // Paid off in config: the mode is refused up front and not advertised.
    const offTool = createComputeTool({ config: {}, senderIsOwner: true })!;
    expect(offTool.description).toContain("Paid modes are not available here");
    await expect(offTool.execute("5", paidSubmit)).rejects.toThrow(/Paid compute is off/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("has no action that funds, whatever the params say", async () => {
    const { fund } = arm({ available: true });
    const tool = createComputeTool({ config: paidCfg, senderIsOwner: true })!;
    for (const action of ["fund", "approve", "pay", "approve_compute"]) {
      await expect(
        tool.execute(action, { action, job_id: "job-p", amount_usdc: 0.5 }),
      ).rejects.toThrow();
    }
    expect(fund).not.toHaveBeenCalled();
    expect(JSON.stringify(tool.parameters)).not.toMatch(/"(fund|approve|pay)"/);
  });

  it("refuses paid_usdc on a non-owner turn like every other submit", async () => {
    const { submit } = arm({ available: true });
    const tool = createComputeTool({ config: paidCfg, senderIsOwner: false })!;
    const res = await tool.execute("g", paidSubmit);
    expect(res.details).toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
  });
});
