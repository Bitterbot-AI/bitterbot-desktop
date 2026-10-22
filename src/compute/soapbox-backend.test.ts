import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SoapboxJob, SoapboxPaymentQuote, SoapboxStatus } from "../infra/soapbox-client.js";
import { getComputeBackend, resetComputeBackendForTest } from "./awareness/backend.js";
import {
  computeQuoteHash,
  mintComputeApprovalToken,
  resetComputePaymentForTest,
} from "./awareness/payment.js";
import { getComputeRuntime, resetComputeRuntimeForTest } from "./awareness/runtime.js";
import {
  attachComputeAwareness,
  createSoapboxComputeBackend,
  type SoapboxBackendClient,
} from "./soapbox-backend.js";

type Call = { method: string; path: string; body?: unknown };

function fakeClient(opts: {
  status?: () => SoapboxStatus;
  routes?: Record<string, (body?: unknown) => unknown>;
}) {
  const calls: Call[] = [];
  const client: SoapboxBackendClient = {
    async status() {
      calls.push({ method: "GET", path: "/v1/status" });
      const s = opts.status;
      if (!s) throw new Error("fetch failed");
      return s();
    },
    async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const route = opts.routes?.[`${method} ${path}`];
      if (!route) throw new Error("Soapbox: HTTP 404 not found");
      return route(body) as T;
    },
  };
  return { client, calls };
}

const payment: SoapboxPaymentQuote = {
  chain_id: 84532,
  token: "0xusdc",
  escrow: "0xescrow",
  key: "k1",
  buyer: "0xbuyer",
  operator: "0xOperatorAddr",
  amount_microusdc: 250_000,
  expires: 1_900_000_000,
};

function job(over: Partial<SoapboxJob> = {}): SoapboxJob {
  return {
    id: "job-1",
    owner: "buyer",
    status: "succeeded",
    attempts: 1,
    spec: { mode: { kind: "private", pool_id: "lab" }, workload: { kind: "sha256", texts: ["a"] } },
    result: { digests: ["ab"] },
    receipt: { verification: "recomputed" },
    error: null,
    ...over,
  };
}

const status = (): SoapboxStatus => ({
  enabled: true,
  api_version: 1,
  settlement: "usdc_escrow",
  principal: { id: "buyer", roles: ["submitter"], pools: ["lab"], projects: [] },
  nodes: [
    {
      id: "gpu-b",
      online: true,
      operator_paused: false,
      offer: {
        cpu_threads: 1,
        memory_mib: 2048,
        gpu_observed: true,
        modes: ["private", "paid_usdc"],
        paused: false,
        pools: ["lab"],
      },
    },
    {
      id: "gpu-a",
      online: true,
      operator_paused: false,
      offer: {
        cpu_threads: 1,
        memory_mib: 2048,
        gpu_observed: true,
        modes: ["paid_usdc"],
        paused: false,
      },
    },
    {
      id: "gpu-paused",
      online: true,
      operator_paused: true,
      offer: {
        cpu_threads: 1,
        memory_mib: 1,
        gpu_observed: true,
        modes: ["paid_usdc"],
        paused: false,
      },
    },
  ],
  jobs: [job()],
});

