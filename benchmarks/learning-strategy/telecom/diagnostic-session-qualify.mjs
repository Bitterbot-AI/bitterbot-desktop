import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDiagnosticSession } from "./diagnostic-session.mjs";
import { checkFreeze } from "./procedure-protocol.mjs";

// Scripted native integration qualification, with the already known host roaming repair.
// No model selects an action, and no original episode is rescored.
const [sourceArg, outputArg] = process.argv.slice(2);
assert.ok(
  sourceArg && outputArg,
  "Usage: node diagnostic-session-qualify.mjs discovery-root new-output",
);
const sourceRoot = path.resolve(sourceArg);
const outputRoot = path.resolve(outputArg);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(sourceRoot, name), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
checkFreeze(sourceRoot);
assert.equal(read("audit.json").status, "passed");
assert.equal(read("protocol.json").stage, "discovery");
assert.ok(!fs.existsSync(outputRoot), "Qualification output must be new");
fs.mkdirSync(outputRoot);
fs.mkdirSync(path.join(outputRoot, "sources"));
const sources = [
  "diagnostic-session.mjs",
  "diagnostic-actions.mjs",
  "diagnostic-session.test.mjs",
  "diagnostic-session-qualify.mjs",
  "bridge.mjs",
  "native.py",
  "native-sources.json",
].map((name) => {
  const bytes = fs.readFileSync(path.join(here, name));
  fs.writeFileSync(path.join(outputRoot, "sources", name), bytes, { flag: "wx" });
  return { name, sha256: sha(bytes) };
});
const targets = [
  { label: "experience-0-r1-case-36", index: 36, omissions: ["account"] },
  { label: "experience-1-r1-case-44", index: 44, omissions: ["account", "device"] },
];
const action = (tool, args = {}) => ({ tool, argumentsJson: JSON.stringify(args) });
function selector(binding, omitted = null) {
  return async (view) => {
    const response = (tool) =>
      view.events.find((e) => e.type === "action" && e.action.tool === tool)?.response;
    const line = response("assistant.get_details_by_id");
    if (!line) return action("assistant.get_details_by_id", { id: binding.lineId });
    assert.equal(line.error, false);
    const details = JSON.parse(line.content);
    assert.equal(typeof details.roaming_enabled, "boolean");
    if (omitted !== "account" && !details.roaming_enabled && !response("assistant.enable_roaming"))
      return action("assistant.enable_roaming", {
        customer_id: binding.customerId,
        line_id: binding.lineId,
      });
    const network = response("user.check_network_status");
    if (!network) return action("user.check_network_status");
    assert.equal(network.error, false);
    assert.match(network.content, /^Data Roaming Enabled: (Yes|No)$/m);
    if (
      omitted !== "device" &&
      /^Data Roaming Enabled: No$/m.test(network.content) &&
      !response("user.toggle_roaming")
    )
      return action("user.toggle_roaming");
    if (!response("user.can_send_mms")) return action("user.can_send_mms");
    return null;
  };
}
const rows = [];
for (const target of targets) {
  assert.ok(read("protocol.json").indices.includes(target.index));
  const episodeBytes = fs.readFileSync(path.join(sourceRoot, `episode-${target.label}.json`));
  const episode = JSON.parse(episodeBytes);
  assert.equal(episode.verdict.passed, false);
  const lookup = episode.transcript.find(
    (t) => t.type === "tool" && t.seat === "actor" && t.name === "get_customer_by_phone",
  );
  assert.ok(lookup);
  const customer = JSON.parse(lookup.content);
  const line = episode.transcript
    .filter((t) => t.type === "tool" && t.seat === "actor" && t.name === "get_details_by_id")
    .map((t) => JSON.parse(t.content))
    .find((t) => t.line_id && t.phone_number === lookup.arguments.phone_number);
  assert.ok(line, "Use bindings observed in the original actor trace");
  const binding = { customerId: customer.customer_id, lineId: line.line_id };
  let full;
  for (const omitted of [null, ...target.omissions]) {
    const result = await runDiagnosticSession({
      alias: target.label,
      source: { index: target.index, episode },
      selectAction: selector(binding, omitted),
    });
    rows.push({
      target: target.label,
      index: target.index,
      originalEpisodeHash: sha(episodeBytes),
      variant: omitted ? `omit-${omitted}` : "full-scripted-repair",
      expectedPassed: omitted === null,
      result,
    });
    if (omitted === null) full = result;
  }
  if (full?.afterPassed) {
    // Replay the actual successful diagnostic trajectory as a positive-state control.
    const repairedEpisode = structuredClone(episode);
    for (const e of full.events.filter((e) => e.type === "action")) {
      assert.equal(e.status, "returned");
      const [role, name] = e.action.tool.split(".");
      repairedEpisode.transcript.push({
        type: "tool",
        seat: role === "assistant" ? "actor" : "user",
        name,
        arguments: JSON.parse(e.action.argumentsJson),
        ...e.response,
      });
    }
    repairedEpisode.verdict = { passed: true };
    const result = await runDiagnosticSession({
      alias: `${target.label}-already-repaired`,
      source: { index: target.index, episode: repairedEpisode },
      selectAction: selector(binding),
    });
    rows.push({
      target: target.label,
      index: target.index,
      originalEpisodeHash: sha(episodeBytes),
      variant: "already-repaired",
      expectedPassed: true,
      result,
    });
  }
}
const positive = rows.filter((r) => r.variant === "already-repaired");
const passed =
  rows.length === 7 &&
  rows.every((r) => r.result.status === "stopped" && r.result.afterPassed === r.expectedPassed) &&
  positive.every(
    (r) =>
      r.result.beforePassed === true &&
      r.result.events
        .filter((e) => e.type === "action")
        .every((e) => !["assistant.enable_roaming", "user.toggle_roaming"].includes(e.action.tool)),
  );
const report = {
  status: passed ? "passed" : "failed",
  kind: "host-scripted-native-integration-qualification",
  sourceRun: path.basename(sourceRoot),
  sourceAuditHash: sha(fs.readFileSync(path.join(sourceRoot, "audit.json"))),
  sources,
  trials: rows.length,
  fullRepairs: rows.filter((r) => r.variant === "full-scripted-repair" && r.result.afterPassed)
    .length,
  omissionFailures: rows.filter(
    (r) => r.variant.startsWith("omit-") && r.result.afterPassed === false,
  ).length,
  positiveStatesPreserved: positive.filter((r) => r.result.afterPassed).length,
  newProviderCalls: 0,
  originalOutcomesUnchanged: true,
  learningBenefitEstablished: false,
  limitation:
    "Host-scripted known roaming repair and conditional checks, in privileged native diagnostic copies. No model chooses actions, no new consent conversation occurs, and this does not establish autonomous repair discovery or recipient benefit.",
  rows,
};
fs.writeFileSync(
  path.join(outputRoot, "qualification.json"),
  JSON.stringify(report, null, 2) + "\n",
  {
    flag: "wx",
  },
);
console.log(JSON.stringify({ ...report, sources: undefined, rows: undefined }));
assert.equal(passed, true, "Native integration qualification failed; inspect retained rows");
