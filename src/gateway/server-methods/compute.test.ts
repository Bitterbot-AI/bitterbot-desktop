import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/heartbeat-considerations.js", () => ({ recordConsideration: vi.fn() }));
const writtenConfigs: unknown[] = [];
let resolvedConfig: Record<string, unknown> = {};
let snapshotValid = true;
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      compute: { paid: { enabled: true, maxUsdcPerJob: 2 }, pools: { lab: { trust: "trusted" } } },
    }),
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: {
        exists: true,
        valid: snapshotValid,
        issues: snapshotValid ? [] : [{ path: "agents", message: "unexpected token" }],
        resolved: resolvedConfig,
      },
      writeOptions: {},
    }),
    writeConfigFile: async (cfg: unknown) => {
      writtenConfigs.push(cfg);
    },
  };
});

import {
  type ComputeBackend,
  ComputeDeliveryStore,
  computeQuoteHash,
  registerComputeBackend,
  registerComputeRuntime,
  resetComputeBackendForTest,
  resetComputePaymentForTest,
  resetComputeRuntimeForTest,
  verifyComputeApprovalToken,
} from "../../compute/awareness/index.js";
import { resetSpendGateForTest } from "../../payments/ap2/gate.js";
import { resetReviewServiceForTest } from "../../review/runtime.js";
import { ReviewService } from "../../review/service.js";
import { resetGatedWalletForTest } from "../../review/spend.js";
import { ReviewStore } from "../../review/store.js";
import { computeHandlers } from "./compute.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function call(method: string, params: Record<string, unknown>, scopes: string[]) {
  return new Promise<{ ok: boolean; payload?: unknown; error?: { message?: string } }>(
    (resolve) => {
      const opts = {
        req: { type: "req", id: "1", method, params },
        params,
        client: {
          connect: { role: "operator", scopes, client: { id: "cli", displayName: "Victor" } },
        },
        isWebchatConnect: () => false,
        respond: (ok: boolean, payload?: unknown, error?: { message?: string }) =>
          resolve({ ok, payload, error }),
        context: {},
      } as unknown as GatewayRequestHandlerOptions;
      void computeHandlers[method]!(opts);
    },
  );
}

