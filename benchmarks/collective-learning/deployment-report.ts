import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256, learningHash } from "../../src/agents/skills/collective/contracts.js";
import { readJson, validateCorpus, writeNewJson } from "./deployment-contract.js";
import type { DeploymentStudyDriver } from "./deployment-driver.js";
import {
  CONDITIONS,
  analyzeStudy,
  freezeStudy,
  ObservationSchema,
  type PairedObservation,
} from "./study.js";

export async function exportDeployment(driver: DeploymentStudyDriver): Promise<unknown> {
  const rows = driver.ledger.observations();
  const pending = driver.db
    .prepare("SELECT condition,body FROM study_charges WHERE state!='settled'")
    .all() as { condition: string; body: string }[];
  const diagnostics = (
    driver.db
      .prepare("SELECT observation,artifact FROM study_charges WHERE observation IS NOT NULL")
      .all() as { observation: string; artifact: string }[]
  ).flatMap((entry) => {
    const artifact = JSON.parse(entry.artifact) as {
      diagnostic?: { kind: string; message: string } | null;
    };
    if (!artifact.diagnostic) return [];
    const row = ObservationSchema.parse(JSON.parse(entry.observation));
    return [
      { condition: row.condition, node: row.node, taskId: row.taskId, ...artifact.diagnostic },
    ];
  });
  const report = {
    deploymentHash: driver.frozen?.hash ?? null,
    purpose: driver.spec.purpose,
    generatedAt: new Date().toISOString(),
    conclusion: "development-feasibility-only",
    efficacyClaim: false,
    unknownOrReservedCosts: driver.ledger.unresolved(),
    diagnostics,
    conditions: Object.fromEntries(
      CONDITIONS.map((condition) => {
        const selected = rows.filter((r) => r.condition === condition);
        const final = selected.filter((r) => r.phase === "final" && !r.retention);
        const unresolved = pending.filter((r) => r.condition === condition);
        const knownDollars = selected.reduce((s, r) => s + (r.cost?.providerUsd ?? 0), 0);
        return [
          condition,
          {
            executions: selected.length,
            checkedFinal: final.filter((r) => r.checked).length,
            successfulFinal: final.filter((r) => r.success === true).length,
            retentionRuns: selected.filter((r) => r.retention).length,
            tokens: selected.reduce((s, r) => s + r.tokens, 0),
            dollars: unresolved.length ? null : knownDollars,
            knownDollars,
            reservedDollars: unresolved.reduce(
              (sum, r) =>
                sum + (JSON.parse(r.body) as { quote: { providerUsd: number } }).quote.providerUsd,
              0,
            ),
            wallMs: selected.reduce((s, r) => s + r.latencyMs, 0),
            unknownCosts: unresolved.length,
          },
        ];
      }),
    ),
    completedCommands: driver.db
      .prepare("SELECT id,state,result FROM study_commands ORDER BY rowid")
      .all(),
  };
  await fs.writeFile(
    path.join(driver.root, "observations.json"),
    JSON.stringify(rows, null, 2) + "\n",
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(driver.root, "pilot-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  return report;
}

/** Review bundles contain no condition, model, package hash, automated verdict or cost. */
export async function exportBlindReview(
  driver: DeploymentStudyDriver,
  destination: string,
): Promise<number> {
  const corpus = validateCorpus(await readJson(path.join(driver.root, "corpus.json")));
  const keyFile = path.join(driver.root, "review-key");
  let key: string;
  try {
    key = await fs.readFile(keyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = randomBytes(32).toString("hex");
    await fs.writeFile(keyFile, key, { flag: "wx", mode: 0o600 });
  }
  const artifacts = driver.db
    .prepare("SELECT id,observation,artifact FROM study_charges WHERE observation IS NOT NULL")
    .all() as { id: string; observation: string; artifact: string }[];
  const mapping: Record<string, string> = {};
  const review = artifacts
    .flatMap((row) => {
      const observation = ObservationSchema.parse(JSON.parse(row.observation));
      if (observation.phase !== "final") return [];
      const artifact = JSON.parse(row.artifact) as { brief: unknown; markdown: string | null };
      const task = corpus.tasks.find(
        (t) => t.id === observation.taskId && t.node === observation.node,
      );
      if (!task) throw new Error("Final artifact has no frozen task");
      const reviewId = sha256(`${key}:${row.id}`);
      mapping[reviewId] = row.id;
      return [
        {
          reviewId,
          sourceMaterial: task.input,
          brief: artifact.brief,
          markdown: artifact.markdown,
          usefulness: null,
          recommendation: null,
          comments: "",
        },
      ];
    })
    .toSorted((a, b) => a.reviewId.localeCompare(b.reviewId));
  await writeNewJson(destination, {
    schemaVersion: 1,
    rubric: {
      usefulness:
        "1-5: usefulness for the stated research question, considering omissions and uncertainty",
      recommendation:
        "1-5: evidence-supported, actionable recommendation and follow-up; score separately from factual correctness",
    },
    items: review,
  });
  await fs.writeFile(path.join(driver.root, "review-map.json"), JSON.stringify(mapping, null, 2), {
    mode: 0o600,
  });
  return review.length;
}
export async function importHumanRatings(
  driver: DeploymentStudyDriver,
  file: string,
): Promise<PairedObservation[]> {
  const input = z
    .object({
      raterId: z.string().min(1).max(100),
      items: z
        .array(
          z
            .object({
              reviewId: z.string().regex(/^[a-f0-9]{64}$/),
              usefulness: z.number().int().min(1).max(5),
              recommendation: z.number().int().min(1).max(5),
              comments: z.string().max(4000).optional(),
            })
            .strict(),
        )
        .max(10000),
    })
    .strict()
    .parse(await readJson(file));
  const mapping = (await readJson(path.join(driver.root, "review-map.json"))) as Record<
    string,
    string
  >;
  const seen = new Set<string>();
  driver.db.exec(
    "CREATE TABLE IF NOT EXISTS study_human_ratings(rater TEXT NOT NULL,charge TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(rater,charge))",
  );
  for (const item of input.items) {
    const charge = mapping[item.reviewId];
    if (!charge || seen.has(charge)) throw new Error("Unknown or duplicate blind rating identity");
    seen.add(charge);
    const prior = driver.db
      .prepare("SELECT body FROM study_human_ratings WHERE rater=? AND charge=?")
      .get(input.raterId, charge) as { body: string } | undefined;
    if (prior && learningHash(JSON.parse(prior.body)) !== learningHash(item))
      throw new Error("A submitted human rating cannot be silently replaced");
  }
  driver.db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of input.items)
      driver.db
        .prepare("INSERT OR IGNORE INTO study_human_ratings VALUES (?,?,?)")
        .run(input.raterId, mapping[item.reviewId], JSON.stringify(item));
    driver.db.exec("COMMIT");
  } catch (error) {
    driver.db.exec("ROLLBACK");
    throw error;
  }
  const rows = observationsWithRatings(driver);
  await fs.writeFile(
    path.join(driver.root, "rated-observations.json"),
    JSON.stringify(rows, null, 2) + "\n",
    { mode: 0o600 },
  );
  return rows;
}

export function observationsWithRatings(driver: DeploymentStudyDriver): PairedObservation[] {
  driver.db.exec(
    "CREATE TABLE IF NOT EXISTS study_human_ratings(rater TEXT NOT NULL,charge TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(rater,charge))",
  );
  const observations = driver.db
    .prepare(
      "SELECT id,observation FROM study_charges WHERE observation IS NOT NULL ORDER BY rowid",
    )
    .all() as { id: string; observation: string }[];
  return observations.map((row) => {
    const observation = ObservationSchema.parse(JSON.parse(row.observation));
    const ratings = (
      driver.db.prepare("SELECT body FROM study_human_ratings WHERE charge=?").all(row.id) as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body) as { usefulness: number; recommendation: number });
    return ratings.length
      ? {
          ...observation,
          humanUsefulness: ratings.reduce((s, r) => s + r.usefulness, 0) / ratings.length,
          humanRecommendation: ratings.reduce((s, r) => s + r.recommendation, 0) / ratings.length,
        }
      : observation;
  });
}

