import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MISSING_DIAGNOSTIC_REMINDERS } from "./diagnostic-observations.mjs";
import { ACTOR, ADAPTER_REVISION, runEpisode } from "./episode.mjs";
import { hash, priorExposure } from "./provider.mjs";
import { PublicObservationSession, publicObservationMessage } from "./public-observations.mjs";
import { createTelecomReminders } from "./reminders.mjs";

const id = process.argv[2];
assert.ok(/^[a-zA-Z0-9_-]+$/.test(id ?? ""), "Usage: qualify-public-observations.mjs unique-id");
const base = "benchmarks/learning-strategy/telecom/",
  results = "benchmarks/learning-strategy/results/",
  root = results + id + "/";
const write = (name, value) =>
  fs.writeFileSync(root + name, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const variants = JSON.parse(
  fs.readFileSync(base + "public-observation-variants.json", "utf8"),
).variants;
const arms = ["baseline", "static", "conditional"];
const prior = priorExposure(results).reduce((sum, row) => sum + row.usd, 0);
fs.mkdirSync(root);
const protocol = {
  kind: "telecom-public-observation-qualification",
  adapterRevision: ADAPTER_REVISION,
  observationMode: "structured",
  providerCalls: 0,
  modelSampling: false,
  fixtures: [
    { name: "blocked", index: 28, initialRepairs: [] },
    { name: "working", index: 0, initialRepairs: ["toggle_airplane_mode", "toggle_data"] },
  ],
  arms,
  variants: variants.length,
  decision:
    "All focused tests pass. Six native scripted fixtures give identical public records to every arm, trigger only the conditional blocked fixture, and suppress advice for working MMS. Every additional wording variant preserves those typed observations; unshared private results and snapshots missing a required fact do not trigger. Replay the scripted requests exactly without new provider calls. This is adapter qualification, not agent repair, efficiency, transfer or model tool-compliance evidence.",
  privacy:
    "The customer explicitly chooses fields to publish. Values are projected from prior completed diagnostics; no private tool result is automatically fed to the actor or reminder engine. All arms share the same observation interface. Model behavior remains untested.",
  exposureBeforeUsd: prior,
};
write("protocol.json", protocol);
const predecessor = JSON.parse(
  fs.readFileSync(results + "telecom-missing-diagnostic-v2/freeze.json", "utf8"),
);
const files = [
  ...new Set([
    ...predecessor.sources.map((s) => s.file),
    ...[
      "public-observations.mjs",
      "public-observations.test.mjs",
      "qualify-public-observations.mjs",
      "public-observation-variants.json",
      "current-references.test.mjs",
      "publication-preamble.test.mjs",
      "evidence-protocol.mjs",
      "evidence-protocol.test.mjs",
      "evidence-study.mjs",
      "evidence-analyze.mjs",
      "compliance.mjs",
      "compliance-audit.mjs",
      "compliance-report.mjs",
      "compliance-report.test.mjs",
      "feedback.mjs",
      "trace-observations.mjs",
    ].map((f) => base + f),
    ...[29, 33].map(
      (index) =>
        results + `telecom-public-observation-compliance-v1/episode-conditional-0-${index}.json`,
    ),
    ...[
      "conditional-0-3",
      "conditional-0-35",
      "conditional-1-3",
      "conditional-1-35",
      "conditional-1-30",
    ].map((label) => results + `telecom-evidence-compliance-v1/episode-${label}.json`),
  ]),
];
fs.mkdirSync(root + "source");
const sources = files.map((file, i) => {
  const bytes = fs.readFileSync(file),
    snapshot = `source/${i}-${path.basename(file)}`;
  fs.writeFileSync(root + snapshot, bytes);
  return { file, snapshot, sha256: hash(bytes.toString("utf8")) };
});
write("freeze.json", { at: new Date().toISOString(), protocolHash: hash(protocol), sources });
const call = (name, input = {}) => ({ type: "tool_use", name, input, id: name });
const references = (request) =>
  request.messages.at(-1).content.flatMap((part) => {
    const marker = "Shareable diagnostic references (private until explicitly shared):\n";
    if (typeof part.content !== "string" || !part.content.includes(marker)) return [];
    const source = JSON.parse(part.content.slice(part.content.indexOf(marker) + marker.length));
    return source.facts
      .filter((r) => ["device.strongCellularSignal", "service.mmsBlocked"].includes(r.fact))
      .map((r) => ({ sourceId: source.sourceId, fact: r.fact }));
  });

try {
  const tests = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      ...[
        "telecom.test.mjs",
        "diagnostic-observations.test.mjs",
        "public-observations.test.mjs",
        "current-references.test.mjs",
        "publication-preamble.test.mjs",
        "evidence-protocol.test.mjs",
        "compliance-report.test.mjs",
      ].map((f) => base + f),
    ],
    { encoding: "utf8", maxBuffer: 8e6 },
  );
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  write("tests.json", { status: "passed", stdout: tests.stdout, stderr: tests.stderr });
  const fixtures = [],
    metamorphic = [];
  for (const condition of protocol.fixtures) {
    let common;
    for (const arm of arms) {
      const label = `${arm}-${condition.name}`,
        requests = [],
        replies = [];
      const strategy =
        ACTOR + (arm === "static" ? "\n" + MISSING_DIAGNOSTIC_REMINDERS[0].text : "");
      const reminders = arm === "conditional" ? MISSING_DIAGNOSTIC_REMINDERS : [];
      const episode = await runEpisode({
        index: condition.index,
        strategy,
        reminders,
        tag: label,
        provider: {
          async call(request) {
            requests.push(structuredClone(request));
            const n = requests.length;
            const content =
              n === 1
                ? [
                    ...condition.initialRepairs.map((name) => call(name)),
                    call("check_network_status"),
                    call("can_send_mms"),
                  ]
                : n === 2
                  ? [
                      call("share_observations", {
                        speech: "Here are the requested diagnostic results.",
                        observations: references(request),
                      }),
                    ]
                  : [
                      call("transfer_to_human_agents", {
                        summary: "Terminate scripted interface fixture",
                      }),
                    ];
            const reply = { id: `${label}-${n}`, content, usd: 0, stopReason: "end_turn" };
            replies.push(reply);
            return reply;
          },
        },
      });
      assert.equal(requests.length, 3);
      assert.equal(episode.reason, "human-transfer");
      assert.equal(episode.verdict.passed, condition.name === "working");
      const publicRow = episode.transcript.find((r) => r.type === "public-observations");
      if (common) assert.deepEqual(publicRow.snapshot, common);
      else common = publicRow.snapshot;
      const delivered = episode.transcript.filter((r) => r.type === "reminder").length;
      assert.equal(delivered, Number(arm === "conditional" && condition.name === "blocked"));
      let cursor = 0;
      const replay = await runEpisode({
        index: condition.index,
        strategy,
        reminders,
        tag: label,
        provider: {
          async call(request) {
            assert.deepEqual(request, requests[cursor]);
            return replies[cursor++];
          },
        },
      });
      assert.equal(cursor, requests.length);
      assert.deepEqual(replay.transcript, episode.transcript);
      assert.deepEqual(replay.publicConversation, episode.publicConversation);
      assert.deepEqual(replay.verdict, episode.verdict);
      write(`fixture-${label}.json`, { episode, requests, replies });
      fixtures.push({
        label,
        nativeOutcome: episode.verdict.passed,
        expectedNativeOutcome: condition.name === "working",
        exactReplay: true,
        publications: 1,
        reminders: delivered,
        scriptedResponses: requests.length,
      });
      for (const [variant, speech] of variants.entries()) {
        const registry = new PublicObservationSession();
        let selected = [];
        for (const event of episode.transcript) {
          if (event.type === "public-observations") break;
          if (event.type !== "tool") continue;
          const source = registry.observeNative(event);
          if (source)
            selected.push(
              ...source.facts
                .filter((r) =>
                  ["device.strongCellularSignal", "service.mmsBlocked"].includes(r.fact),
                )
                .map((r) => ({ sourceId: source.sourceId, fact: r.fact })),
            );
        }
        const host = createTelecomReminders(reminders, { structured: true });
        const snapshot = registry.publish({ speech, observations: selected });
        assert.deepEqual(snapshot, common);
        const message = publicObservationMessage(speech, snapshot);
        assert.equal(JSON.parse(message).speech, speech);
        assert.deepEqual(JSON.parse(message).observations, snapshot);
        host.customerObservations(snapshot);
        assert.equal(host.take().length, delivered);
        // A new snapshot with no references must not promote private results.
        host.customerObservations(registry.publish({ speech, observations: [] }));
        assert.deepEqual(host.take(), []);
        // A partial report cannot establish the missing diagnostic trigger.
        host.customerObservations(
          registry.publish({
            speech,
            observations: selected.filter((r) => r.fact === "service.mmsBlocked"),
          }),
        );
        assert.deepEqual(host.take(), []);
        metamorphic.push({
          fixture: label,
          variant,
          publicSnapshotHash: hash(snapshot),
          reminders: delivered,
          emptyAndPartialQuiet: true,
        });
      }
    }
  }
  for (const source of sources)
    assert.equal(
      hash(fs.readFileSync(source.file, "utf8")),
      source.sha256,
      "Source changed during qualification",
    );
  const after = priorExposure(results).reduce((sum, row) => sum + row.usd, 0);
  assert.equal(after, prior, "Offline qualification must not dispatch paid requests");
  const result = {
    status: "passed",
    adapterRevision: ADAPTER_REVISION,
    observationMode: "structured",
    rulesHash: hash(MISSING_DIAGNOSTIC_REMINDERS),
    sources: sources.map(({ file, sha256 }) => ({ file, sha256 })),
    providerCalls: 0,
    newPaidUsd: 0,
    exposureUsd: after,
    fixtures,
    metamorphic,
    summary: {
      nativeFixtures: fixtures.length,
      exactScriptedReplays: fixtures.length,
      scriptedResponses: fixtures.reduce((sum, f) => sum + f.scriptedResponses, 0),
      reportVariants: variants.length,
      variantArmConditionChecks: metamorphic.length,
      negativeSnapshotChecks: metamorphic.length * 2,
      conditionalBlockedDeliveries: metamorphic.filter(
        (row) => row.fixture === "conditional-blocked" && row.reminders === 1,
      ).length,
    },
    limitations: protocol.decision,
  };
  write("qualification.json", result);
  fs.writeFileSync(
    base + "qualification-public-observations-v6.json",
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({ status: result.status, ...result.summary, newPaidUsd: 0, exposureUsd: after }),
  );
} catch (error) {
  write("incomplete.json", { error: error.message, paidRequests: 0 });
  throw error;
}
