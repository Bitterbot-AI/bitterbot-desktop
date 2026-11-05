import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StrategyRemindersSchema } from "../../../src/memory/learning-strategy-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { MISSING_DIAGNOSTIC_REMINDERS } from "./diagnostic-observations.mjs";
import { DIAGNOSTIC_PROTOCOL } from "./diagnostic-protocol.mjs";
import { createTelecomReminders, REMINDER_FACTS } from "./reminders.mjs";
import { routeRecordedObservations } from "./trace-observations.mjs";

const create = () => createTelecomReminders(MISSING_DIAGNOSTIC_REMINDERS);
const failure = "My messaging app cannot send MMS messages.";
const signal = "Now I'm showing an excellent 5G signal.";
const event = (host, name, args, value) =>
  host.actorTool({ name, arguments: args, content: JSON.stringify(value) }, name);

test("small protocol covers each arm/case once and registers with the existing strategy lab", async () => {
  const { schedule, indices } = DIAGNOSTIC_PROTOCOL;
  assert.equal(schedule.length, 3);
  assert.equal(new Set(schedule.map((s) => `${s.arm}-${s.repetition}`)).size, 3);
  for (const arm of ["baseline", "static", "conditional"]) {
    assert.deepEqual(
      schedule
        .filter((s) => s.arm === arm)
        .flatMap((s) => s.indices)
        .sort((a, b) => a - b),
      indices,
    );
  }
  const budget = { providerUsd: 1, toolCalls: 100, wallMs: 1000 };
  for (const block of schedule) {
    const service = new ProceduralLearning(
      new ProceduralLearningStore(new DatabaseSync(":memory:"), {
        mode: "shadow",
        maxEntries: 20,
        executionBudget: budget,
      }),
    );
    try {
      service.strategies.registerPanel({
        id: block.arm,
        scope: { tool: "test", version: "1", operation: "diagnose", contractHash: "a".repeat(64) },
        partition: "held-out",
        model: "fixture",
        verifierHash: "b".repeat(64),
        isolation: "sandbox",
        reminderFacts: REMINDER_FACTS,
        cases: block.indices.map((index) => ({ id: `case-${index}`, input: { index } })),
        quote: () => budget,
        execute: async () => {
          throw Error("Registration must not execute");
        },
        verify: async () => {
          throw Error("Registration must not verify");
        },
      });
    } finally {
      await service.close();
    }
  }
});

test("missing diagnostic requires a fresh failure, strong signal and unknown allowance", () => {
  StrategyRemindersSchema.parse(MISSING_DIAGNOSTIC_REMINDERS);
  const host = create();
  host.customerSpeech(failure, "before-repair");
  assert.deepEqual(host.take(), []);
  host.actorSpeech('Run set_network_mode_preference(mode: "4g_5g_preferred").');
  host.customerSpeech(signal, "signal");
  assert.deepEqual(host.take(), []);
  host.customerSpeech(failure, "after-repair");
  const hits = host.take();
  assert.deepEqual(
    hits.map((hit) => hit.id),
    ["missing-allowance-check"],
  );
  assert.deepEqual(hits[0].evidence.sort(), ["after-repair", "signal"]);
  assert.deepEqual(host.take(), []);
  host.actorSpeech("Reset the APN settings.");
  host.customerSpeech(failure, "after-reset");
  assert.deepEqual(host.take(), []);
  host.customerSpeech(signal, "new-signal");
  assert.equal(host.take().length, 1);
});

test("negative and contradictory reports cannot establish the diagnostic trigger", () => {
  for (const report of [
    "Now the status bar is showing an excellent 5G signal with mobile data enabled.",
    "Now I'm on 5G with an excellent signal and mobile data is still enabled.",
    "Now it's showing excellent signal strength on 5G.",
    "- **Signal:** Excellent (5G)",
  ]) {
    const host = create();
    host.customerSpeech(report + "\n" + failure, "report");
    assert.equal(host.take().length, 1, report);
  }
  for (const report of [
    "Am I showing an excellent 5G signal?",
    "If I'm showing an excellent 5G signal, would that fix it?",
    'The guide said "I am showing an excellent 5G signal."',
    "Yesterday I was showing an excellent 5G signal.",
    "I'm showing a poor 2G signal.",
    "I have no service.",
    signal + " I'm showing a weak 4G signal.",
  ]) {
    const host = create();
    host.customerSpeech(failure + " " + report, "report");
    assert.deepEqual(host.take(), [], report);
  }
  for (const report of [
    "Can my messaging app send MMS messages?",
    "If my messaging app cannot send MMS messages, what should I do?",
    "My friend says I cannot send MMS messages.",
    "My messaging app can now send MMS messages.",
    failure + " My messaging app can now send MMS messages.",
  ]) {
    const host = create();
    host.customerSpeech(signal, "signal");
    host.customerSpeech(report, "service");
    assert.deepEqual(host.take(), [], report);
  }
  const host = create();
  host.customerSpeech(signal, "signal");
  host.customerSpeech("I have no service.", "signal-lost");
  host.customerSpeech(failure, "service");
  assert.deepEqual(host.take(), []);
});

test("known allowance, line changes and private reports suppress missing-check advice", () => {
  for (const used of [2, 15]) {
    const host = create();
    event(
      host,
      "get_customer_by_phone",
      { phone_number: "555-0001" },
      { customer_id: "C1", line_ids: ["L1", "L2"] },
    );
    event(
      host,
      "get_details_by_id",
      { id: "L1" },
      {
        line_id: "L1",
        phone_number: "555-0001",
        plan_id: "P1",
        data_used_gb: used,
        data_refueling_gb: 0,
      },
    );
    event(host, "get_details_by_id", { id: "P1" }, { plan_id: "P1", data_limit_gb: 10 });
    host.customerSpeech(signal + " " + failure, "known");
    assert.deepEqual(host.take(), []);
    event(
      host,
      "get_customer_by_phone",
      { phone_number: "555-0002" },
      { customer_id: "C1", line_ids: ["L1", "L2"] },
    );
    assert.deepEqual(host.take(), []);
  }
  const result = routeRecordedObservations(
    {
      transcript: [
        {
          seat: "user",
          id: "private",
          content: [
            { type: "text", text: signal + " " + failure },
            { type: "tool_use", name: "check_network_status" },
          ],
        },
        {
          seat: "user",
          type: "tool",
          name: "check_network_status",
          content: signal + " " + failure,
        },
        { seat: "actor", id: "decision", content: [{ type: "text", text: "Check the status." }] },
      ],
    },
    create(),
    {},
  );
  assert.deepEqual(result.hits, []);
});

test("consumed failure is intercepted before repeated device checks and six simple controls stay quiet", () => {
  const root = new URL("../results/telecom-conditional-comparison-v2/", import.meta.url);
  const read = (file) => JSON.parse(fs.readFileSync(new URL(file, root), "utf8"));
  const episode = read("episode-baseline-1-32.json");
  const route = routeRecordedObservations(episode, create(), {}, false);
  assert.equal(route.hits[0]?.beforeTranscriptPosition, 35);
  assert.deepEqual(route.hits[0].matches[0].evidence.sort(), ["speech-18", "speech-34"]);
  for (const arm of ["baseline", "static", "conditional"])
    for (const rep of [0, 1]) {
      assert.deepEqual(
        routeRecordedObservations(read(`episode-${arm}-${rep}-1.json`), create(), {}, false).hits,
        [],
      );
    }
});
