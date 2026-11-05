import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createBridge } from "./bridge.mjs";
import { hash } from "./provider.mjs";
import { projectStatusBar } from "./statusbar-probe.mjs";

const id = process.argv[2];
assert.ok(/^[a-zA-Z0-9_-]+$/.test(id ?? ""));
const results = "benchmarks/learning-strategy/results/",
  root = results + id + "/",
  sourceRun = results + "telecom-evidence-compliance-v3/";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const complete = read(sourceRun + "complete.json");
assert.equal(read(sourceRun + "audit.json").status, "passed");
const mainFreeze = read(results + "telecom-evidence-comparison-v1/freeze.json");
const checkMainUnchanged = () => {
  for (const source of mainFreeze.sources)
    assert.equal(
      hash(fs.readFileSync(source.file, "utf8")),
      source.sha256,
      `Running study source changed: ${source.file}`,
    );
};
checkMainUnchanged();
fs.mkdirSync(root);
const write = (name, value) =>
  fs.writeFileSync(root + name, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const protocol = {
  kind: "telecom-offline-statusbar-probe",
  sourceRun: "telecom-evidence-compliance-v3",
  indices: [46, 47],
  sourceEpisodes: 6,
  purpose:
    "Offline candidate: validate selected status-bar fields against fresh native read-only diagnostics on consumed development trajectories. No model calls, public auto-sharing, changed actions, repaired outcomes or live integration.",
  decision:
    "Replay all recorded native tool outputs exactly. After each eligible completed status-bar response, compare every projected fact against a fresh check_network_status result. Final native verdict must equal the source episode. Malformed/private field controls are unit-tested. Running paid comparison sources must stay byte-identical.",
  limitation:
    "Pinned native serializer and six development trajectories only. No claim that a model will select these references, that reminders would activate, or that task outcomes would improve. Data Disabled display is not proof that the data switch is off.",
};
write("protocol.json", protocol);
fs.mkdirSync(root + "source");
const qualification = read(
  "benchmarks/learning-strategy/telecom/qualification-public-observations-v6.json",
);
const files = [
  ...new Set([
    ...qualification.sources.map((s) => s.file),
    ...complete.executionManifest.map((e) => sourceRun + `episode-${e.label}.json`),
    ...["statusbar-probe.mjs", "statusbar-probe.test.mjs", "qualify-statusbar-probe.mjs"].map(
      (f) => "benchmarks/learning-strategy/telecom/" + f,
    ),
  ]),
];
const sources = files.map((file, i) => {
  const bytes = fs.readFileSync(file),
    snapshot = `source/${i}-${path.basename(file)}`;
  fs.writeFileSync(root + snapshot, bytes);
  return { file, snapshot, sha256: hash(bytes.toString("utf8")) };
});
write("freeze.json", { at: new Date().toISOString(), protocolHash: hash(protocol), sources });
const episodes = [],
  comparisons = [];
for (const entry of complete.executionManifest) {
  const original = read(sourceRun + `episode-${entry.label}.json`),
    bridge = createBridge();
  let probes = 0,
    fields = 0;
  try {
    await bridge.request({ method: "reset", index: entry.index });
    for (const [position, event] of original.transcript.entries()) {
      if (event.type !== "tool") continue;
      const replayed = await bridge.request({
        method: "call",
        role: event.seat === "user" ? "user" : "assistant",
        name: event.name,
        arguments: event.arguments,
      });
      assert.equal(replayed.content, event.content);
      assert.equal(replayed.error, event.error);
      const projected = projectStatusBar(event);
      if (!projected.length) continue;
      const check = await bridge.request({
        method: "call",
        role: "user",
        name: "check_network_status",
        arguments: {},
      });
      assert.equal(check.error, false);
      const values = Object.fromEntries(
        check.content.split(/\r?\n/).map((line) => {
          const n = line.indexOf(": ");
          return [line.slice(0, n), line.slice(n + 2)];
        }),
      );
      const expected = {
        "device.strongCellularSignal":
          values["Cellular Connection"] === "connected" &&
          ["good", "excellent"].includes(values["Cellular Signal"]) &&
          ["4G", "5G"].includes(values["Cellular Network Type"]),
        "device.dataEnabled": values["Mobile Data Enabled"] === "Yes",
      };
      for (const record of projected)
        assert.equal(
          record.value,
          expected[record.fact],
          `${entry.label} ${event.name} ${record.fact}`,
        );
      comparisons.push({
        label: entry.label,
        position,
        tool: event.name,
        projected,
        matched: true,
      });
      probes++;
      fields += projected.length;
    }
    const verdict = await bridge.request({ method: "judge" });
    for (const key of ["passed", "nativePassed", "checks", "unrelatedPreserved", "replayMatch"])
      assert.deepEqual(verdict[key], original.verdict[key]);
    episodes.push({
      label: entry.label,
      index: entry.index,
      additionalReadOnlyProbes: probes,
      fieldsCompared: fields,
      nativeOutcomeUnchanged: true,
      passed: verdict.passed,
    });
  } finally {
    bridge.close();
  }
}
checkMainUnchanged();
for (const source of sources)
  assert.equal(hash(fs.readFileSync(source.file, "utf8")), source.sha256);
const result = {
  status: "passed",
  episodes,
  comparisons,
  summary: {
    sourceEpisodes: episodes.length,
    additionalReadOnlyProbes: episodes.reduce((s, e) => s + e.additionalReadOnlyProbes, 0),
    fieldsCompared: episodes.reduce((s, e) => s + e.fieldsCompared, 0),
    newProviderRequests: 0,
    paidStudySourcesUnchanged: true,
    integratedIntoAdapter: false,
    modelBenefitTested: false,
  },
};
write("qualification.json", result);
console.log(JSON.stringify({ status: result.status, ...result.summary }));
