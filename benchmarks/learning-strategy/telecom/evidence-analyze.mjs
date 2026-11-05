import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { summarizeCompliance } from "./compliance-report.mjs";
import { clusterInterval, interfaceGate } from "./evidence-protocol.mjs";
import { hash } from "./provider.mjs";
import { PublicObservationSession } from "./public-observations.mjs";
import { createTelecomReminders } from "./reminders.mjs";
import { routeRecordedObservations } from "./trace-observations.mjs";

const root = path.resolve(process.argv[2] ?? "");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const protocol = read("protocol.json"),
  freeze = read("freeze.json"),
  complete = read("complete.json"),
  audit = read("audit.json");
assert.equal(audit.status, "passed");
assert.equal(hash(protocol), freeze.protocolHash);
// Analysis and runtime modules must match the frozen prospective definitions.
for (const source of freeze.sources)
  assert.equal(
    hash(fs.readFileSync(source.file, "utf8")),
    source.sha256,
    `Analysis source changed: ${source.file}`,
  );
const ledger = fs
  .readFileSync(path.join(root, "provider.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const receipts = ledger.filter((r) => r.type === "receipt");
const assignments = fs
  .readFileSync(path.join(root, "lanes.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
assert.equal(new Set(assignments.map((r) => r.store)).size, assignments.length);
const laneByStore = new Map(assignments.map((r) => [r.store, r.lane]));
const lanes = Array.from({ length: protocol.concurrency }, () => ({
  spent: 0,
  reserved: 0,
  active: 0,
}));
const intents = new Map();
let peakConcurrent = 0;
for (const row of ledger) {
  if (row.type === "intent") {
    const label = row.tag.split(":")[0],
      store = label.slice(0, label.lastIndexOf("-")),
      lane = laneByStore.get(store);
    assert.ok(Number.isInteger(lane));
    const state = lanes[lane];
    assert.equal(state.active, 0);
    assert.ok(state.spent + row.quote <= protocol.laneCeilingUsd + 1e-9);
    state.reserved = row.quote;
    state.active = 1;
    intents.set(row.id, { lane, quote: row.quote });
    peakConcurrent = Math.max(
      peakConcurrent,
      lanes.reduce((s, l) => s + l.active, 0),
    );
    assert.ok(
      lanes.reduce((s, l) => s + l.spent + l.reserved, 0) <=
        protocol.newSpendCircuitBreakerUsd + 1e-9,
    );
  } else if (row.type === "receipt") {
    const intent = intents.get(row.id);
    assert.ok(intent);
    assert.ok(row.usd <= intent.quote);
    const state = lanes[intent.lane];
    assert.equal(state.active, 1);
    state.spent += row.usd;
    state.reserved = 0;
    state.active = 0;
    intents.delete(row.id);
  }
}
assert.equal(intents.size, 0);
assert.ok(peakConcurrent <= protocol.concurrency);
assert.ok(Math.abs(lanes.reduce((s, l) => s + l.spent, 0) - complete.provider.spent) < 1e-9);
const episodes = complete.executionManifest.map((entry) => {
  const episode = read(`episode-${entry.label}.json`);
  const summary = summarizeCompliance([{ ...entry, episode }]).rows[0];
  const calls = receipts.filter((r) => r.tag.startsWith(entry.label + ":"));
  assert.equal(calls.length, summary.modelCalls);
  const usage = calls.reduce(
    (s, { usage: u }) => ({
      input:
        s.input +
        u.input_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      output: s.output + u.output_tokens,
      cacheRead: s.cacheRead + (u.cache_read_input_tokens ?? 0),
      cacheWrite: s.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const diagnostic = routeRecordedObservations(
    episode,
    createTelecomReminders(protocol.reminders, { structured: true }),
    {},
    false,
  );
  const registry = new PublicObservationSession(),
    sources = new Map();
  let pairAvailable = 0,
    pairOmitted = 0,
    publicPair = 0;
  for (const event of episode.transcript) {
    if (event.type === "tool") {
      const source = registry.observeNative(event);
      if (source) sources.set(source.sourceId, source);
    }
    if (event.type !== "public-observations") continue;
    const pairs = ["device.strongCellularSignal", "service.mmsBlocked"];
    const published = pairs.every((f) =>
      event.snapshot.records.some((r) => r.fact === f && r.value),
    );
    if (published) publicPair++;
    const available = registry.currentReferences().observations;
    if (
      pairs.every((f) =>
        available.some(
          (r) =>
            r.fact === f && sources.get(r.sourceId)?.facts.some((v) => v.fact === f && v.value),
        ),
      )
    ) {
      pairAvailable++;
      if (!published) pairOmitted++;
    }
  }
  const followups = episode.transcript.flatMap((event, i) => {
    if (event.type !== "reminder") return [];
    const nextResponse = episode.transcript.slice(i + 1).find((r) => r.id);
    const nextTool = episode.transcript.slice(i + 1).find((r) => r.type === "tool");
    return [
      {
        delivered: nextResponse?.seat === "actor",
        turn: event.turn,
        ids: event.matches.map((m) => m.id),
        nextTool: nextTool ? { seat: nextTool.seat, name: nextTool.name } : null,
      },
    ];
  });
  return {
    ...summary,
    arm: entry.arm,
    repetition: entry.repetition,
    termination: episode.reason,
    passed: episode.verdict.passed && ["user-ended", "human-transfer"].includes(episode.reason),
    usage,
    uncachedEquivalentUsd:
      (usage.input * protocol.rates.input + usage.output * protocol.rates.output) / 1e6,
    eligibleReminderTurns: diagnostic.hits.length,
    availableDiagnosticPairReports: pairAvailable,
    omittedAvailablePairReports: pairOmitted,
    publicDiagnosticPairReports: publicPair,
    reminderFollowups: followups,
  };
});
const expected = protocol.indices.length * protocol.arms.length * protocol.repetitions;
const arms = protocol.arms.map((arm) => {
  const rows = episodes.filter((r) => r.arm === arm);
  return {
    arm,
    total: rows.length,
    successes: rows.filter((r) => r.passed).length,
    naturalCompletions: rows.filter((r) => ["user-ended", "human-transfer"].includes(r.termination))
      .length,
    interfaceFailures: rows.filter((r) => r.failures.length).length,
    nonemptyReportingEpisodes: rows.filter((r) => r.nonemptyReports).length,
    reminders: rows.reduce((s, r) => s + r.reminders, 0),
    eligibleReminderTurns: rows.reduce((s, r) => s + r.eligibleReminderTurns, 0),
    omittedAvailablePairReports: rows.reduce((s, r) => s + r.omittedAvailablePairReports, 0),
    availableDiagnosticPairReports: rows.reduce((s, r) => s + r.availableDiagnosticPairReports, 0),
    modelCalls: rows.reduce((s, r) => s + r.modelCalls, 0),
    toolCalls: rows.reduce((s, r) => s + r.toolCalls, 0),
    providerUsd: rows.reduce((s, r) => s + r.providerUsd, 0),
    uncachedEquivalentUsd: rows.reduce((s, r) => s + r.uncachedEquivalentUsd, 0),
  };
});
const comparisons =
  protocol.profileName === "comparison" && episodes.length === expected
    ? ["baseline", "static"].map((control) => {
        const perCase = protocol.indices.map((index) => {
          const pairs = Array.from({ length: protocol.repetitions }, (_, repetition) => {
            const a = episodes.find(
                (r) => r.arm === "conditional" && r.index === index && r.repetition === repetition,
              ),
              b = episodes.find(
                (r) => r.arm === control && r.index === index && r.repetition === repetition,
              );
            assert.ok(a && b);
            return {
              success: Number(a.passed) - Number(b.passed),
              modelCalls: a.modelCalls - b.modelCalls,
              toolCalls: a.toolCalls - b.toolCalls,
              providerUsd: a.providerUsd - b.providerUsd,
              uncachedEquivalentUsd: a.uncachedEquivalentUsd - b.uncachedEquivalentUsd,
            };
          });
          return {
            index,
            ...Object.fromEntries(
              Object.keys(pairs[0]).map((key) => [
                key,
                pairs.reduce((s, p) => s + p[key], 0) / pairs.length,
              ]),
            ),
          };
        });
        return {
          control,
          perCase,
          intervals: Object.fromEntries(
            ["success", "modelCalls", "toolCalls", "providerUsd", "uncachedEquivalentUsd"].map(
              (key) => [key, clusterInterval(perCase.map((r) => r[key]))],
            ),
          ),
        };
      })
    : [];
const output = {
  status: "passed",
  profileName: protocol.profileName,
  adapterRevision: protocol.adapterRevision,
  assignedEpisodes: expected,
  observedEpisodes: episodes.length,
  laneReservationAudit: { status: "passed", peakConcurrent, lanes },
  interfaceGate: interfaceGate(episodes, expected),
  arms,
  episodes,
  comparisons,
  newPaidUsd: complete.provider.spent,
  cumulativeExposureUsd: complete.cumulativeExposureUsd,
  learningBenefitEstablished: false,
  productionActivation: false,
  note: "Audited descriptive data. All assigned failures count; no outcome-based exclusion. Case-cluster intervals do not establish population significance. Counterfactual reminder eligibility uses the same recorded public trajectory without changing actions; private-pair omission is a post-collection diagnostic only. No automatic learning or transfer tested.",
};
console.log(JSON.stringify(output, null, 2));