describe("createSoapboxComputeBackend", () => {
  afterEach(() => {
    resetComputePaymentForTest();
  });

  it("caches the snapshot for the TTL and marks it unreachable on failure", async () => {
    let t = 1_000;
    let fail = false;
    const { client, calls } = fakeClient({
      status: () => {
        if (fail) throw new Error("ECONNREFUSED");
        return status();
      },
    });
    const backend = createSoapboxComputeBackend({ client, now: () => t, snapshotTtlMs: 5_000 });
    const first = await backend.snapshot();
    expect(first.reachable).toBe(true);
    expect(first.pools.map((p) => p.id)).toContain("lab");
    t += 1_000;
    await backend.snapshot();
    expect(calls.filter((c) => c.path === "/v1/status")).toHaveLength(1);
    t += 10_000;
    fail = true;
    const stale = await backend.snapshot();
    expect(stale.reachable).toBe(false);
    expect(stale.pools.map((p) => p.id)).toContain("lab");
    expect(calls.filter((c) => c.path === "/v1/status")).toHaveLength(2);
  });

  it("maps jobs, a single job, its result and a missing job", async () => {
    const { client } = fakeClient({
      status,
      routes: {
        "GET /v1/jobs": () => [job(), job({ id: "job-2", status: "running" })],
        "GET /v1/jobs/job-1": () => job(),
      },
    });
    const backend = createSoapboxComputeBackend({ client });
    const jobs = await backend.jobs({ status: "running" });
    expect(jobs.map((j) => j.id)).toEqual(["job-2"]);
    expect((await backend.jobs({ limit: 1 }))?.length).toBe(1);
    const one = await backend.job("job-1");
    expect(one?.workload).toBe("sha256");
    expect(one?.scope).toBe("lab");
    const result = await backend.result("job-1");
    expect(result).toMatchObject({ id: "job-1", status: "succeeded", verification: "recomputed" });
    expect(result?.result).toEqual({ digests: ["ab"] });
    expect(await backend.job("nope")).toBeNull();
    expect(await backend.result("nope")).toBeNull();
  });

  it("submits private work with the coordinator's body shape and caps inputs", async () => {
    const { client, calls } = fakeClient({
      status,
      routes: { "POST /v1/jobs": () => job({ id: "new", status: "queued" }) },
    });
    const backend = createSoapboxComputeBackend({ client });
    const res = await backend.submit!({
      mode: { kind: "private", poolId: "lab" },
      workload: "sha256",
      inputs: ["x", "y"],
      idempotencyKey: "idem-1",
    });
    expect(res).toEqual({ id: "new", status: "queued" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      idempotency_key: "idem-1",
      mode: { kind: "private", pool_id: "lab" },
      workload: { kind: "sha256", texts: ["x", "y"] },
      resources: { cpu_threads: 1, memory_mib: 256, require_gpu: false },
    });
    await expect(
      backend.submit!({
        mode: { kind: "collective", projectId: "club" },
        workload: "embeddings",
        inputs: ["x"],
        idempotencyKey: "idem-2",
      }),
    ).rejects.toThrow(/model/);
    await expect(
      backend.submit!({
        mode: { kind: "private", poolId: "lab" },
        workload: "sha256",
        inputs: Array.from({ length: 129 }, (_, i) => String(i)),
        idempotencyKey: "idem-3",
      }),
    ).rejects.toThrow(/128/);
  });

  it("picks the lowest-id online paid operator for paid_usdc, or refuses", async () => {
    const { client, calls } = fakeClient({
      status,
      routes: { "POST /v1/jobs": () => job({ id: "paid", status: "awaiting_payment" }) },
    });
    const backend = createSoapboxComputeBackend({ client });
    await backend.submit!({
      mode: { kind: "paid_usdc", maxCostUsdc: 0.5 },
      workload: "sha256",
      inputs: ["x"],
      idempotencyKey: "idem-4",
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      mode: { kind: "paid_usdc", max_cost_microusdc: 500_000, operator: "gpu-a" },
    });
    const none = createSoapboxComputeBackend({
      client: fakeClient({ status: () => ({ ...status(), nodes: [] }) }).client,
    });
    await expect(
      none.submit!({
        mode: { kind: "paid_usdc", maxCostUsdc: 0.5 },
        workload: "sha256",
        inputs: ["x"],
        idempotencyKey: "idem-5",
      }),
    ).rejects.toThrow(/No online operator/);
  });

  it("quotes only jobs awaiting payment, with the canonical hash", async () => {
    const { client } = fakeClient({
      status,
      routes: {
        "GET /v1/jobs/job-1": () => job(),
        "GET /v1/jobs/paid": () => job({ id: "paid", status: "awaiting_payment", payment }),
      },
    });
    const backend = createSoapboxComputeBackend({ client });
    expect(await backend.quote!("job-1")).toBeNull();
    const quote = await backend.quote!("paid");
    expect(quote).toMatchObject({
      jobId: "paid",
      amountUsdc: 0.25,
      payee: "0xOperatorAddr",
      network: "eip155:84532",
      expiresAt: 1_900_000_000_000,
    });
    expect(quote?.quoteHash).toBe(
      computeQuoteHash({
        jobId: "paid",
        amountUsdc: 0.25,
        payee: "0xOperatorAddr",
        network: "eip155:84532",
      }),
    );
  });

  describe("fund (the signer)", () => {
    const authority = {
      origin: "owner" as const,
      scopes: ["operator.admin"],
      via: "gateway",
      connectionMode: null,
      decidedBy: "test",
    };
    const config = { compute: { paid: { enabled: true } } };

    function mintFor(quoteHash: string, jobId = "paid") {
      const minted = mintComputeApprovalToken({
        quote: {
          jobId,
          amountUsdc: 0.25,
          payee: "0xOperatorAddr",
          network: "eip155:84532",
          quoteHash,
        },
        authority,
        config,
      });
      if (!minted.ok) throw new Error(minted.message);
      return minted.token;
    }

    function fundable(current: () => SoapboxPaymentQuote) {
      const funded: SoapboxPaymentQuote[] = [];
      const refreshed: string[] = [];
      const { client, calls } = fakeClient({
        status,
        routes: {
          "GET /v1/jobs/paid": () =>
            job({ id: "paid", status: "awaiting_payment", payment: current() }),
          "POST /v1/jobs/paid/payment": () => {
            refreshed.push("paid");
            return job({ id: "paid", status: "funded", payment: current() });
          },
        },
      });
      const backend = createSoapboxComputeBackend({
        client,
        funder: async (q) => {
          funded.push(q);
          return { status: "submitted", txHash: "0xtx" };
        },
      });
      return { backend, funded, refreshed, calls };
    }

    it("verifies and consumes the approval token, then funds exactly that quote", async () => {
      const { backend, funded, refreshed } = fundable(() => payment);
      const quote = (await backend.quote!("paid"))!;
      const token = mintFor(quote.quoteHash);
      const res = await backend.fund!({
        jobId: "paid",
        quoteHash: quote.quoteHash,
        amountUsdc: 0.25,
        approvalToken: token,
        idempotencyKey: "fund-1",
      });
      expect(res).toEqual({ txHash: "0xtx", status: "funded" });
      expect(funded).toEqual([payment]);
      expect(refreshed).toEqual(["paid"]);
      // The same token is spent: a replay is refused before any wallet work.
      await expect(
        backend.fund!({
          jobId: "paid",
          quoteHash: quote.quoteHash,
          amountUsdc: 0.25,
          approvalToken: token,
          idempotencyKey: "fund-2",
        }),
      ).rejects.toThrow(/consumed/);
      expect(funded).toHaveLength(1);
    });

    it("refuses a token for another quote, a changed quote and a mismatched amount", async () => {
      let current = payment;
      const { backend, funded } = fundable(() => current);
      const quote = (await backend.quote!("paid"))!;
      await expect(
        backend.fund!({
          jobId: "paid",
          quoteHash: "0".repeat(64),
          amountUsdc: 0.25,
          approvalToken: mintFor(quote.quoteHash),
          idempotencyKey: "f-a",
        }),
      ).rejects.toThrow(/quote_mismatch/);
      // Coordinator re-quotes after approval: the hash no longer matches.
      const token = mintFor(quote.quoteHash);
      current = { ...payment, amount_microusdc: 900_000 };
      await expect(
        backend.fund!({
          jobId: "paid",
          quoteHash: quote.quoteHash,
          amountUsdc: 0.25,
          approvalToken: token,
          idempotencyKey: "f-b",
        }),
      ).rejects.toThrow(/changed/);
      current = payment;
      await expect(
        backend.fund!({
          jobId: "paid",
          quoteHash: quote.quoteHash,
          amountUsdc: 0.3,
          approvalToken: mintFor(quote.quoteHash),
          idempotencyKey: "f-c",
        }),
      ).rejects.toThrow(/amount/);
      expect(funded).toHaveLength(0);
    });

    it("never funds from an operator node", async () => {
      const { client } = fakeClient({ status });
      const backend = createSoapboxComputeBackend({
        client,
        role: "operator",
        funder: async () => {
          throw new Error("must not be called");
        },
      });
      await expect(
        backend.fund!({
          jobId: "paid",
          quoteHash: "x",
          amountUsdc: 1,
          approvalToken: "t",
          idempotencyKey: "op",
        }),
      ).rejects.toThrow(/Operator/);
    });
  });

  it("cancels and pauses through the coordinator routes", async () => {
    const { client, calls } = fakeClient({
      status,
      routes: {
        "POST /v1/jobs/job-1/cancel": () => job({ status: "cancelled" }),
        "POST /v1/workers/gpu-a/pause": (body) => body,
      },
    });
    const backend = createSoapboxComputeBackend({ client });
    expect(await backend.cancel!("job-1")).toEqual({ ok: true, status: "cancelled" });
    expect(await backend.pauseWorker!("gpu-a", true)).toEqual({ ok: true, paused: true });
    expect(calls.at(-1)?.body).toEqual({ paused: true });
    expect((await backend.cancel!("missing")).ok).toBe(false);
  });
});

