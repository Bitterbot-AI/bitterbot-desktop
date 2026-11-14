import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { writeNewJson, type DeploymentSpec } from "./deployment-contract.js";
import { DeploymentStudyDriver } from "./deployment-driver.js";
import {
  exportBlindReview,
  importHumanRatings,
  observationsWithRatings,
  exportDeployment,
} from "./deployment-report.js";
import { createPilotCorpus } from "./pilot-corpus.js";
import type { PairedObservation } from "./study.js";

it("blinds reviews and keeps human ratings separate from authoritative task outcomes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-study-review-"));
  if (
    path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith("bb-study-review-")
  )
    throw new Error("Unsafe test cleanup root");
  const corpus = createPilotCorpus();
  const spec: DeploymentSpec = {
    schemaVersion: 1,
    id: "review-fixture",
    purpose: "development-pilot",
    baseConfig: "unused",
    authAgentDirectory: "unused",
    model: "private/model",
    sandboxImage: "unused",
    initialPackageDirectory: "unused",
    corpusFile: path.join(root, "corpus.json"),
    seed: 1,
    conditions: ["frozen", "local", "exchange", "pooled"],
    groupCeiling: { providerUsd: 100, toolCalls: 1000, wallMs: 10000 },
    maxCanaryBatches: 5,
    retentionHours: 24,
  };
  await writeNewJson(path.join(root, "deployment.json"), spec);
  await writeNewJson(spec.corpusFile, corpus);
  const driver = await DeploymentStudyDriver.open(root, () => {}, false);
  try {
    const task = corpus.tasks.find((t) => t.partition === "final")!;
    const row: PairedObservation = {
      taskId: task.id,
      family: task.family,
      node: task.node,
      user: task.user,
      environment: task.environment,
      condition: "pooled",
      phase: "final",
      success: false,
      checked: true,
      criticalFailure: false,
      retention: false,
      freshSession: true,
      elapsedHours: 0,
      newUser: false,
      cost: { providerUsd: 1, toolCalls: 1, wallMs: 1 },
      tokens: 10,
      latencyMs: 1,
      humanUsefulness: null,
      humanRecommendation: null,
    };
    driver.ledger.reserve({
      id: "execution",
      condition: "pooled",
      node: task.node,
      phase: "final",
      quote: row.cost,
    });
    driver.ledger.finish("execution", row, {
      brief: { recommendation: "Collect more evidence" },
      markdown: "# Brief",
      packageHash: "private-package",
    });
    const bundlePath = path.join(root, "blind.json");
    expect(await exportBlindReview(driver, bundlePath)).toBe(1);
    const text = await fs.readFile(bundlePath, "utf8");
    expect(text).not.toContain("pooled");
    expect(text).not.toContain("private-package");
    expect(text).not.toContain('"success"');
    expect(text).not.toContain('"cost"');
    const bundle = JSON.parse(text) as { items: Array<{ reviewId: string }> };
    const ratingsPath = path.join(root, "ratings.json");
    await writeNewJson(ratingsPath, {
      raterId: "human-one",
      items: [{ reviewId: bundle.items[0].reviewId, usefulness: 4, recommendation: 3 }],
    });
    expect(await importHumanRatings(driver, ratingsPath)).toMatchObject([
      { success: false, humanUsefulness: 4, humanRecommendation: 3 },
    ]);
    await fs.writeFile(
      path.join(root, "rated-observations.json"),
      JSON.stringify([{ ...row, success: true }]),
    );
    expect(observationsWithRatings(driver)[0].success).toBe(false);
    await fs.writeFile(
      ratingsPath,
      JSON.stringify({
        raterId: "human-one",
        items: [{ reviewId: bundle.items[0].reviewId, usefulness: 5, recommendation: 5 }],
      }),
    );
    await expect(importHumanRatings(driver, ratingsPath)).rejects.toThrow("silently replaced");
    await fs.writeFile(
      ratingsPath,
      JSON.stringify({
        raterId: "human-two",
        items: [
          { reviewId: bundle.items[0].reviewId, usefulness: 2, recommendation: 2 },
          { reviewId: "0".repeat(64), usefulness: 5, recommendation: 5 },
        ],
      }),
    );
    await expect(importHumanRatings(driver, ratingsPath)).rejects.toThrow("Unknown");
    expect(
      driver.db
        .prepare("SELECT COUNT(*) AS n FROM study_human_ratings WHERE rater='human-two'")
        .get()?.n,
    ).toBe(0);
    driver.ledger.reserve({
      id: "unresolved",
      condition: "pooled",
      node: task.node,
      phase: "final",
      quote: { providerUsd: 7, toolCalls: 20, wallMs: 100 },
    });
    expect(await exportDeployment(driver)).toMatchObject({
      unknownOrReservedCosts: 1,
      conditions: {
        pooled: { dollars: null, knownDollars: 1, reservedDollars: 7, unknownCosts: 1 },
      },
    });
  } finally {
    await driver.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
