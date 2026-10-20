import { describe, expect, it } from "vitest";
import {
  type ComputeQuoteView,
  type ComputeStatusView,
  describeJobs,
  describeQuote,
  describeStatus,
} from "./compute-cli.js";

const view = (over: Partial<ComputeQuoteView> = {}): ComputeQuoteView => ({
  jobId: "j-42",
  quote: {
    amountUsdc: 0.42,
    payee: "0xabc",
    network: "base-sepolia",
    expiresAt: null,
    quoteHash: "q",
  },
  pendingReview: null,
  fundedTx: null,
  paid: { enabled: true, maxUsdcPerJob: 5, maxUsdcPerDay: 20 },
  ...over,
});

describe("bitterbot compute: describeQuote", () => {
  it("states the amount and payee, and names the agent's pending hold", () => {
    const lines = describeQuote(view({ pendingReview: "rv-1" }));
    expect(lines[0]).toBe("Job j-42 is waiting for payment.");
    expect(lines).toContain("  Amount: 0.42 USDC");
    expect(lines).toContain("  Payee: 0xabc (base-sepolia)");
    expect(lines.some((l) => l.includes("rv-1"))).toBe(true);
  });

  it("says when nothing is waiting, when it is already funded, and when approving would be refused", () => {
    expect(describeQuote(view({ quote: null }))).toEqual(["Job j-42 is not waiting for payment."]);
    expect(describeQuote(view({ fundedTx: "0x1" }))[0]).toContain("already funded");
    expect(
      describeQuote(view({ paid: { enabled: false, maxUsdcPerJob: 5, maxUsdcPerDay: 20 } })).at(-1),
    ).toContain("Paid compute is off");
    expect(
      describeQuote(view({ paid: { enabled: true, maxUsdcPerJob: 0.1, maxUsdcPerDay: 20 } })).at(
        -1,
      ),
    ).toContain("per-job cap");
  });
});

describe("bitterbot compute: describeStatus and describeJobs", () => {
  const status: ComputeStatusView = {
    backend: true,
    reachable: true,
    as_of: "2026-10-18T14:00:00.000Z",
    settlement: "base-sepolia",
    credits: { available: 42, reserved: 0, currency: "TEST_CREDIT" },
    pools: [
      {
        id: "lab",
        kind: "private",
        trust: "untrusted",
        configured_trust: "trusted",
        workers_online: 1,
        workers_total: 2,
        gpu_workers_online: 1,
      },
    ],
    workers: [{ id: "w1", online: true, paused: true, gpu: true, model: "nomic" }],
    jobs_in_flight: [{ id: "j1", status: "running", workload: "sha256", items: 3 }],
    paid: { enabled: false, available: true, maxUsdcPerJob: 5, maxUsdcPerDay: 20 },
    runtime: false,
  };

  it("prints pools, workers, jobs and the paid flags one per line", () => {
    const lines = describeStatus(status);
    expect(lines[0]).toContain("Coordinator: reachable");
    expect(lines).toContain(
      "  lab  private, untrusted, configured trusted, 1/2 workers online (1 GPU)",
    );
    expect(lines).toContain("  w1  paused, GPU, model nomic");
    expect(lines.some((l) => l.startsWith("Jobs in flight: j1 (running, sha256 x3)"))).toBe(true);
    expect(lines.some((l) => l.includes("off (compute.paid.enabled)"))).toBe(true);
    expect(lines.at(-1)).toContain("no compute runtime is registered");
    expect(describeStatus({ ...status, backend: false })[0]).toContain("No compute backend");
  });

  it("lists jobs compactly", () => {
    expect(describeJobs([])).toEqual(["No jobs."]);
    expect(
      describeJobs([
        {
          id: "j1",
          status: "succeeded",
          mode: "private",
          scope: "lab",
          workload: "sha256",
          items: 3,
          worker: "w1",
          verification: "recomputed",
          error: null,
          awaiting_usdc: null,
        },
        {
          id: "j2",
          status: "awaiting_payment",
          mode: "paid_usdc",
          scope: null,
          workload: "embeddings",
          items: 8,
          worker: null,
          verification: null,
          error: null,
          awaiting_usdc: 0.5,
        },
      ]),
    ).toEqual([
      "j1  succeeded  private lab  sha256 x3 on w1, recomputed",
      "j2  awaiting_payment  paid_usdc  embeddings x8, awaiting 0.5 USDC",
    ]);
  });
});
