import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Post-collection diagnostics only. Never change the frozen gate or exclude failed trials.
const root = path.resolve(process.argv[2] ?? "");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const protocol = read("protocol.json"),
  analysis = read("analysis.json"),
  audit = read("audit.json"),
  complete = read("complete.json");
assert.equal(protocol.kind, "telecom-conditional-reminder-comparison");
assert.equal(audit.status, "passed");
assert.equal(analysis.episodes.length, complete.executionManifest.length);
assert.equal(
  analysis.episodes.reduce((sum, e) => sum + e.modelCalls, 0),
  audit.modelCalls,
);
assert.ok(Math.abs(analysis.newPaidUsd - audit.providerUsd) < 1e-9);
const episodes = analysis.episodes.map((episode) => {
  const raw = read(`episode-${episode.label}.json`);
  const tools = raw.transcript.filter((row) => row.type === "tool");
  const reminders = raw.transcript.filter((row) => row.type === "reminder");
  assert.equal(tools.length, episode.toolCalls);
  assert.deepEqual(
    reminders.flatMap((row) => row.matches.map((match) => match.id)),
    episode.reminders,
  );
  assert.ok(episode.reminders.every((id) => protocol.reminders.some((rule) => rule.id === id)));
  return {
    label: episode.label,
    index: episode.index,
    repetition: episode.repetition,
    arm: episode.arm,
    passed: episode.passed,
    reminderEvents: reminders.length,
    reminderDeliveries: reminders.flatMap((row) => row.matches).length,
    ruleIds: episode.reminders,
    toolCounts: Object.fromEntries(
      [...new Set(tools.map((row) => row.name))]
        .sort()
        .map((name) => [name, tools.filter((row) => row.name === name).length]),
    ),
    dataTogglesEndingOff: tools.filter(
      (row) => row.name === "toggle_data" && /Mobile Data is now OFF\./.test(row.content),
    ).length,
  };
});
const conditional = episodes.filter((episode) => episode.arm === "conditional");
console.log(
  JSON.stringify(
    {
      postCollectionDiagnostic: true,
      changesFrozenGate: false,
      episodes,
      conditionalExposure: {
        episodes: conditional.length,
        episodesWithReminders: conditional.filter((episode) => episode.reminderEvents > 0).length,
        totalDeliveries: conditional.reduce((sum, episode) => sum + episode.reminderDeliveries, 0),
        interpretation: conditional.some((episode) => episode.reminderEvents > 0)
          ? "activated"
          : "unexercised",
      },
      failedTrials: analysis.episodes
        .filter((episode) => !episode.passed)
        .map((episode) => ({
          label: episode.label,
          termination: episode.termination,
          modelCalls: episode.modelCalls,
          toolCalls: episode.toolCalls,
        })),
      note: "Trace counts describe observed behavior. Zero activations cannot establish a causal benefit or harm from reminders. Data toggles ending OFF are counted observations, not automatic policy-violation judgments. All trials remain in the frozen primary analysis.",
    },
    null,
    2,
  ),
);
