import { beforeEach, describe, expect, it } from "vitest";
import type { ComputeJobSummary, ComputePool, ComputeSnapshot } from "./backend.js";
import {
  DEFAULT_COMPUTE_STATE_MAX_CHARS,
  publishComputeSnapshot,
  pushComputeTransition,
  renderComputeStateBlock,
  resetComputeStateForTest,
  resolveComputeStateBlock,
  resolveComputeStateBlockFromConfig,
  setComputeDeferredCount,
  setComputeInternalJobs,
} from "./state.js";

const NOW = 1_700_000_000_000;

const localPool: ComputePool = {
  id: "local",
  kind: "private",
  trust: "local",
  workersOnline: 1,
  workersTotal: 1,
  gpuWorkersOnline: 1,
};
const labPool: ComputePool = {
  id: "lab",
  kind: "private",
  trust: "trusted",
  workersOnline: 2,
  workersTotal: 3,
  gpuWorkersOnline: 1,
};

function snap(over: Partial<ComputeSnapshot> = {}): ComputeSnapshot {
  return {
    version: 418,
    asOf: NOW - 12_000,
    reachable: true,
    credits: { available: 140, reserved: 0, currency: "TEST_CREDIT" },
    pools: [localPool],
    workers: [],
    jobs: [],
    ...over,
  };
}

function job(over: Partial<ComputeJobSummary> & { id: string }): ComputeJobSummary {
  return {
    status: "running",
    mode: "private",
    scope: "lab",
    workload: "embeddings",
    items: 96,
    attempts: 1,
    ...over,
  };
}

describe("renderComputeStateBlock", () => {
  it("renders nothing at steady state (local pool only, nothing running, nothing new)", () => {
    expect(
      renderComputeStateBlock({ snapshot: snap(), transitions: [], now: NOW }),
    ).toBeUndefined();
  });

  it("renders in-flight jobs with version and age, under budget, in fixed order", () => {
    const r = renderComputeStateBlock({
      snapshot: snap({
        jobs: [
          job({ id: "a81c", worker: "gpu-2" }),
          job({ id: "b2", workload: "sha256", items: 12, status: "queued" }),
        ],
      }),
      transitions: [],
      now: NOW,
    })!;
    expect(r.text.startsWith("<compute-state v=418 as_of=12s_ago>\n")).toBe(true);
    expect(r.text.endsWith("\n</compute-state>")).toBe(true);
    expect(r.text).toContain("pools: local(1/1 online, 1 gpu)");
    expect(r.text).toContain("credits: 140 TEST_CREDIT");
    expect(r.text).toContain("jobs: 1 running (embeddings x96 on gpu-2); 1 queued (sha256 x12)");
    expect(r.text.length).toBeLessThanOrEqual(DEFAULT_COMPUTE_STATE_MAX_CHARS);
    const order = ["pools:", "credits:", "jobs:"].map((p) => r.text.indexOf(p));
    expect(order).toEqual([...order].toSorted((a, b) => a - b));
  });

  it("surfaces jobs that need the owner, with the amount, and never a funding instruction", () => {
    const r = renderComputeStateBlock({
      snapshot: snap({
        jobs: [
          job({
            id: "pay1",
            status: "awaiting_payment",
            mode: "paid_usdc",
            scope: undefined,
            awaitingUsdc: 0.4,
          }),
        ],
      }),
      transitions: [],
      now: NOW,
    })!;
    expect(r.text).toContain("needs owner: pay1 awaiting_payment 0.4 USDC");
    expect(r.text).not.toMatch(/fund it|approve/i);
  });

  it("shows a remote pool change once, then stays quiet", () => {
    const first = renderComputeStateBlock({
      snapshot: snap({ pools: [localPool, labPool] }),
      transitions: [],
      now: NOW,
      lastShownPoolSignature: null,
    })!;
    expect(first.text).toContain("lab(2/3 online, 1 gpu, trusted)");
    const second = renderComputeStateBlock({
      snapshot: snap({ pools: [localPool, labPool] }),
      transitions: [],
      now: NOW,
      lastShownPoolSignature: first.poolSignature,
    });
    expect(second).toBeUndefined();
  });

  it("flags low credits, deferred completions and an unreachable coordinator", () => {
    const r = renderComputeStateBlock({
      snapshot: snap({
        reachable: false,
        credits: { available: 3, reserved: 0, currency: "TEST_CREDIT" },
      }),
      transitions: [],
      deferredCount: 2,
      creditFloor: 10,
      now: NOW,
    })!;
    expect(r.text).toContain("coordinator: unreachable");
    expect(r.text).toContain("credits: 3 TEST_CREDIT (low)");
    expect(r.text).toContain("waiting: 2 completions held until the wake budget resets");
  });

  it("escapes coordinator strings and excludes internal jobs", () => {
    const r = renderComputeStateBlock({
      snapshot: snap({
        pools: [{ ...labPool, id: "<script>alert(1)</script>" }],
        jobs: [job({ id: "int-1" }), job({ id: "<b>x</b>", worker: "w\nnew\nline" })],
      }),
      transitions: [],
      internalJobIds: new Set(["int-1"]),
      now: NOW,
    })!;
    expect(r.text).not.toContain("<script>");
    expect(r.text).not.toContain("<b>");
    expect(r.text).toContain("scriptalert(1)/script");
    expect(r.text).toContain("1 running");
    expect(r.text).not.toContain("2 running");
    expect(r.text.split("\n").some((l) => l.includes("new line") || l.includes("wnew"))).toBe(true);
  });

  it("stays within the character budget under a flood of jobs", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      job({ id: `job-${i}`, worker: `worker-with-a-long-name-${i}` }),
    );
    const r = renderComputeStateBlock({
      snapshot: snap({
        jobs: many,
        pools: [localPool, labPool, { ...labPool, id: "another-pool-with-a-long-name" }],
      }),
      transitions: Array.from({ length: 6 }, (_, i) => ({
        jobId: `done-${i}`,
        status: "succeeded",
        summary: "sha256 x12 on w",
        at: NOW - 1000,
      })),
      now: NOW,
      maxChars: 300,
    })!;
    expect(r.text.length).toBeLessThanOrEqual(300);
    expect(r.text).toContain("<compute-state");
    expect(r.text).toContain("</compute-state>");
  });
});

