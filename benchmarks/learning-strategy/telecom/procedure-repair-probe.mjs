import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.mjs";
import { hash } from "./provider.mjs";

// Oracle-informed, post-collection state diagnosis, not an agent/learning evaluation.
const sourceRoot = path.resolve(process.argv[2] ?? "");
const outputRoot = path.resolve(process.argv[3] ?? "");
const read = (name) => JSON.parse(fs.readFileSync(path.join(sourceRoot, name), "utf8"));
const review = read("procedure-review.json"),
  freeze = read("freeze.json");
assert.equal(read("audit.json").status, "passed");
assert.equal(review.status, "passed");
for (const source of freeze.sources)
  assert.equal(hash(fs.readFileSync(source.file, "utf8")), source.sha256);
fs.mkdirSync(outputRoot);
const write = (name, value) =>
  fs.writeFileSync(path.join(outputRoot, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
const source = fs.readFileSync(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(outputRoot, "source.mjs"), source, { flag: "wx" });
write("protocol.json", {
  sourceRun: sourceRoot,
  sourceFreezeHash: hash(freeze),
  sourceAuditHash: hash(read("audit.json")),
  sourceReviewHash: hash(review),
  probeSourceHash: hash(source.toString("utf8")),
  purpose:
    "Post-collection check of whether observed missing roaming/allowance repairs suffice in cloned failed native states. Repeat each recipe with each single repair omitted. Original model outcomes remain unchanged.",
  newProviderRequests: 0,
  limitation:
    "Host-authored recipes informed by final private state. No model selected these actions, no new user conversation or consent was evaluated, and no learned or transferred benefit is measured.",
});
const rows = [];
for (const trial of review.failedTrials) {
  const original = read(`episode-${trial.label}.json`),
    state = trial.failureState,
    line = state.affectedLine,
    customer = JSON.parse(state.probes.find((p) => p.name === "get_customer_by_phone").content),
    network = state.probes.find((p) => p.name === "check_network_status").content;
  const repairs = [];
  if (!line.roaming_enabled)
    repairs.push({
      role: "assistant",
      name: "enable_roaming",
      arguments: { customer_id: customer.customer_id, line_id: line.line_id },
    });
  if (/^Data Roaming Enabled: No$/m.test(network))
    repairs.push({ role: "user", name: "toggle_roaming", arguments: {} });
  if (line.data_used_gb >= state.plan.data_limit_gb + line.data_refueling_gb)
    repairs.push({
      role: "assistant",
      name: "refuel_data",
      arguments: { customer_id: customer.customer_id, line_id: line.line_id, gb_amount: 2 },
    });
  assert.ok(repairs.length > 0);
  const variants = [];
  for (const omit of [-1, ...repairs.map((_r, i) => i)]) {
    const bridge = createBridge();
    try {
      await bridge.request({ method: "reset", index: trial.index });
      for (const event of original.transcript.filter((r) => r.type === "tool")) {
        const response = await bridge.request({
          method: "call",
          role: event.seat === "user" ? "user" : "assistant",
          name: event.name,
          arguments: event.arguments,
        });
        assert.equal(response.content, event.content);
        assert.equal(response.error, event.error);
      }
      assert.deepEqual(await bridge.request({ method: "judge" }), original.verdict);
      const actions = [];
      for (const [i, repair] of repairs.entries()) {
        if (i === omit) continue;
        const response = await bridge.request({ method: "call", ...repair });
        assert.equal(response.error, false);
        actions.push({ ...repair, response });
      }
      const verdict = await bridge.request({ method: "judge" });
      assert.equal(verdict.replayMatch, true);
      assert.equal(verdict.unrelatedPreserved, true);
      variants.push({ omittedRepair: omit, actions, verdict });
    } finally {
      bridge.close();
    }
  }
  rows.push({ label: trial.label, index: trial.index, repairs, variants });
}
const full = rows.map((r) => r.variants.find((v) => v.omittedRepair === -1));
const negative = rows.flatMap((r) => r.variants.filter((v) => v.omittedRepair !== -1));
const result = {
  status: "completed",
  postCollectionDiagnostic: true,
  originalOutcomesChanged: false,
  newProviderRequests: 0,
  failedEpisodes: rows.length,
  fullRecipePasses: full.filter((r) => r.verdict.passed).length,
  singleOmissionControls: negative.length,
  singleOmissionFailures: negative.filter((r) => !r.verdict.passed).length,
  rows,
  learningBenefitEstablished: false,
};
write("results.json", result);
console.log(JSON.stringify({ ...result, rows: undefined }));
