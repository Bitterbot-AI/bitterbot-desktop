import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EvidenceTelemetry } from "./evidence-telemetry.js";
import { MemoryIndexManager } from "./manager.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

let db: DatabaseSync;
let telemetry: EvidenceTelemetry | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
});
afterEach(async () => {
  await telemetry?.stopMaintenance();
  telemetry = undefined;
  db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([{ enabled: false }, { intervalMinutes: 0 }])(
  "prunes old evidence with consolidation %j and collection off",
  async (consolidation) => {
    const writer = new EvidenceTelemetry(db, { mode: "observe" });
    writer.recordSurfacing({
      eventId: "expired",
      kind: "proactive_recall",
      stage: "delivered",
      now: Date.now() - 91 * 86_400_000,
    });
    writer.recordSurfacing({ eventId: "current", kind: "proactive_recall", stage: "delivered" });
    const manager = Object.assign(Object.create(MemoryIndexManager.prototype), {
      db,
      cfg: { memory: { consolidation, curiosity: { enabled: false, evidence: { mode: "off" } } } },
    }) as MemoryIndexManager;
    const internal = manager as unknown as {
      ensureConsolidationInterval(): void;
      ensureCuriosityEngine(): void;
    };
    internal.ensureConsolidationInterval();
    internal.ensureCuriosityEngine();
    telemetry = manager.getEvidenceTelemetry()!;
    expect(telemetry.isEnabled()).toBe(false);
    await telemetry.stopMaintenance();
    expect(db.prepare("SELECT event_id FROM surfacing_events").all()).toEqual([
      { event_id: "current" },
    ]);
  },
);

it("periodic maintenance expires new rows and stops cleanly", async () => {
  telemetry = new EvidenceTelemetry(db, { mode: "observe", retentionDays: 1 });
  telemetry.startMaintenance();
  await telemetry.stopMaintenance();
  telemetry.startMaintenance();
  telemetry.recordSurfacing({ eventId: "later", kind: "proactive_recall", stage: "delivered" });
  await vi.advanceTimersByTimeAsync(2 * 86_400_000);
  await telemetry.stopMaintenance();
  expect(telemetry.stats().surfacingEvents).toBe(0);
  const stopped = vi.spyOn(telemetry, "prune");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(stopped).not.toHaveBeenCalled();
});

it("does not overlap pruning and drains it before shutdown", async () => {
  telemetry = new EvidenceTelemetry(db, { mode: "observe" });
  let finish: (value: {
    retrievalHits: number;
    surfacingEvents: number;
    decisionTraces: number;
  }) => void = () => {};
  const pending = new Promise<{
    retrievalHits: number;
    surfacingEvents: number;
    decisionTraces: number;
  }>((resolve) => {
    finish = resolve;
  });
  const prune = vi.spyOn(telemetry, "prune").mockReturnValue(pending);
  telemetry.startMaintenance();
  telemetry.startMaintenance();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(prune).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = telemetry.stopMaintenance().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish({ retrievalHits: 0, surfacingEvents: 0, decisionTraces: 0 });
  await stopping;
  expect(stopped).toBe(true);
});