describe("attachComputeAwareness", () => {
  beforeEach(() => {
    process.env.BITTERBOT_COMPUTE_DB = ":memory:";
  });
  afterEach(() => {
    delete process.env.BITTERBOT_COMPUTE_DB;
    resetComputeBackendForTest();
    resetComputeRuntimeForTest();
  });

  it("registers the backend at load and the runtime on service start, and tears down on stop", async () => {
    const services: Array<{ id: string; start: () => unknown; stop: () => unknown }> = [];
    const logs: string[] = [];
    const api = {
      config: { compute: {}, tools: {} } as never,
      logger: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(`warn:${m}`),
        error: (m: string) => logs.push(`error:${m}`),
      },
      registerService: (s: { id: string; start: () => unknown; stop: () => unknown }) =>
        services.push(s),
    };
    const { client } = fakeClient({ status });
    const backend = attachComputeAwareness(api, { client, role: "buyer" });
    expect(getComputeBackend()).toBe(backend);
    expect(getComputeRuntime()).toBeNull();
    expect(services.map((s) => s.id)).toEqual(["compute-awareness"]);
    await services[0]!.start();
    const runtime = getComputeRuntime();
    expect(runtime?.watcher).not.toBeNull();
    expect(runtime?.store).toBeDefined();
    expect(logs.some((l) => l.includes("compute awareness active"))).toBe(true);
    await services[0]!.stop();
    expect(getComputeRuntime()).toBeNull();
    expect(getComputeBackend()).toBeNull();
  });

  it("registers the backend but no runtime when compute is disabled", async () => {
    const services: Array<{ id: string; start: () => unknown; stop: () => unknown }> = [];
    const api = {
      config: { compute: { enabled: false }, tools: {} } as never,
      logger: { info() {}, warn() {}, error() {} },
      registerService: (s: { id: string; start: () => unknown; stop: () => unknown }) =>
        services.push(s),
    };
    attachComputeAwareness(api, { client: fakeClient({ status }).client });
    await services[0]!.start();
    expect(getComputeRuntime()).toBeNull();
    expect(getComputeBackend()).not.toBeNull();
    await services[0]!.stop();
  });
});
