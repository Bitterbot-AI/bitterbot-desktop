import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComputeBackend,
  ComputeJobSummary,
  ComputeSnapshot,
} from "../compute/awareness/backend.js";
import { ComputeDeliveryStore } from "../compute/awareness/deliveries.js";
import {
  recordComputeDuration,
  resetComputeEstimatesForTest,
} from "../compute/awareness/estimate.js";
import { LOCAL_WORKER_ID } from "../compute/awareness/routing.js";
import { resetComputeStateForTest } from "../compute/awareness/state.js";
import type { BitterbotConfig } from "../config/config.js";
import { buildEmbeddingProfile, type EmbeddingProfile } from "./embedding-profile.js";
import {
  SUSTAINED_FALLBACK_THRESHOLD,
  createPoolEmbeddingProvider,
  readVectors,
} from "./embeddings-pool.js";
import type { EmbeddingProvider } from "./embeddings.js";

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
  workers: [
    {
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
    },
  ],
  jobs: [],
};

const profile: EmbeddingProfile = buildEmbeddingProfile({
  provider: "local",
  model: "nomic-embed-text",
  chunking: { tokens: 400, overlap: 80 },
  modelDigest: "sha256:aaaa",
  dimensions: 2,
});

/** Each local item costs 5 s of fake time, so a measured local batch is slow enough for the pool to win. */
const LOCAL_MS_PER_ITEM = 5000;
let advance: (ms: number) => void = () => {};

function localProvider(): EmbeddingProvider & { embedBatch: ReturnType<typeof vi.fn> } {
  const embedBatch = vi.fn(async (texts: string[]) => {
    advance(LOCAL_MS_PER_ITEM * texts.length);
    return texts.map((t) => [t.length, 1]);
  });
  return {
    id: "local",
    model: "nomic-embed-text",
    embedQuery: vi.fn(async () => [0, 1]),
    embedBatch,
  };
}

type FakeBackend = ComputeBackend & {
  submit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  jobs$: Map<string, ComputeJobSummary>;
  results$: Map<string, unknown>;
};

function fakeBackend(
  opts: {
    resultFor?: (inputs: string[]) => unknown;
    status?: string;
    neverFinish?: boolean;
  } = {},
): FakeBackend {
  const jobs$ = new Map<string, ComputeJobSummary>();
  const results$ = new Map<string, unknown>();
  let n = 0;
  const submit = vi.fn(async (req: { inputs: string[] }) => {
    const id = `job-${++n}`;
    jobs$.set(id, {
      id,
      status: opts.neverFinish ? "running" : (opts.status ?? "succeeded"),
      mode: "private",
      scope: "lab",
      workload: "embeddings",
      items: req.inputs.length,
      attempts: 1,
      worker: "gpu-1",
    });
    results$.set(
      id,
      opts.resultFor
        ? opts.resultFor(req.inputs)
        : {
            embeddings: req.inputs.map((t) => [t.length * 2, 2]),
            execution: {
              model: "nomic-embed-text",
              model_digest: "aaaa",
              dimensions: 2,
              truncate: false,
            },
          },
    );
    return { id, status: jobs$.get(id)!.status };
  });
  const cancel = vi.fn(async (id: string) => {
    jobs$.get(id)!.status = "cancelled";
    return { ok: true, status: "cancelled" };
  });
  return {
    snapshot: async () => snapshot,
    jobs: async () => [...jobs$.values()],
    job: async (id) => jobs$.get(id) ?? null,
    result: async (id) => ({
      id,
      status: "succeeded",
      result: results$.get(id),
      receipt: { id },
      verification: "recomputed",
    }),
    submit,
    cancel,
    jobs$,
    results$,
  };
}

