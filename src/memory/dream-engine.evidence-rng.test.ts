import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { DreamEngine } from "./dream-engine.js";
import { DEFAULT_MODE_CONFIGS, type DreamMode, type DreamModeConfig } from "./dream-types.js";
import { EvidenceTelemetry } from "./evidence-telemetry.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("shadow must not advance live RNG when the counterfactual needs an extra draw", () => {
  vi.stubEnv("BITTERBOT_DREAM_TASK_BIAS", "0");
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  const modes = Object.fromEntries(
    Object.entries(DEFAULT_MODE_CONFIGS).map(([name, cfg]) => [
      name,
      {
        ...cfg,
        enabled: ["replay", "simulation", "hygiene"].includes(name),
        weight: 0.5,
      },
    ]),
  ) as Record<DreamMode, DreamModeConfig>;
  const make = (shadow: boolean) => {
    const e = new DreamEngine(
      db,
      { modes, disableFsho: true, llmCall: async () => "[]" },
      async () => ({ summary: "", sections: {} }) as never,
      async (xs) => xs.map(() => []),
    );
    if (shadow)
      e.setEvidenceTelemetry(
        new EvidenceTelemetry(db, { mode: "shadow" }, { debug() {}, warn() {} }),
      );
    const internal = e as unknown as {
      lastModeUsed: DreamMode;
      computeGCCRFModeAdjustments(): object;
      selectModes(): DreamMode[];
    };
    internal.lastModeUsed = "simulation";
    vi.spyOn(internal, "computeGCCRFModeAdjustments").mockReturnValue({
      replay: 1,
      simulation: -1,
    });
    return internal;
  };
  const legacy = make(false),
    shadow = make(true);
  const sequence = [0.6, 0.2, 0.8, 0.4];
  let n = 0;
  vi.spyOn(Math, "random").mockImplementation(() => sequence[n++ % sequence.length]!);
  const baseline = legacy.selectModes();
  const baselineDraws = n;
  n = 0;
  const shadowed = shadow.selectModes();
  const shadowDraws = n;
  db.close();
  expect(shadowed).toEqual(baseline);
  expect(shadowDraws).toBe(baselineDraws);
});
