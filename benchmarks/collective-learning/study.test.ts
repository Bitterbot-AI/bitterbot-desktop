import { expect, it } from "vitest";
import { analyzeStudy, freezeStudy, planSample, type PairedObservation } from "./study.js";
const manifest = {
  schemaVersion: 1,
  studyId: "fixture",
  model: "fixed",
  toolsHash: "fixed",
  initialLibraryHash: "fixed",
  privateMesh: true,
  publicPublishing: false,
  groupCeiling: { providerUsd: 10, toolCalls: 1000, wallMs: 100000 },
  seed: 42,
  partitions: {
    development: ["dev"],
    acquisition: ["acq"],
    selection: ["select"],
    final: ["final"],
  },
  targetDelta: 0.05,
  power: 0.8,
  confidence: 0.95,
  minimumRetentionHours: 24,
  families: 20,
  tasksPerFamily: 1,
  pilotHash: "a".repeat(64),
  estimatedTotalGroupUsd: 2,
};
it("requires disjoint, funded preregistration", () => {
  expect(freezeStudy(manifest).hash).toHaveLength(64);
  expect(() =>
    freezeStudy({ ...manifest, partitions: { ...manifest.partitions, final: ["acq"] } }),
  ).toThrow("disjoint");
  expect(() => freezeStudy({ ...manifest, estimatedTotalGroupUsd: 11 })).toThrow("feasibility");
});
it("estimates pilot sample needs without claiming efficacy", () => {
  expect(
    planSample(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.5 : -0.5)),
      1,
      0,
    ).feasible,
  ).toBe(false);
  expect(() => planSample([0.1], 1, 100)).toThrow("pilot");
});
it("uses paired family clusters and rejects unknown costs and premature retention", () => {
  const frozen = freezeStudy(manifest);
  const rows: PairedObservation[] = Array.from({ length: 20 }, (_, i) =>
    ["frozen", "local", "exchange", "pooled"].map(
      (condition) =>
        ({
          taskId: `task-${i}`,
          family: `family-${i}`,
          node: "node",
          user: "new-user",
          environment: "fixture",
          condition,
          phase: "final",
          success: condition === "pooled",
          checked: true,
          criticalFailure: false,
          retention: false,
          freshSession: true,
          elapsedHours: 24,
          newUser: true,
          cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
          tokens: 1,
          latencyMs: 1,
          humanUsefulness: null,
          humanRecommendation: null,
        }) as PairedObservation,
    ),
  ).flat();
  const complete = [
    ...rows,
    ...rows.map((r) => ({ ...r, retention: true, newUser: false })),
    ...rows.flatMap((r) =>
      (["acquisition", "selection"] as const).map((phase) => ({ ...r, phase })),
    ),
  ];
  expect(analyzeStudy(complete, frozen.manifest, 500).conclusion).toBe("success");
  expect(
    analyzeStudy(
      rows.map((r, i) => (i ? r : { ...r, cost: null })),
      frozen.manifest,
      500,
    ).conclusion,
  ).not.toBe("success");
  expect(() =>
    analyzeStudy([{ ...rows[0], retention: true, elapsedHours: 23 }], frozen.manifest, 100),
  ).toThrow("24 hours");
});
