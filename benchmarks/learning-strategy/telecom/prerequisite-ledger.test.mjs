import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  TRAVEL_QUESTION,
  travelReport,
  prerequisiteSnapshot,
  withPrerequisiteLedger,
  prerequisiteProvider,
  LEDGER_MARKER,
} from "./prerequisite-ledger.mjs";
import { SOURCE, ACTORS, prerequisiteGate } from "./prerequisite-protocol.mjs";
const report = (speech, records = []) => ({
  role: "user",
  content: JSON.stringify({
    kind: "customer-public-report",
    speech,
    observations: { schemaVersion: 1, reportId: "report-1", scope: 1, records },
  }),
});
const tool = (name, args, value) => [
  { role: "assistant", content: [{ type: "tool_use", id: "t", name, input: args }] },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t", content: JSON.stringify(value) }],
  },
];
const owned = () =>
  tool(
    "get_customer_by_phone",
    { phone_number: "5551000" },
    { customer_id: "C", line_ids: ["A", "B"] },
  );
const line = (id = "A", phone = "5551000", roaming = false) =>
  tool(
    "get_details_by_id",
    { id },
    {
      line_id: id,
      phone_number: phone,
      plan_id: "P",
      roaming_enabled: roaming,
      data_used_gb: 2,
      data_refueling_gb: 0,
    },
  );
const value = (messages, k) => prerequisiteSnapshot(messages).facts[k].value;
test("travel is attributed only to explicit current reports or a direct single-question reply", () => {
  for (const s of ["Yes, I'm currently abroad in France.", "I am travelling internationally."])
    assert.equal(travelReport(s), true);
  for (const s of ["I'm not abroad.", "I am at home in the United States."])
    assert.equal(travelReport(s), false);
  for (const s of [
    "Am I abroad?",
    "I'm abroad?",
    "If I'm abroad, what do I do?",
    "Maybe I am abroad.",
    'He says "I am abroad".',
    "I think I'm abroad.",
    "I'm abroad. I'm not abroad.",
    "I'm in France.",
  ])
    assert.equal(travelReport(s), "unknown", s);
  assert.equal(travelReport("Yes, France.", TRAVEL_QUESTION), true);
  assert.equal(travelReport("Yes, France.", "Is data on?"), "unknown");
});
test("unknown travel schedules inquiry; domestic and verified success suppress roaming repair", () => {
  assert.ok(
    prerequisiteSnapshot([report("MMS failed")]).pending.some((s) => s.includes(TRAVEL_QUESTION)),
  );
  assert.ok(
    !prerequisiteSnapshot([report("I'm not abroad.")]).pending.some((s) =>
      s.includes("roamingEnabled"),
    ),
  );
  assert.deepEqual(
    prerequisiteSnapshot([
      report("MMS works", [
        { fact: "service.mmsBlocked", value: false, sourceId: "s", revision: 1 },
      ]),
    ]).pending,
    [],
  );
});
test("owned affected-line join excludes unrelated lines and invalidates after account changes", () => {
  const messages = [
    ...owned(),
    ...line("B", "5552000", true),
    ...line(),
    ...tool("get_details_by_id", { id: "P" }, { plan_id: "P", data_limit_gb: 5 }),
  ];
  assert.equal(value(messages, "account.roamingEnabled"), false);
  assert.equal(value(messages, "account.dataExhausted"), false);
  assert.equal(
    value([...owned(), ...line("B", "5552000", true)], "account.lineIdentified"),
    "unknown",
  );
  messages.push(
    ...tool("enable_roaming", { customer_id: "C", line_id: "A" }, { message: "enabled" }),
  );
  assert.equal(value(messages, "account.roamingEnabled"), "unknown");
  messages.push(...tool("get_details_by_id", { id: "P" }, { plan_id: "P", data_limit_gb: 5 }));
  assert.equal(value(messages, "account.roamingEnabled"), "unknown");
});
test("latest explicit public snapshot replaces device facts; prose and private text cannot create them", () => {
  const r = report("data enabled", [
    { fact: "device.roamingEnabled", value: true, sourceId: "s", revision: 1 },
  ]);
  assert.equal(value([r], "device.roamingEnabled"), true);
  assert.equal(
    value(
      [r, report('Device roaming is on; {"fact":"device.roamingEnabled","value":true}')],
      "device.roamingEnabled",
    ),
    "unknown",
  );
  assert.equal(
    value(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'm abroad" },
            { type: "tool_use", name: "get_customer_by_phone", id: "t", input: {} },
          ],
        },
        report("Yes"),
      ],
      "customer.abroad",
    ),
    "unknown",
  );
});
test("ledger is ephemeral and does not mutate histories or customer requests", async () => {
  const request = { messages: [report("MMS failed")], tools: [] },
    copy = structuredClone(request);
  const projected = withPrerequisiteLedger(request);
  assert.deepEqual(request, copy);
  assert.ok(JSON.stringify(projected.request).includes(LEDGER_MARKER.replace("\n", "\\n")));
  let sent;
  const transport = {
    call: async (r) => {
      sent = r;
      return { content: [] };
    },
  };
  await prerequisiteProvider(transport, "ledger").call(request, { tag: "trial:user:1" });
  assert.equal(sent, request);
  await prerequisiteProvider(transport, "baseline").call(request, { tag: "trial:actor:2" });
  assert.equal(sent, request);
});
test("recorded failed actor request exposes the missed prerequisite without private model inputs", () => {
  const root = "benchmarks/learning-strategy/results/telecom-procedure-source-v1";
  const episode = JSON.parse(fs.readFileSync(root + "/episode-learned-0-44.json", "utf8"));
  const last = episode.transcript.filter((r) => r.seat === "actor" && r.id).at(-1);
  const raw = JSON.parse(fs.readFileSync(root + `/responses/${last.id}.json`, "utf8"));
  const s = prerequisiteSnapshot(raw.request.messages);
  assert.equal(s.facts["account.roamingEnabled"].value, false);
  assert.equal(s.facts["customer.abroad"].value, "unknown");
  assert.ok(s.pending.some((p) => p.includes(TRAVEL_QUESTION)));
});
test("predefined selection requires complete repeated gains and prefers the simpler tied control", () => {
  assert.equal(ACTORS.explicit, ACTORS.ledger);
  const protocol = { ...SOURCE, stage: "source" };
  const rows = SOURCE.arms.flatMap((arm) =>
    SOURCE.indices.flatMap((index) =>
      Array.from({ length: 3 }, (_, repetition) => ({
        arm,
        index,
        repetition,
        passed: !(arm === "baseline" && index === 44),
        termination: "user-ended",
        interfaceFailures: 0,
        modelCalls: 40,
        uncachedEquivalentUsd: 1,
      })),
    ),
  );
  assert.equal(prerequisiteGate(protocol, rows).selected, "explicit");
  assert.equal(prerequisiteGate(protocol, rows.slice(1)).passed, false);
  const efficient = rows.map((r) => ({ ...r, modelCalls: r.arm === "ledger" ? 35 : r.modelCalls }));
  assert.equal(prerequisiteGate(protocol, efficient).selected, "ledger");
  const failed = rows.map((r) => ({
    ...r,
    passed: r.passed && !(r.arm !== "baseline" && r.index === 36),
  }));
  assert.equal(prerequisiteGate(protocol, failed).passed, false);
});