describe("compute.quote / compute.approve", () => {
  let dir: string;
  let reviewStore: ReviewStore;
  let service: ReviewService;
  let store: ComputeDeliveryStore;
  const pauseWorker = vi.fn(async (workerId: string, paused: boolean) =>
    workerId === "ghost" ? { ok: false, error: "no such worker" } : { ok: true, paused },
  );
  const fund = vi.fn(async (req: { jobId: string; quoteHash: string; approvalToken: string }) => {
    const check = verifyComputeApprovalToken(req.approvalToken, {
      jobId: req.jobId,
      quoteHash: req.quoteHash,
    });
    if (!check.ok) {
      throw new Error(`signer refused token: ${check.reason}`);
    }
    return { txHash: "0xfunded", status: "pending" };
  });
  const quoteOf = (jobId: string) => {
    const q = { jobId, amountUsdc: 0.75, payee: "0xop", network: "base-sepolia" };
    return { ...q, quoteHash: computeQuoteHash(q) };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-compute-rpc-"));
    reviewStore = ReviewStore.open(path.join(dir, "review.sqlite"));
    service = new ReviewService({ store: reviewStore, executors: new Map() });
    resetReviewServiceForTest(service);
    resetSpendGateForTest();
    resetGatedWalletForTest();
    resetComputePaymentForTest();
    fund.mockClear();
    store = ComputeDeliveryStore.inMemory();
    writtenConfigs.length = 0;
    snapshotValid = true;
    resolvedConfig = { compute: { enabled: true } };
    const backend: ComputeBackend = {
      snapshot: async () => ({
        version: 1,
        asOf: 0,
        reachable: true,
        paid: { available: true },
        pools: [
          {
            id: "lab",
            kind: "private",
            trust: "untrusted",
            workersOnline: 1,
            workersTotal: 1,
            gpuWorkersOnline: 0,
          },
        ],
        workers: [
          {
            id: "w1",
            online: true,
            paused: false,
            gpu: false,
            cpuThreads: 4,
            memoryMib: 1024,
            modes: ["private"],
          },
        ],
        jobs: [],
      }),
      jobs: async (opts) => [
        {
          id: "j-1",
          status: opts?.status ?? "running",
          mode: "private",
          scope: "lab",
          workload: "sha256",
          items: 3,
          attempts: 1,
        },
      ],
      job: async () => null,
      result: async () => null,
      quote: async (id) => (id === "none" ? null : quoteOf(id)),
      fund,
      pauseWorker,
    };
    registerComputeBackend(backend);
    registerComputeRuntime({ store, watcher: null });
  });

  afterEach(async () => {
    resetComputeBackendForTest();
    resetComputeRuntimeForTest();
    resetReviewServiceForTest(null);
    store.close();
    reviewStore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("quotes a waiting job with the paid settings and the agent's pending hold", async () => {
    service.holdSpend({
      toolName: "compute",
      params: { action: "fund", job_id: "j1", quote_hash: quoteOf("j1").quoteHash },
      preview: "Fund compute job j1",
      ctx: { sessionKey: "agent:main:main" },
    });
    const r = await call("compute.quote", { jobId: "j1" }, ["operator.read"]);
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({
      jobId: "j1",
      quote: { amountUsdc: 0.75, payee: "0xop", quoteHash: quoteOf("j1").quoteHash },
      pendingReview: expect.stringMatching(/^rv-/),
      fundedTx: null,
      paid: { enabled: true, maxUsdcPerJob: 2, maxUsdcPerDay: 20 },
    });
    const none = await call("compute.quote", { jobId: "none" }, ["operator.read"]);
    expect(none.payload).toMatchObject({ quote: null, pendingReview: null });
    const bad = await call("compute.quote", {}, ["operator.read"]);
    expect(bad.ok).toBe(false);
  });

  it("approves from an admin connection, funds once and settles the agent's hold", async () => {
    service.holdSpend({
      toolName: "compute",
      params: { action: "fund", job_id: "j1", quote_hash: quoteOf("j1").quoteHash },
      preview: "Fund compute job j1",
      ctx: { sessionKey: "agent:main:main" },
    });
    const holdId = service.pendingFor("compute", { job_id: "j1" })[0]!.id;
    const r = await call("compute.approve", { jobId: "j1", via: "cli" }, ["operator.admin"]);
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({
      ok: true,
      txHash: "0xfunded",
      amountUsdc: 0.75,
      settledReviews: [holdId],
    });
    expect(fund).toHaveBeenCalledTimes(1);
    expect(service.get(holdId)).toMatchObject({
      status: "executed",
      decidedVia: "cli",
      decidedBy: "Victor",
    });
    expect(String(service.get(holdId)!.resultSummary)).toContain("0xfunded");
    expect(store.ledger().recentPayments()[0]).toMatchObject({
      outcome: "funded",
      reviewId: holdId,
      via: "cli",
    });
    const again = await call(
      "compute.approve",
      { jobId: "j1", quoteHash: quoteOf("j1").quoteHash },
      ["operator.admin"],
    );
    expect(again.ok).toBe(false);
    expect(again.error?.message).toContain("already_funded");
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("refuses when the quote hash the caller looked at no longer matches, or the scopes are wrong", async () => {
    const stale = await call("compute.approve", { jobId: "j1", quoteHash: "old" }, [
      "operator.admin",
    ]);
    expect(stale.ok).toBe(false);
    expect(stale.error?.message).toContain("quote_changed");
    // Scope gating happens in authorizeGatewayMethod before the handler; the
    // signer still refuses a connection that somehow arrived without the scope.
    const weak = await call(
      "compute.approve",
      { jobId: "j1", quoteHash: quoteOf("j1").quoteHash },
      ["operator.write"],
    );
    expect(weak.ok).toBe(false);
    expect(weak.error?.message).toContain("missing_scope");
    expect(fund).not.toHaveBeenCalled();
    expect(store.ledger().paymentSummary(0)).toMatchObject({ refused: 2, funded: 0 });
  });

  it("needs the quote hash the caller looked at when there is no hold to take it from", async () => {
    const r = await call("compute.approve", { jobId: "j1" }, ["operator.admin"]);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("quoteHash is required");
    expect(fund).not.toHaveBeenCalled();
  });

  it("refuses an approval that arrives over the node's internal connection", async () => {
    const params = { jobId: "j1", quoteHash: quoteOf("j1").quoteHash };
    const r = await new Promise<{ ok: boolean; error?: { message?: string } }>((resolve) => {
      void computeHandlers["compute.approve"]!({
        req: { type: "req", id: "1", method: "compute.approve", params },
        params,
        client: {
          connect: {
            role: "operator",
            scopes: ["operator.admin"],
            client: { id: "gateway-client", mode: "backend" },
          },
        },
        isWebchatConnect: () => false,
        respond: (ok: boolean, _payload?: unknown, error?: { message?: string }) =>
          resolve({ ok, error }),
        context: {},
      } as unknown as GatewayRequestHandlerOptions);
    });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("internal_connection");
    expect(fund).not.toHaveBeenCalled();
  });

  it("compute.status renders the secret-free view with the owner's configured trust and paid flags", async () => {
    const r = await call("compute.status", {}, ["operator.read"]);
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({
      backend: true,
      reachable: true,
      pools: [{ id: "lab", trust: "untrusted", configured_trust: "trusted" }],
      workers: [{ id: "w1", online: true, paused: false }],
      paid: { enabled: true, available: true, maxUsdcPerJob: 2 },
      runtime: true,
    });
    expect(JSON.stringify(r.payload)).not.toMatch(/token|rpc_url|escrow/i);
  });

  it("compute.jobs passes limit and status through and renders jobs", async () => {
    const r = await call("compute.jobs", { limit: 500, status: "succeeded" }, ["operator.read"]);
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({
      jobs: [
        expect.objectContaining({ id: "j-1", status: "succeeded", workload: "sha256", items: 3 }),
      ],
    });
  });

  it("compute.pause pauses and resumes a worker and reports the backend's refusal", async () => {
    const paused = await call("compute.pause", { workerId: "w1" }, ["operator.admin"]);
    expect(paused.payload).toEqual({ workerId: "w1", paused: true });
    const resumed = await call("compute.pause", { workerId: "w1", paused: false }, [
      "operator.admin",
    ]);
    expect(resumed.payload).toEqual({ workerId: "w1", paused: false });
    expect(pauseWorker).toHaveBeenLastCalledWith("w1", false);
    const ghost = await call("compute.pause", { workerId: "ghost" }, ["operator.admin"]);
    expect(ghost.ok).toBe(false);
    expect(ghost.error?.message).toContain("no such worker");
    expect((await call("compute.pause", {}, ["operator.admin"])).ok).toBe(false);
  });

  it("compute.trust writes compute.pools.<id>.trust into the resolved config and nothing else", async () => {
    resolvedConfig = { compute: { enabled: true, pools: { other: { trust: "trusted" } } } };
    const r = await call("compute.trust", { poolId: "lab", trust: "trusted" }, ["operator.admin"]);
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({ poolId: "lab", trust: "trusted" });
    expect(writtenConfigs).toEqual([
      {
        compute: {
          enabled: true,
          pools: { other: { trust: "trusted" }, lab: { trust: "trusted" } },
        },
      },
    ]);
    const bad = await call("compute.trust", { poolId: "lab", trust: "friendly" }, [
      "operator.admin",
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toContain("trust must be");
    for (const poolId of ["a b", "__proto__", "constructor", "x".repeat(65)]) {
      const r = await call("compute.trust", { poolId, trust: "trusted" }, ["operator.admin"]);
      expect(r.ok).toBe(false);
      expect(r.error?.message).toContain("poolId must be");
    }
    const underscore = await call("compute.trust", { poolId: "lab_gpu", trust: "untrusted" }, [
      "operator.admin",
    ]);
    expect(underscore.ok).toBe(true);
    const local = await call("compute.trust", { poolId: "local", trust: "trusted" }, [
      "operator.admin",
    ]);
    expect(local.ok).toBe(false);
    expect(local.error?.message).toContain("always local");
    expect(writtenConfigs).toHaveLength(2);
  });

  it("compute.trust leaves an invalid config file untouched", async () => {
    snapshotValid = false;
    resolvedConfig = {};
    const r = await call("compute.trust", { poolId: "lab", trust: "trusted" }, ["operator.admin"]);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("left untouched");
    expect(r.error?.message).toContain("unexpected token");
    expect(writtenConfigs).toEqual([]);
  });
});