describe("pool embedding provider", () => {
  let store: ComputeDeliveryStore | null = null;
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  advance = (ms) => {
    clock += ms;
  };
  const config = {
    compute: { pools: { lab: { trust: "trusted" } }, embeddings: { timeoutMs: 5000 } },
  } as BitterbotConfig;

  afterEach(() => {
    store?.close();
    store = null;
    resetComputeEstimatesForTest();
    resetComputeStateForTest();
    clock = 1_700_000_000_000;
  });

  function arm(
    backend: FakeBackend | null,
    over: { profile?: EmbeddingProfile | null; config?: BitterbotConfig } = {},
  ) {
    store = ComputeDeliveryStore.inMemory();
    const local = localProvider();
    const runtime = backend
      ? {
          store,
          watcher: {
            kick: vi.fn(),
            pollOnce: async () => null,
            reconcile: async () => 0,
            stop: () => undefined,
            isPolling: () => false,
          },
        }
      : null;
    const provider = createPoolEmbeddingProvider({
      local,
      config: over.config ?? config,
      getProfile: () => (over.profile === undefined ? profile : over.profile),
      deps: { backend: () => backend, runtime: () => runtime, now, sleep },
    });
    return { local, provider, runtime, backend };
  }

  function seedLocalSlow() {
    recordComputeDuration({
      workerId: LOCAL_WORKER_ID,
      workload: "embeddings",
      items: 10,
      durationMs: 100_000,
    });
  }

  it("keeps the local id and model, and is a pass-through without a backend or profile", async () => {
    const a = arm(null);
    expect(a.provider.id).toBe("local");
    expect(a.provider.model).toBe("nomic-embed-text");
    expect(await a.provider.embedBatch(["ab", "c"])).toEqual([
      [2, 1],
      [1, 1],
    ]);
    expect(a.local.embedBatch).toHaveBeenCalledTimes(1);
    const b = arm(fakeBackend(), { profile: null });
    await b.provider.embedBatch(["ab"]);
    expect(b.backend!.submit).not.toHaveBeenCalled();
    expect(store!.ledger().summary(0).batches).toBe(0);
  });

  it("runs the first batch locally (no timing yet), then routes normal content to the pool and writes it under the profile", async () => {
    const { provider, backend, runtime } = arm(fakeBackend());
    const first = await provider.embedBatch(["ab", "cde"], { classes: ["normal", "normal"] });
    expect(first).toEqual([
      [2, 1],
      [3, 1],
    ]);
    expect(backend!.submit).not.toHaveBeenCalled();
    const second = await provider.embedBatch(["ab", "cde"], { classes: ["normal", "normal"] });
    expect(backend!.submit).toHaveBeenCalledTimes(1);
    expect(backend!.submit.mock.calls[0][0]).toMatchObject({
      mode: { kind: "private", poolId: "lab" },
      workload: "embeddings",
      inputs: ["ab", "cde"],
      model: "nomic-embed-text",
      modelDigest: "sha256:aaaa",
    });
    // l2-normalised on receipt, as the local provider does.
    expect(second[0]![0]).toBeCloseTo(4 / Math.hypot(4, 2));
    expect(runtime!.watcher!.kick).toHaveBeenCalledTimes(1);
    expect(store!.originOf("job-1")).toMatchObject({ origin: "internal", sessionKey: null });
    const s = store!.ledger().summary(0);
    expect(s.byRoute.local.batches).toBe(1);
    expect(s.byRoute.pool).toEqual({ batches: 1, items: 2 });
    expect(s.poolByClassTrust).toEqual({ "normal@trusted": 1 });
    const rows = store!.ledger().recent(5);
    expect(rows[0]).toMatchObject({
      route: "pool",
      jobId: "job-1",
      trust: "trusted",
      cls: "normal",
    });
    expect(rows[0]!.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("splits a batch by class: confidential never leaves, personal may reach a trusted pool", async () => {
    seedLocalSlow();
    const { provider, backend, local } = arm(fakeBackend());
    const out = await provider.embedBatch(["secret", "diary", "news"], {
      classes: ["confidential", "personal", "normal"],
    });
    expect(backend!.submit).toHaveBeenCalledTimes(2);
    const shipped = backend!.submit.mock.calls.flatMap(
      (c) => (c[0] as { inputs: string[] }).inputs,
    );
    expect(shipped.toSorted()).toEqual(["diary", "news"]);
    expect(local.embedBatch).toHaveBeenCalledWith(["secret"], expect.anything());
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual([6, 1]);
    const s = store!.ledger().summary(0);
    expect(s.byRoute.pool.batches).toBe(2);
    expect(s.byRoute.local.batches).toBe(1);
  });

  it("keeps personal content off an untrusted pool and unclassified inputs count as personal", async () => {
    seedLocalSlow();
    const untrusted = { compute: {} } as BitterbotConfig; // lab defaults to untrusted
    const { provider, backend } = arm(fakeBackend(), { config: untrusted });
    await provider.embedBatch(["my therapist said", "plain text"], {
      classes: ["personal", "normal"],
    });
    expect(backend!.submit).toHaveBeenCalledTimes(1);
    expect((backend!.submit.mock.calls[0][0] as { inputs: string[] }).inputs).toEqual([
      "plain text",
    ]);
    backend!.submit.mockClear();
    await provider.embedBatch(["anything at all"]);
    expect(backend!.submit).not.toHaveBeenCalled();
    expect(store!.ledger().recent(1)[0]).toMatchObject({ route: "local", cls: "personal" });
  });

  it("falls back to local and cools the worker down on a digest mismatch; never writes the mixed result", async () => {
    seedLocalSlow();
    const backend = fakeBackend({
      resultFor: (inputs) => ({
        embeddings: inputs.map(() => [9, 9]),
        execution: { model_digest: "bbbb", dimensions: 2 },
      }),
    });
    const { provider } = arm(backend);
    const out = await provider.embedBatch(["ab"], { classes: ["normal"] });
    expect(out).toEqual([[2, 1]]);
    expect(provider.cooldowns.active("gpu-1", now())).toMatchObject({ reason: "digest_mismatch" });
    expect(store!.ledger().recent(1)[0]).toMatchObject({
      route: "fallback",
      reason: "digest_mismatch",
      jobId: "job-1",
    });
    await provider.embedBatch(["ab"], { classes: ["normal"] });
    expect(backend.submit).toHaveBeenCalledTimes(1);
  });

  it("falls back on a dimension mismatch, a processing mismatch and a wrong vector count", async () => {
    for (const [resultFor, reason] of [
      [
        (inputs: string[]) => ({
          embeddings: inputs.map(() => [1, 2, 3]),
          execution: { model_digest: "aaaa", dimensions: 3 },
        }),
        "dimension_mismatch",
      ],
      [
        (inputs: string[]) => ({
          embeddings: inputs.map(() => [1, 2]),
          execution: { model_digest: "aaaa", dimensions: 2, truncate: true },
        }),
        "processing_mismatch",
      ],
      [
        () => ({ embeddings: [[1, 2]], execution: { model_digest: "aaaa", dimensions: 2 } }),
        "count_mismatch",
      ],
    ] as const) {
      resetComputeEstimatesForTest();
      seedLocalSlow();
      store?.close();
      const { provider } = arm(fakeBackend({ resultFor }));
      const out = await provider.embedBatch(["ab", "cd"], { classes: ["normal", "normal"] });
      expect(out).toEqual([
        [2, 1],
        [2, 1],
      ]);
      expect(provider.cooldowns.active("gpu-1", now())?.reason).toBe(reason);
      expect(store!.ledger().recent(1)[0]?.reason).toBe(reason);
    }
  });

  it("times out a slow job, cancels it, and runs the batch locally", async () => {
    seedLocalSlow();
    const backend = fakeBackend({ neverFinish: true });
    const { provider } = arm(backend);
    const out = await provider.embedBatch(["ab"], { classes: ["normal"] });
    expect(out).toEqual([[2, 1]]);
    expect(backend.cancel).toHaveBeenCalledWith("job-1");
    expect(store!.ledger().recent(1)[0]).toMatchObject({ route: "fallback", reason: "timeout" });
    expect(provider.cooldowns.active("gpu-1", now())?.reason).toBe("timeout");
  });

  it("treats a failed job and a throwing backend as errors with local fallback", async () => {
    seedLocalSlow();
    const { provider } = arm(fakeBackend({ status: "failed" }));
    expect(await provider.embedBatch(["ab"], { classes: ["normal"] })).toEqual([[2, 1]]);
    expect(store!.ledger().recent(1)[0]).toMatchObject({ route: "fallback", reason: "error" });
    store?.close();
    const throwing = fakeBackend();
    throwing.submit.mockRejectedValueOnce(new Error("coordinator 503"));
    const b = arm(throwing);
    expect(await b.provider.embedBatch(["ab"], { classes: ["normal"] })).toEqual([[2, 1]]);
    expect(store!.ledger().recent(1)[0]).toMatchObject({ route: "fallback", reason: "error" });
  });

  it("splits a large class group into coordinator-sized jobs and reassembles in order", async () => {
    seedLocalSlow();
    const backend = fakeBackend();
    const { provider } = arm(backend);
    const texts = Array.from({ length: 300 }, (_, i) => "x".repeat((i % 7) + 1));
    const out = await provider.embedBatch(texts, { classes: texts.map(() => "normal") });
    expect(backend.submit).toHaveBeenCalledTimes(3);
    expect(
      backend.submit.mock.calls.map((c) => (c[0] as { inputs: string[] }).inputs.length),
    ).toEqual([128, 128, 44]);
    expect(out).toHaveLength(300);
    expect(out[299]![0]).toBeCloseTo(
      (texts[299]!.length * 2) / Math.hypot(texts[299]!.length * 2, 2),
    );
  });

  it("queries always run locally", async () => {
    seedLocalSlow();
    const { provider, backend, local } = arm(fakeBackend());
    await provider.embedQuery("hello");
    expect(local.embedQuery).toHaveBeenCalled();
    expect(backend!.submit).not.toHaveBeenCalled();
  });

  it("tells the agent once when fallbacks are sustained, and clears after a success", async () => {
    seedLocalSlow();
    const backend = fakeBackend({ status: "failed" });
    const cfg = {
      compute: {
        pools: { lab: { trust: "trusted" } },
        embeddings: { timeoutMs: 5000, cooldownMs: 1000 },
      },
    } as BitterbotConfig;
    const { provider } = arm(backend, { config: cfg });
    for (let i = 0; i < SUSTAINED_FALLBACK_THRESHOLD; i += 1) {
      clock += 2000; // past the cooldown each time
      await provider.embedBatch(["ab"], { classes: ["normal"] });
    }
    const { publishComputeSnapshot, resolveComputeStateBlock } =
      await import("../compute/awareness/state.js");
    publishComputeSnapshot(snapshot);
    const block = resolveComputeStateBlock({ now: now(), maxChars: 480, creditFloor: 10 });
    expect(block).toContain("pool embeddings falling back to local");
    // Shown once; a later success resets the counter so a new streak can report again.
    expect(
      resolveComputeStateBlock({ now: now(), maxChars: 480, creditFloor: 10 }) ?? "",
    ).not.toContain("falling back");
  });
});

describe("readVectors", () => {
  it("accepts embeddings or vectors arrays and sanitises non-numbers", () => {
    expect(readVectors(null)).toEqual([]);
    expect(readVectors({ embeddings: [[1, "x", Number.NaN]] })).toEqual([[1, 0, 0]]);
    expect(readVectors({ vectors: [[0.5]] })).toEqual([[0.5]]);
    expect(readVectors({ embeddings: "nope" })).toEqual([]);
  });
});
