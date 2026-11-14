import path from "node:path";
import { learningHash } from "../../src/agents/skills/collective/contracts.js";
import { NODE_IDS, readJson, validateCorpus, writeNewJson } from "./deployment-contract.js";
import { DeploymentStudyDriver, prepareDeployment } from "./deployment-driver.js";
import {
  exportDeployment,
  exportBlindReview,
  importHumanRatings,
  analyzeDeployment,
} from "./deployment-report.js";
import { createPilotCorpus } from "./pilot-corpus.js";
import { freezeStudy } from "./study.js";

const [action, target, extra] = process.argv.slice(2);
const progress = (message: string) => process.stderr.write(`[study] ${message}\n`);
if (action === "corpus") {
  await writeNewJson(target, createPilotCorpus());
  process.stdout.write(`${target}\n`);
} else if (action === "prepare") {
  const frozen = await prepareDeployment(await readJson(target), extra, progress);
  process.stdout.write(
    JSON.stringify(
      {
        directory: path.resolve(extra),
        hash: frozen.hash,
        conditions: frozen.spec.conditions,
        preparedNodes: frozen.spec.conditions.length * NODE_IDS.length,
      },
      null,
      2,
    ) + "\n",
  );
} else if (
  ["run", "smoke", "retention", "report", "review", "ratings", "analyze"].includes(action)
) {
  const driver = await DeploymentStudyDriver.open(target, progress);
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  try {
    if (["run", "smoke", "retention"].includes(action)) {
      if (
        action === "smoke" &&
        (driver.spec.conditions.length !== 1 || driver.spec.conditions[0] !== "frozen")
      )
        throw new Error(
          "Smoke calls require a separate frozen-only development deployment, preserving all study conditions",
        );
      const corpus = validateCorpus(await readJson(path.join(driver.root, "corpus.json")));
      if (driver.spec.purpose === "efficacy-study") {
        if (!extra) throw new Error("Efficacy execution requires its preregistered study manifest");
        const frozen = (await readJson(extra)) as ReturnType<typeof freezeStudy>;
        if (
          freezeStudy(frozen.manifest).hash !== frozen.hash ||
          frozen.manifest.model !== driver.spec.model ||
          frozen.manifest.initialLibraryHash !== driver.frozen!.packageHash ||
          frozen.manifest.seed !== driver.spec.seed ||
          learningHash(frozen.manifest.groupCeiling) !== learningHash(driver.spec.groupCeiling) ||
          frozen.manifest.toolsHash !== learningHash(driver.frozen!.environments.frozen.a.tools)
        )
          throw new Error("Study manifest and deployment differ");
        for (const partition of ["acquisition", "selection", "final"] as const) {
          const actual = [
            ...new Set(corpus.tasks.filter((t) => t.partition === partition).map((t) => t.corpus)),
          ].toSorted();
          if (
            learningHash(actual) !==
            learningHash([...frozen.manifest.partitions[partition]].toSorted())
          )
            throw new Error("Study corpus differs from preregistration");
        }
        const prior = driver.db
          .prepare("SELECT value FROM study_meta WHERE key='study-manifest'")
          .get() as { value: string } | undefined;
        if (prior && prior.value !== frozen.hash)
          throw new Error("Study preregistration already bound");
        if (!prior && driver.ledger.observations().length)
          throw new Error("Cannot preregister after execution");
        driver.db
          .prepare("INSERT OR IGNORE INTO study_meta VALUES ('study-manifest',?)")
          .run(frozen.hash);
      }
      for (const condition of driver.spec.conditions) {
        await driver.configure(condition, {
          localLearning: condition !== "frozen",
          exchange: ["exchange", "pooled"].includes(condition),
          synthesis: condition === "pooled",
          publicPublishing: false,
        });
        if (action === "smoke") await driver.smoke(abort.signal);
        else if (action === "retention") await driver.retention(abort.signal);
        else
          for (const partition of ["acquisition", "selection", "final"] as const)
            await driver.run(
              condition,
              partition,
              [
                ...new Set(
                  corpus.tasks.filter((t) => t.partition === partition).map((t) => t.corpus),
                ),
              ],
              abort.signal,
            );
      }
    }
    if (action === "review")
      process.stdout.write(
        JSON.stringify({ blindItems: await exportBlindReview(driver, extra) }) + "\n",
      );
    else if (action === "ratings")
      process.stdout.write(
        JSON.stringify({ observations: (await importHumanRatings(driver, extra)).length }) + "\n",
      );
    else if (action === "analyze")
      process.stdout.write(JSON.stringify(await analyzeDeployment(driver, extra), null, 2) + "\n");
    else process.stdout.write(JSON.stringify(await exportDeployment(driver), null, 2) + "\n");
  } finally {
    await driver.close();
  }
} else
  throw new Error(
    "Usage: deployment-cli.ts corpus output.json | prepare spec.json new-directory | run directory [preregistered.json] | smoke separate-frozen-deployment | retention directory [preregistered.json] | report directory | review directory new-blind-bundle.json | ratings directory ratings.json | analyze directory preregistered.json",
  );
