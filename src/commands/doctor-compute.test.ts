import { describe, expect, it } from "vitest";
import { ComputeDeliveryStore } from "../compute/awareness/deliveries.js";
import type { BitterbotConfig } from "../config/config.js";
import { collectComputeEmbeddingResults, summarise } from "./doctor-compute.js";

function summaryOf(
  rows: Array<Partial<Parameters<ReturnType<ComputeDeliveryStore["ledger"]>["record"]>[0]>>,
) {
  const store = ComputeDeliveryStore.inMemory();
  try {
    for (const r of rows) {
      store.ledger().record({
        ts: 1000,
        route: "local",
        poolId: null,
        workerId: null,
        trust: null,
        cls: "normal",
        items: 1,
        profileKey: "p",
        jobId: null,
        durationMs: 100,
        reason: null,
        receiptHash: null,
        ...r,
      });
    }
    return store.ledger().summary(0);
  } finally {
    store.close();
  }
}

describe("doctor: compute embeddings", () => {
  it("is quiet when compute is off, local-only, or has no ledger", () => {
    expect(
      collectComputeEmbeddingResults({ compute: { enabled: false } } as BitterbotConfig)[0],
    ).toMatchObject({ level: "info" });
    expect(
      collectComputeEmbeddingResults({
        compute: { embeddings: { provider: "local" } },
      } as BitterbotConfig)[0],
    ).toMatchObject({ level: "info" });
    expect(
      collectComputeEmbeddingResults({} as BitterbotConfig, { dbPath: "/nonexistent/x.sqlite" })[0]
        ?.message,
    ).toContain("No compute ledger yet");
    expect(summarise(summaryOf([]))[0]?.message).toContain("No embedding batches");
  });

  it("reports totals, flags policy violations as errors and mismatches as warnings", () => {
    const results = summarise(
      summaryOf([
        { route: "pool", poolId: "lab", workerId: "gpu-1", trust: "trusted", items: 40 },
        {
          route: "fallback",
          poolId: "lab",
          workerId: "gpu-1",
          trust: "trusted",
          reason: "digest_mismatch",
        },
        {
          route: "fallback",
          poolId: "lab",
          workerId: "gpu-1",
          trust: "trusted",
          reason: "policy_violation",
          cls: "personal",
        },
        { route: "local", items: 3 },
      ]),
    );
    expect(results[0]).toMatchObject({ level: "ok" });
    expect(results[0]!.message).toContain("4 batches, 45 items");
    expect(results.find((r) => r.level === "error")?.message).toContain("policy violation");
    expect(results.find((r) => r.message.includes("digest mismatch"))?.level).toBe("warn");
    expect(results.find((r) => r.message.includes("fell back to local"))?.level).toBe("warn");
  });
});
