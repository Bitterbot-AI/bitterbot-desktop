import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { MISSING_DIAGNOSTIC_REMINDERS } from "./diagnostic-observations.mjs";
import { ADAPTER_REVISION } from "./episode.mjs";
import { hash } from "./provider.mjs";
import { createTelecomReminders } from "./reminders.mjs";
import { routeRecordedObservations } from "./trace-observations.mjs";

const base = "benchmarks/learning-strategy/telecom/";
const tests = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    base + "telecom.test.mjs",
    base + "diagnostic-observations.test.mjs",
  ],
  { encoding: "utf8" },
);
assert.equal(tests.status, 0, tests.stdout + tests.stderr);
const rows = [],
  inputs = [];
for (const study of ["telecom-conditional-comparison-v2", "telecom-additive-transfer-v1"]) {
  const root = `benchmarks/learning-strategy/results/${study}/`;
  const read = (file) => JSON.parse(fs.readFileSync(root + file, "utf8"));
  assert.equal(read("audit.json").status, "passed");
  inputs.push({ study, freezeSha256: hash(fs.readFileSync(root + "freeze.json", "utf8")) });
  for (const entry of read("complete.json").executionManifest) {
    const episode = read(`episode-${entry.label}.json`);
    const first = episode.transcript.find((row) => row.id && row.seat === "user");
    const system = read(`responses/${first.id}.json`).request.system[0].text;
    const scenario = JSON.parse(system.slice(system.lastIndexOf("\n\n{") + 2));
    rows.push({
      study,
      label: entry.label,
      index: entry.index,
      episodeSha256: hash(fs.readFileSync(root + `episode-${entry.label}.json`, "utf8")),
      ...routeRecordedObservations(
        episode,
        createTelecomReminders(MISSING_DIAGNOSTIC_REMINDERS),
        scenario,
      ),
    });
  }
}
assert.equal(rows.find((r) => r.label === "baseline-1-32").hits[0]?.beforeTranscriptPosition, 35);
const controls = rows.filter((r) => r.index === 1);
assert.equal(controls.length, 6);
assert.ok(controls.every((r) => !r.hits.length));
console.log(
  JSON.stringify(
    {
      status: "passed",
      adapterRevision: ADAPTER_REVISION,
      providerCalls: 0,
      modelDecisionsRerun: 0,
      rulesHash: hash(MISSING_DIAGNOSTIC_REMINDERS),
      sources: [
        "diagnostic-observations.mjs",
        "diagnostic-protocol.mjs",
        "reminders.mjs",
        "episode.mjs",
        "grounding.mjs",
        "trace-observations.mjs",
        "telecom.test.mjs",
        "diagnostic-observations.test.mjs",
        "qualify-diagnostic.mjs",
      ].map((name) => ({ file: base + name, sha256: hash(fs.readFileSync(base + name, "utf8")) })),
      inputs,
      tests: tests.stdout,
      rows,
      summary: {
        trajectories: rows.length,
        activated: rows.filter((r) => r.hits.length).length,
        deliveries: rows.reduce((sum, r) => sum + r.hits.length, 0),
        simpleControls: controls.length,
        controlsActivated: 0,
      },
      limitations:
        "Consumed development trajectories only. Recorded model decisions remain fixed; routing coverage does not demonstrate changed behavior, repaired tasks, causal benefit or transfer. Bounded public phrase parsing does not establish general observation coverage.",
    },
    null,
    2,
  ),
);