export async function analyzeDeployment(
  driver: DeploymentStudyDriver,
  frozenStudyFile: string,
): Promise<unknown> {
  if (driver.spec.purpose !== "efficacy-study")
    throw new Error("Development pilot cannot make an efficacy claim");
  const frozen = (await readJson(frozenStudyFile)) as ReturnType<typeof freezeStudy>;
  if (
    freezeStudy(frozen.manifest).hash !== frozen.hash ||
    driver.db.prepare("SELECT value FROM study_meta WHERE key='study-manifest'").get()?.value !==
      frozen.hash
  )
    throw new Error("Study was not bound to this manifest before acquisition");
  // Exported JSON is editable. Outcome authority remains the host ledger; only human
  // rating fields are joined from separately recorded, immutable submissions.
  const rows = observationsWithRatings(driver);
  const corpus = validateCorpus(await readJson(path.join(driver.root, "corpus.json")));
  const missing = missingFinalCoverage(rows, corpus.tasks);
  const result = analyzeStudy(rows, frozen.manifest);
  return {
    ...result,
    unresolvedReservations: driver.ledger.unresolved(),
    missingOrUncheckedFinalExecutions: missing,
    conclusion:
      driver.ledger.unresolved() || missing ? "inconclusive-or-negative" : result.conclusion,
  };
}

export function missingFinalCoverage(
  rows: PairedObservation[],
  tasks: import("./deployment-contract.js").StudyTask[],
): number {
  const expected = tasks.filter((t) => t.partition === "final");
  for (const row of rows.filter((r) => r.phase === "final")) {
    const task = expected.find((t) => t.id === row.taskId && t.node === row.node);
    if (
      !task ||
      task.family !== row.family ||
      task.user !== row.user ||
      task.environment !== row.environment ||
      task.newUser !== row.newUser
    )
      throw new Error("Final observation differs from frozen task identity");
  }
  let missing = 0;
  for (const condition of CONDITIONS)
    for (const task of expected)
      for (const retention of task.newUser ? [false] : [false, true]) {
        if (
          !rows.some(
            (row) =>
              row.condition === condition &&
              row.phase === "final" &&
              row.node === task.node &&
              row.taskId === task.id &&
              row.retention === retention &&
              row.checked &&
              row.success !== null,
          )
        )
          missing++;
      }
  return missing;
}