describe("resolveComputeStateBlock (shared store)", () => {
  beforeEach(() => resetComputeStateForTest());

  it("returns nothing before any snapshot is published", () => {
    expect(resolveComputeStateBlock({})).toBeUndefined();
    expect(resolveComputeStateBlockFromConfig({ compute: { enabled: true } })).toBeUndefined();
  });

  it("shows a transition exactly once", () => {
    publishComputeSnapshot(snap());
    pushComputeTransition({
      jobId: "a81c",
      status: "succeeded",
      summary: "embeddings x96 on gpu-2, recomputed",
      at: NOW - 180_000,
    });
    const first = resolveComputeStateBlock({ now: NOW })!;
    expect(first).toContain("last: a81c succeeded 3m_ago (embeddings x96 on gpu-2, recomputed)");
    expect(resolveComputeStateBlock({ now: NOW })).toBeUndefined();
  });

  it("honours compute.enabled and awareness.stateBlock, and the token budget", () => {
    publishComputeSnapshot(snap({ jobs: [job({ id: "r1" })] }));
    expect(resolveComputeStateBlockFromConfig({ compute: { enabled: false } })).toBeUndefined();
    expect(
      resolveComputeStateBlockFromConfig({ compute: { awareness: { stateBlock: false } } }),
    ).toBeUndefined();
    const text = resolveComputeStateBlockFromConfig(
      { compute: { awareness: { maxTokens: 40 } } },
      NOW,
    )!;
    expect(text.length).toBeLessThanOrEqual(160);
  });

  it("excludes internal jobs and counts deferred completions", () => {
    publishComputeSnapshot(snap({ jobs: [job({ id: "internal-1" })] }));
    setComputeInternalJobs(["internal-1"]);
    expect(resolveComputeStateBlock({ now: NOW })).toBeUndefined();
    setComputeDeferredCount(1);
    expect(resolveComputeStateBlock({ now: NOW })).toContain("waiting: 1 completion held");
  });
});
