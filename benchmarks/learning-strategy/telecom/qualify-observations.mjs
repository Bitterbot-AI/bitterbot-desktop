import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTER_REVISION } from "./episode.mjs";
import { createTelecomReminders, CONDITIONAL_REMINDERS } from "./reminders.mjs";
import { routeRecordedObservations } from "./trace-observations.mjs";

const roots = process.argv.slice(2).map((arg) => path.resolve(arg));
assert.ok(roots.length, "Usage: qualify-observations.mjs completed-run [completed-run ...]");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
// The v3 comparison froze the old router and identical rules before any paid call.
const reference = roots.find(
  (root) => read(root, "protocol.json").kind === "telecom-conditional-reminder-comparison",
);
assert.ok(reference, "Include the original conditional comparison for the frozen router control");
const referenceFreeze = read(reference, "freeze.json");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tau-observation-control-"));
try {
  for (const file of [
    "src/memory/learning-strategy-reminders.ts",
    "benchmarks/learning-strategy/telecom/reminders.mjs",
  ]) {
    const source = referenceFreeze.sources.find((entry) => entry.file === file);
    assert.ok(source);
    const bytes = fs.readFileSync(path.join(reference, source.snapshot));
    assert.equal(hash(bytes), source.sha256);
    const target = path.resolve(temp, file);
    assert.ok(target.startsWith(temp + path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const old = await import(
    pathToFileURL(path.join(temp, "benchmarks/learning-strategy/telecom/reminders.mjs")).href
  );
  assert.deepEqual(
    old.CONDITIONAL_REMINDERS,
    CONDITIONAL_REMINDERS,
    "This qualification isolates observation/grounding changes; rules must stay fixed",
  );
  const episodes = [],
    inputs = [];
  for (const root of roots) {
    assert.equal(read(root, "audit.json").status, "passed");
    const complete = read(root, "complete.json"),
      protocol = read(root, "protocol.json");
    assert.ok(complete.executionManifest?.length);
    inputs.push({
      study: path.basename(root),
      freezeSha256: hash(fs.readFileSync(path.join(root, "freeze.json"))),
    });
    for (const entry of complete.executionManifest) {
      const filename = `episode-${entry.label}.json`,
        episode = read(root, filename);
      const first = episode.transcript.find((row) => row.id && row.seat === "user");
      const request = read(root, `responses/${first.id}.json`).request;
      const system = request.system[0].text,
        marker = system.lastIndexOf("\n\n{");
      assert.ok(marker >= 0, "Missing recorded customer knowledge");
      const scenario = JSON.parse(system.slice(marker + 2));
      episodes.push({
        study: path.basename(root),
        label: entry.label,
        index: entry.index,
        arm: entry.arm,
        repetition: entry.repetition,
        episodeSha256: hash(fs.readFileSync(path.join(root, filename))),
        frozen: routeRecordedObservations(
          episode,
          old.createTelecomReminders(CONDITIONAL_REMINDERS),
          scenario,
          false,
        ),
        revised: routeRecordedObservations(
          episode,
          createTelecomReminders(CONDITIONAL_REMINDERS),
          scenario,
        ),
      });
    }
    assert.ok(protocol.kind.startsWith("telecom-"));
  }
  const summarize = (rows, version) => ({
    episodes: rows.length,
    activatedEpisodes: rows.filter((episode) => episode[version].hits.length).length,
    deliveriesByRule: Object.fromEntries(
      CONDITIONAL_REMINDERS.map((rule) => [
        rule.id,
        rows
          .flatMap((episode) => episode[version].hits.flatMap((hit) => hit.matches))
          .filter((match) => match.id === rule.id).length,
      ]),
    ),
    groundingFailures: rows
      .filter((episode) => episode[version].groundingFailure)
      .map((episode) => ({
        study: episode.study,
        label: episode.label,
        ...episode[version].groundingFailure,
      })),
  });
  const conditional = episodes.filter((episode) => episode.arm === "conditional");
  console.log(
    JSON.stringify(
      {
        kind: "offline-observation-qualification",
        adapterRevision: ADAPTER_REVISION,
        providerCalls: 0,
        modelDecisionsRerun: 0,
        ruleTextChanged: false,
        inputs,
        episodes,
        summary: {
          frozen: summarize(episodes, "frozen"),
          revised: summarize(episodes, "revised"),
          originalConditional: {
            frozen: summarize(conditional, "frozen"),
            revised: summarize(conditional, "revised"),
          },
          simpleDomesticControl: {
            frozen: summarize(
              episodes.filter((episode) => episode.index === 1),
              "frozen",
            ),
            revised: summarize(
              episodes.filter((episode) => episode.index === 1),
              "revised",
            ),
          },
        },
        limitations:
          "All traces are consumed development evidence. New advice would change subsequent model decisions; these fixed trajectories only qualify routing. No new repair, model obedience, causal benefit or transfer is measured. The birth-date guard is bounded to explicit ISO/month-name assertions and does not establish general simulator factuality.",
      },
      null,
      2,
    ),
  );
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
}
