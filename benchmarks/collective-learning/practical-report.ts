/** Unpaid report/replay. Never loads provider authentication or calls a model. */
import fs from "node:fs/promises";
import path from "node:path";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import { analyzePractical, type PracticalFinal } from "./practical-analysis.js";
import {
  CHECKER_FILES,
  PRACTICAL_ROOT,
  checkPractical,
  practicalCases,
} from "./practical-learning.js";
const [operation, root] = process.argv.slice(2);
if (
  !["report", "replay"].includes(operation) ||
  !root ||
  path.dirname(root) !== "/home/vicmg/.local/share/bitterbot-studies" ||
  !path.basename(root).startsWith("practical-learning-")
)
  throw new Error("Use report|replay and an isolated practical-learning root");
const read = async (file: string) => JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
const frozen = await read("frozen.json"),
  report = await read("report.json");
const { hash, ...body } = frozen;
if (hash !== learningHash(body) || report.frozenHash !== hash)
  throw new Error("Report/freeze mismatch");
const cases = await practicalCases();
if (learningHash(cases) !== frozen.casesHash) throw new Error("Case drift");
type Recorded = PracticalFinal & {
  type: string;
  phase: string;
  artifactDirectory: string;
  artifacts: Array<{ name: string; sha256: string; bytes: number }>;
};
const executions = (report.runs as Recorded[]).filter((r) => r.type === "execution");
if (operation === "replay") {
  for (const file of CHECKER_FILES)
    if (
      sha256(await fs.readFile(path.join(PRACTICAL_ROOT, file))) !==
      frozen.sourceHashes[`research/collective-learning/practical-learning/${file}`]
    )
      throw new Error("Frozen checker drift");
  const records = [];
  for (const run of executions) {
    const item = cases.find((c) => c.id === run.task)!;
    const files = [];
    for (const file of run.artifacts) {
      const bytes = await fs.readFile(path.join(root, run.artifactDirectory, file.name));
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new Error("Output archive changed");
      files.push({ name: file.name, bytes, sha256: file.sha256 });
    }
    // An artifact recovered from an interrupted run cannot manufacture a checked
    // execution outcome. Verify its bytes above, but preserve its original state.
    const grade = ["pass", "task-failure"].includes(run.outcome)
      ? await checkPractical(item, files, frozen.image.id, new AbortController().signal)
      : null;
    records.push({
      replica: run.replica,
      task: run.task,
      arm: run.arm,
      phase: run.phase,
      original: run.outcome,
      replay: grade,
      agreement: grade ? grade.status === run.outcome : null,
      skippedReason: grade ? null : "original-execution-was-not-checked",
    });
    console.log(JSON.stringify(records.at(-1)));
  }
  await fs.writeFile(
    path.join(root, "independent-replay.json"),
    JSON.stringify({ modelCalls: 0, frozenHash: hash, records }, null, 2) + "\n",
    { flag: "wx" },
  );
} else {
  const planned = (frozen.blocks as Array<{ replica: number; task: string }>).map((p) => ({
    ...p,
    family: cases.find((c) => c.id === p.task)!.family,
  }));
  const analysis = analyzePractical(
    planned,
    executions.filter((r) => r.phase === "final"),
  );
  const summary = {
    schemaVersion: 1,
    status: report.status,
    frozenHash: hash,
    purpose: frozen.purpose,
    analysis,
    costs: {
      knownUsd: report.knownUsd,
      unknownReservedUsd: report.unknownReservedUsd,
      inherited: report.inherited,
      remainingOverallAuthorizationUsd: report.remainingOverallAuthorizationUsd,
    },
    taskExecutions: executions.length,
    proposalCalls: report.runs.filter((r: { type: string }) => r.type === "proposal").length,
    retentionAvailable: false,
    blindedRatingsAvailable: false,
    design: frozen.design,
  };
  await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: summary.status,
      taskExecutions: summary.taskExecutions,
      proposalCalls: summary.proposalCalls,
      primary: analysis.primary,
      arms: analysis.arms,
      costs: summary.costs,
    }),
  );
}
