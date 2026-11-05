import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const provenance = read("provenance.json");
const integrity = [];
for (const file of provenance.files) {
  const bytes = fs.readFileSync(path.join(root, file.path));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(blob, file.gitBlobSha, `Source differs from pinned Git blob: ${file.path}`);
  integrity.push({
    path: file.path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const taskFiles = {
  airline: "upstream/data/tau2/domains/airline/tasks.json",
  retail: "upstream/data/tau2/multilingual/en/retail_tasks_en.json",
  telecom: "upstream/data/tau2/multilingual/en/telecom_tasks_en.json",
};
const domains = {},
  catalog = [];
const benchmark = read("upstream/data/tau2/benchmarks/text.json");
for (const [domain, taskFile] of Object.entries(taskFiles)) {
  const tasks = read(taskFile);
  const subsetFile = `upstream/data/tau2/task_subsets/${domain}_50.json`;
  const subset = read(subsetFile);
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(path.join(root, subsetFile)))
      .digest("hex"),
    benchmark.task_subsets[domain].sha256,
    `${domain}: benchmark/subset hash mismatch`,
  );
  assert.equal(tasks.length, 50);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 50);
  assert.deepEqual(tasks.map((task) => task.id).toSorted(), subset.task_ids.toSorted());
  const rewardComponents = {},
    primaryActionCounts = {};
  let environmentOnly = 0;
  for (const task of tasks) {
    assert.equal(typeof task.id, "string");
    assert.ok(task.user_scenario?.instructions, `${domain}/${task.id}: missing user instructions`);
    const evaluation = task.evaluation_criteria;
    assert.ok(Array.isArray(evaluation.reward_basis) && evaluation.reward_basis.length);
    assert.ok(Array.isArray(evaluation.actions));
    for (const component of evaluation.reward_basis)
      rewardComponents[component] = (rewardComponents[component] ?? 0) + 1;
    const stateOnly = evaluation.reward_basis.every((component) =>
      ["DB", "ENV_ASSERTION"].includes(component),
    );
    if (stateOnly) {
      environmentOnly++;
      assert.ok(evaluation.env_assertions?.length || evaluation.actions.length);
    }
    for (const action of evaluation.actions)
      if (action.name)
        primaryActionCounts[action.name] = (primaryActionCounts[action.name] ?? 0) + 1;
    catalog.push({
      domain,
      id: task.id,
      rewardBasis: evaluation.reward_basis,
      environmentOnly: stateOnly,
      referenceActions: evaluation.actions.length,
    });
  }
  domains[domain] = {
    tasks: tasks.length,
    rewardComponents,
    environmentOnly,
    referenceActionNames: primaryActionCounts,
  };
}
const report = {
  schemaVersion: 1,
  commit: provenance.commit,
  status:
    "Data integrity and schema checks passed; native execution and verifier correctness not yet qualified.",
  totalTasks: catalog.length,
  hostOnly:
    "Task IDs can reveal hidden issues. Keep this inventory, reference actions, expected states, descriptions and grading criteria outside actor context.",
  domains,
  stateOnlyTelecomTaskIds: catalog
    .filter((task) => task.domain === "telecom" && task.environmentOnly)
    .map((task) => task.id),
  catalog,
  integrity,
};
if (process.argv.includes("--write-inventory"))
  fs.writeFileSync(path.join(root, "inventory.json"), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
console.log(
  JSON.stringify(
    {
      totalTasks: report.totalTasks,
      filesVerified: integrity.length,
      domains,
      status: report.status,
    },
    null,
    2,
  ),
);
