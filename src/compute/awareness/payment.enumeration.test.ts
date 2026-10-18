/**
 * PLAN-57 §4.8, the enumeration test: no agent-origin path produces a
 * funding call, independent of whether a funding tool exists.
 *
 * Part 1 builds the whole tool set as an owner turn with paid compute on and
 * a backend that can quote and fund, then throws funding-shaped calls at
 * every tool. The backend's fund() must never run and no approval token may
 * be minted. The one paid submit that gets through becomes a review hold.
 *
 * Part 2 is static: the identifiers that reach fund() are referenced only
 * from the files that are allowed to.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../infra/heartbeat-considerations.js", () => ({ recordConsideration: vi.fn() }));

let configOverride: import("../../config/config.js").BitterbotConfig = {};
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return { ...actual, loadConfig: () => configOverride };
});

import "../../agents/test-helpers/fast-core-tools.js";
import { createBitterbotTools } from "../../agents/bitterbot-tools.js";
import { resetSpendGateForTest } from "../../payments/ap2/gate.js";
import { resetReviewServiceForTest } from "../../review/runtime.js";
import { ReviewService } from "../../review/service.js";
import { resetGatedWalletForTest } from "../../review/spend.js";
import { ReviewStore } from "../../review/store.js";
import type { ComputeBackend, ComputeSnapshot } from "./backend.js";
import { ComputeDeliveryStore } from "./deliveries.js";
import {
  registerComputeBackend,
  registerComputeRuntime,
  resetComputeBackendForTest,
  resetComputeRuntimeForTest,
} from "./index.js";
import { computePaymentCounters, computeQuoteHash, resetComputePaymentForTest } from "./payment.js";

const PROBES: Array<Record<string, unknown>> = [
  { action: "fund", job_id: "j1", jobId: "j1", amount: 0.5, amount_usdc: 0.5 },
  { action: "approve", job_id: "j1", jobId: "j1", id: "j1", decision: "approve" },
  { action: "pay", job_id: "j1", to: "0xoperator", amount: 0.5, resourceUrl: "https://x/pay" },
  { action: "approve_compute", jobId: "j1", quoteHash: "q", token: "t" },
  { action: "submit", mode: "paid_usdc", max_cost_usdc: 1, workload: "sha256", inputs: ["a"] },
];

describe("PLAN-57 §4.8: no agent-origin path funds compute", () => {
  let dir: string;
  let reviewStore: ReviewStore;
  let service: ReviewService;
  let store: ComputeDeliveryStore;
  const fund = vi.fn(async () => ({ txHash: "0xnever", status: "never" }));
  const submit = vi.fn(async () => ({ id: "j1", status: "awaiting_payment" }));

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-pay-enum-"));
    configOverride = {
      compute: { paid: { enabled: true, maxUsdcPerJob: 5 } },
      tools: { wallet: { enabled: false } },
      session: { mainKey: "main", scope: "per-sender", store: path.join(dir, "sessions.json") },
    } as typeof configOverride;
    fsSync.writeFileSync(path.join(dir, "sessions.json"), "{}", "utf8");
    reviewStore = ReviewStore.open(path.join(dir, "review.sqlite"));
    service = new ReviewService({ store: reviewStore, executors: new Map() });
    resetReviewServiceForTest(service);
    resetSpendGateForTest();
    resetGatedWalletForTest();
    resetComputePaymentForTest();
    store = ComputeDeliveryStore.inMemory();
    const snapshot: ComputeSnapshot = {
      version: 1,
      asOf: 0,
      reachable: true,
      paid: { available: true },
      pools: [],
      workers: [],
      jobs: [],
    };
    const backend: ComputeBackend = {
      snapshot: async () => snapshot,
      jobs: async () => [],
      job: async () => null,
      result: async () => null,
      submit,
      cancel: async () => ({ ok: true }),
      quote: async (jobId) => {
        const q = { jobId, amountUsdc: 0.5, payee: "0xoperator" };
        return { ...q, quoteHash: computeQuoteHash(q) };
      },
      fund,
    };
    registerComputeBackend(backend);
    registerComputeRuntime({
      store,
      watcher: {
        kick: () => undefined,
        pollOnce: async () => null,
        reconcile: async () => 0,
        stop: () => undefined,
        isPolling: () => false,
      },
    });
  });

  afterAll(async () => {
    resetComputeBackendForTest();
    resetComputeRuntimeForTest();
    resetReviewServiceForTest(null);
    store.close();
    reviewStore.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("builds the owner tool set with the compute tool present and no funding action anywhere", () => {
    const tools = createBitterbotTools({
      config: configOverride,
      senderIsOwner: true,
      agentSessionKey: "agent:main:main",
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("compute");
    for (const tool of tools) {
      const schema = JSON.stringify(tool.parameters ?? {});
      // No tool offers an action whose name says it funds or approves compute.
      expect(schema).not.toMatch(/"(fund_compute|approve_compute|compute_fund|compute_approve)"/);
    }
  }, 120_000);

  it("never reaches the backend's fund() or mints a token from any tool, whatever the params", async () => {
    const tools = createBitterbotTools({
      config: configOverride,
      senderIsOwner: true,
      agentSessionKey: "agent:main:main",
    });
    for (const tool of tools) {
      for (const [i, probe] of PROBES.entries()) {
        try {
          const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          await Promise.race([tool.execute(`probe-${tool.name}-${i}`, probe), timeout]);
        } catch {
          // A refusal is the expected answer; what matters is the spies below.
        }
      }
    }
    expect(fund).not.toHaveBeenCalled();
    expect(computePaymentCounters()).toMatchObject({ minted: 0, funded: 0 });
    expect(service.listSpendDecisions()).toHaveLength(0);
    // The one legitimate paid submit got through as a hold, not a payment.
    expect(submit).toHaveBeenCalled();
    expect(
      submit.mock.calls.every(
        ([req]) => (req as { mode: { kind: string } }).mode.kind === "paid_usdc",
      ),
    ).toBe(true);
    expect(service.pendingFor("compute", { job_id: "j1" }).length).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("keeps the funding identifiers inside the files allowed to call them", () => {
    const root = path.resolve(__dirname, "../..");
    const allowed = new Set([
      "compute/awareness/payment.ts",
      "compute/awareness/index.ts",
      "gateway/server-methods/compute.ts",
      "review/executors.ts",
    ]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "dist") {
            walk(p);
          }
          continue;
        }
        if (!p.endsWith(".ts") || p.endsWith(".test.ts")) {
          continue;
        }
        const rel = path.relative(root, p).replaceAll("\\", "/");
        const src = fsSync.readFileSync(p, "utf8");
        if (
          /\b(approveComputeFunding|mintComputeApprovalToken)\s*\(/.test(src) &&
          !allowed.has(rel)
        ) {
          hits.push(rel);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
