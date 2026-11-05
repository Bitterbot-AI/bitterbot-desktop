import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBridge } from "./bridge.mjs";
import { actorContext, ACTOR, runEpisode } from "./episode.mjs";
import { projectFeedback } from "./feedback.mjs";
import { customerGroundingIssue } from "./grounding.mjs";
import { createProvider, usageCost, model, priorExposure } from "./provider.mjs";
import { createTelecomReminders, CONDITIONAL_REMINDERS } from "./reminders.mjs";
import { routeRecordedObservations } from "./trace-observations.mjs";

function accountEvent(host, name, args, value, evidence = name) {
  host.actorTool({ name, arguments: args, content: JSON.stringify(value), error: false }, evidence);
}
function identify(host, customer = "C1", phone = "555-000-0001", lines = ["L1", "L2"]) {
  accountEvent(
    host,
    "get_customer_by_phone",
    { phone_number: phone },
    { customer_id: customer, phone_number: "555-999-9999", line_ids: lines },
  );
}
function lineRecord(host, id = "L1", phone = "555-000-0001", overrides = {}) {
  accountEvent(
    host,
    "get_details_by_id",
    { id },
    {
      line_id: id,
      phone_number: phone,
      plan_id: "P1",
      data_used_gb: 15,
      data_refueling_gb: 0,
      roaming_enabled: false,
      ...overrides,
    },
    `line-${id}`,
  );
}

test("native tools enforce roles, reject hidden methods, and reset state", async () => {
  const b = createBridge();
  try {
    const context = await b.request({ method: "reset", index: 0 });
    const actor = JSON.stringify(actorContext(context, ACTOR));
    assert.ok(
      !actor.includes("userScenario") &&
        !actor.includes("Mamadou") &&
        !actor.includes("[mobile_data_issue]"),
    );
    assert.ok(actor.includes("get_customer_by_phone"));
    assert.equal((await b.request({ method: "judge" })).passed, false);
    for (const [role, name, args] of [
      ["assistant", "toggle_airplane_mode", {}],
      ["user", "assert_internet_speed", { expected_speed: "excellent" }],
    ])
      assert.equal((await b.request({ method: "call", role, name, arguments: args })).error, true);
    for (const name of ["toggle_airplane_mode", "toggle_data"])
      assert.equal(
        (await b.request({ method: "call", role: "user", name, arguments: {} })).error,
        false,
      );
    const repaired = await b.request({ method: "judge" });
    assert.equal(repaired.passed, true);
    assert.equal(repaired.replayMatch, true);
    await b.request({ method: "reset", index: 0 });
    assert.equal((await b.request({ method: "judge" })).passed, false);
    await assert.rejects(b.request({ method: "reset", index: 16 }), /Only environment/);
  } finally {
    b.close();
  }
});

test("cache pricing distinguishes five-minute and hour writes", () => {
  assert.equal(
    usageCost({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 100 },
    }),
    0.004875,
  );
  assert.throws(() => usageCost({ input_tokens: NaN, output_tokens: 1 }), /usage/);
});

test("reminders reuse explicit settings and invalidate them after possible mutations", () => {
  const host = createTelecomReminders(CONDITIONAL_REMINDERS);
  host.customerSpeech("Status bar: No Signal | Data Disabled", "speech-1");
  assert.deepEqual(
    host.take().map((r) => r.id),
    ["ambiguous-data-status"],
  );
  host.customerSpeech("Mobile Data Enabled: Yes\nData Disabled", "speech-2");
  assert.deepEqual(
    host.take().map((r) => r.id),
    ["data-already-enabled"],
  );
  host.customerSpeech("Mobile Data Enabled: Yes\nData Disabled", "speech-3");
  assert.deepEqual(host.take(), []);
  host.actorSpeech("Please reboot the device.");
  host.customerSpeech("Status bar: Data Disabled", "speech-4");
  assert.deepEqual(
    host.take().map((r) => r.id),
    ["ambiguous-data-status"],
  );
  host.customerSpeech("Mobile Data Enabled: Yes\nMobile Data Enabled: No", "conflict");
  assert.ok(!host.take().some((r) => r.id === "data-already-enabled"));
  const uncertain = createTelecomReminders(CONDITIONAL_REMINDERS);
  uncertain.customerSpeech("Maybe Mobile Data Enabled: Yes? Data Disabled", "uncertain");
  assert.deepEqual(
    uncertain.take().map((r) => r.id),
    ["ambiguous-data-status"],
  );
});

test("allowance reminders account for refuels and cannot retain another customer's state", () => {
  const host = createTelecomReminders(CONDITIONAL_REMINDERS);
  host.customerSpeech("My mobile data is broken", "complaint");
  identify(host);
  lineRecord(host);
  const account = (data, evidence) =>
    host.actorTool(
      {
        name: "get_data_usage",
        arguments: { customer_id: data.customer_id, line_id: data.line_id },
        error: false,
        content: JSON.stringify(data),
      },
      evidence,
    );
  account(
    {
      customer_id: "C1",
      line_id: "L1",
      data_used_gb: "15",
      data_limit_gb: "15",
      data_refueling_gb: "1",
    },
    "refueled",
  );
  assert.deepEqual(host.take(), []);
  account(
    {
      customer_id: "C1",
      line_id: "L1",
      data_used_gb: "16",
      data_limit_gb: "15",
      data_refueling_gb: "1",
    },
    "exhausted",
  );
  assert.deepEqual(
    host.take().map((r) => r.id),
    ["observed-data-exhaustion"],
  );
  identify(host, "C2", "555-000-0002", ["L2"]);
  lineRecord(host, "L2", "555-000-0002");
  account(
    { customer_id: "C2", line_id: "L2", data_used_gb: 0, data_limit_gb: 15, data_refueling_gb: 0 },
    "other",
  );
  assert.deepEqual(host.take(), []);
});

test("travel reports distinguish current observations from questions, quotes and hypothetical trips", () => {
  for (const text of [
    "I'm currently abroad in France.",
    "I’m still abroad.",
    "I am traveling internationally.",
    "I'm actually currently in France, so I'm abroad.",
  ]) {
    const host = createTelecomReminders(CONDITIONAL_REMINDERS);
    host.customerSpeech(`My MMS fails. ${text}`, "public");
    assert.deepEqual(
      host.take().map((r) => r.id),
      ["abroad-prerequisites"],
    );
    host.customerSpeech(text, "duplicate");
    assert.deepEqual(host.take(), []);
    host.customerSpeech("I'm no longer abroad.", "returned");
    assert.deepEqual(host.take(), []);
    host.customerSpeech(text, "new-trip");
    assert.equal(host.take()[0].id, "abroad-prerequisites");
  }
  for (const text of [
    "I'm not abroad.",
    "Am I abroad?",
    "I'm abroad?",
    "If I'm abroad, what should I do?",
    "I'm abroad if this is France.",
    "If I'm in France, so I'm abroad.",
    "The screen says I'm in France, so I'm abroad.",
    "You said: I'm abroad.",
    'The screen says "I am abroad".',
    "I'm traveling internationally tomorrow.",
    "I was abroad.",
    "I'm abroad. I'm not abroad.",
  ]) {
    const host = createTelecomReminders(CONDITIONAL_REMINDERS);
    host.customerSpeech(`MMS fails. ${text}`, "uncertain");
    assert.deepEqual(host.take(), [], text);
  }
});

test("line and plan joins follow the requested phone, not inspection order or primary contact", () => {
  const host = createTelecomReminders(CONDITIONAL_REMINDERS);
  host.customerSpeech("My MMS fails", "complaint");
  identify(host);
  // The requested phone is not the primary phone. Another owned line is irrelevant.
  lineRecord(host, "L2", "555-999-9999", { data_used_gb: 999, plan_id: "P2" });
  accountEvent(host, "get_details_by_id", { id: "P2" }, { plan_id: "P2", data_limit_gb: 1 });
  assert.deepEqual(host.take(), []);
  accountEvent(
    host,
    "get_details_by_id",
    { id: "P1" },
    { plan_id: "P1", data_limit_gb: 15 },
    "plan-P1",
  );
  assert.deepEqual(host.take(), []);
  lineRecord(host);
  const matches = host.take();
  assert.deepEqual(
    matches.map((r) => r.id),
    ["observed-data-exhaustion"],
  );
  assert.ok(matches[0].evidence.some((ref) => ref.includes("line-L1") && ref.includes("plan-P1")));
  lineRecord(host, "L2", "555-999-9999");
  assert.deepEqual(host.take(), [], "Inspecting another line must not rearm current facts");
});

test("refueling invalidates cached joins until fresh usage arrives; malformed values stay unknown", () => {
  const host = createTelecomReminders(CONDITIONAL_REMINDERS);
  host.customerSpeech("My MMS fails", "complaint");
  identify(host);
  lineRecord(host);
  accountEvent(host, "get_details_by_id", { id: "P1" }, { plan_id: "P1", data_limit_gb: 15 });
  assert.equal(host.take()[0].id, "observed-data-exhaustion");
  accountEvent(
    host,
    "refuel_data",
    { customer_id: "C1", line_id: "L1", gb_amount: 2 },
    { new_data_refueling_gb: 2 },
  );
  accountEvent(host, "get_details_by_id", { id: "P1" }, { plan_id: "P1", data_limit_gb: 15 });
  assert.deepEqual(host.take(), [], "An unrelated read must not revive pre-refill usage");
  accountEvent(
    host,
    "get_data_usage",
    { customer_id: "C1", line_id: "L2" },
    { line_id: "L2", data_used_gb: 99, data_limit_gb: 15, data_refueling_gb: 0 },
  );
  assert.deepEqual(host.take(), [], "Another line's exhaustion must not become the target's fact");
  for (const limit of [null, "", -1, "NaN"]) {
    accountEvent(
      host,
      "get_data_usage",
      { customer_id: "C1", line_id: "L1" },
      { line_id: "L1", data_used_gb: 15, data_limit_gb: limit, data_refueling_gb: 0 },
    );
    assert.deepEqual(host.take(), []);
  }
  accountEvent(
    host,
    "get_data_usage",
    { customer_id: "C1", line_id: "L1" },
    { line_id: "L1", data_used_gb: 15, data_limit_gb: 15, data_refueling_gb: 2 },
  );
  assert.deepEqual(host.take(), []);
  accountEvent(
    host,
    "get_data_usage",
    { customer_id: "C1", line_id: "L1" },
    { line_id: "L1", data_used_gb: 17, data_limit_gb: 15, data_refueling_gb: 2 },
  );
  assert.equal(host.take()[0].id, "observed-data-exhaustion");
});

test("a phone change resets prior device and customer observations even within one account", () => {
  const host = createTelecomReminders(CONDITIONAL_REMINDERS);
  identify(host);
  lineRecord(host);
  host.customerSpeech(
    "I'm currently abroad. My MMS fails.\nMobile Data Enabled: Yes\nData Disabled",
    "old",
  );
  assert.ok(host.take().length);
  identify(host, "C1", "555-000-0002");
  lineRecord(host, "L2", "555-000-0002");
  assert.deepEqual(host.take(), []);
  host.customerSpeech("Data Disabled", "new");
  assert.deepEqual(
    host.take().map((r) => r.id),
    ["ambiguous-data-status"],
  );
  host.customerSpeech("Mobile Data Enabled: Yes\nData Disabled", "confirmed");
  host.take();
  host.actorSpeech("Please run toggle_data().");
  host.customerSpeech("Data Disabled", "changed");
  assert.deepEqual(
    host.take().map((r) => r.id),
    ["ambiguous-data-status"],
  );
});

test("birth date grounding uses declared knowledge, never persona age or invented identities", () => {
  const scenario = {
    persona: "41 years old; born on March 15, 1983",
    instructions: { known_info: "Name and phone only" },
  };
  assert.equal(
    customerGroundingIssue(scenario, "I was born on March 15, 1983."),
    "unsupported-birth-date",
  );
  assert.equal(customerGroundingIssue(scenario, "I don't have my date of birth available."), null);
  assert.equal(customerGroundingIssue(scenario, "The appointment is March 15, 1983."), null);
  scenario.instructions.known_info = "Your date of birth is 1985-06-15.";
  assert.equal(customerGroundingIssue(scenario, "My birthday is June 15th, 1985."), null);
  assert.equal(
    customerGroundingIssue(scenario, "DOB: 1985-06-15. My birthday is June 16, 1985."),
    "unsupported-birth-date",
  );
});

test("offline routing preserves private tool boundaries and never adds post-termination advice", () => {
  const response = (id, seat, text, calls = []) => ({
    id,
    seat,
    content: [
      { type: "text", text },
      ...calls.map((name) => ({ type: "tool_use", name, input: {} })),
    ],
  });
  const episode = {
    transcript: [
      response("private", "user", "Data Disabled. I was born on March 15, 1983.", [
        "check_network_status",
      ]),
      { type: "tool", seat: "user", name: "check_network_status", content: "Data Disabled" },
      response("neutral", "user", "Please help me."),
      response("actor-1", "actor", "What does the status bar show?"),
      response("public", "user", "Data Disabled"),
      response("actor-2", "actor", "Let's inspect it."),
      response("done", "user", "I'm currently abroad. MMS fails.", ["end_conversation"]),
      response("unreachable", "actor", "This never happened."),
    ],
  };
  const result = routeRecordedObservations(
    episode,
    createTelecomReminders(CONDITIONAL_REMINDERS),
    {},
  );
  assert.equal(result.groundingFailure, null);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].beforeTranscriptPosition, 5);
  assert.deepEqual(
    result.hits[0].matches.map((r) => r.id),
    ["ambiguous-data-status"],
  );
});

test("ungrounded customer speech stops before actor delivery, remains charged and is excluded from feedback", async () => {
  for (const terminal of [false, true]) {
    let calls = 0;
    const episode = await runEpisode({
      index: 42,
      tag: "grounding",
      provider: {
        async call() {
          calls++;
          assert.equal(calls, 1, "No retry or actor request may follow a grounding failure");
          return {
            id: "fabrication",
            usd: 0.01,
            stopReason: "end_turn",
            content: [
              { type: "text", text: "I was born on March 15, 1983." },
              ...(terminal
                ? [{ type: "tool_use", name: "end_conversation", input: {}, id: "end" }]
                : []),
            ],
          };
        },
      },
    });
    assert.equal(episode.reason, "simulator-grounding-failure");
    assert.equal(episode.calls, 1);
    assert.equal(episode.cost.providerUsd, 0.01);
    assert.equal(episode.cost.toolCalls, 0);
    assert.deepEqual(episode.publicConversation, []);
    assert.equal(episode.transcript.at(-1).issue, "unsupported-birth-date");
    const feedback = projectFeedback(episode);
    assert.equal(feedback.simulationValid, false);
    assert.equal(feedback.passed, false);
    assert.ok(!JSON.stringify(feedback).includes("1983"));
  }
});

test("episode reminder routing sees only public customer speech, never private tool responses", async () => {
  for (const visible of [false, true]) {
    let calls = 0;
    const episode = await runEpisode({
      index: 0,
      reminders: CONDITIONAL_REMINDERS,
      tag: "boundary",
      observationMode: "legacy-text",
      provider: {
        async call(request) {
          calls++;
          let content;
          if (calls === 1)
            content = [
              { type: "text", text: "Data Disabled PRIVATE" },
              { type: "tool_use", id: "private-check", name: "check_network_status", input: {} },
            ];
          else if (calls === 2)
            content = [
              {
                type: "text",
                text: visible ? "The status bar says Data Disabled." : "I need help.",
              },
            ];
          else {
            assert.equal(JSON.stringify(request.messages).includes("Host reminders"), visible);
            assert.ok(!JSON.stringify(request.messages).includes("PRIVATE"));
            content = [
              {
                type: "tool_use",
                id: "handoff",
                name: "transfer_to_human_agents",
                input: { summary: "End test" },
              },
            ];
          }
          return { id: `mock-${calls}`, usd: 0, content, stopReason: "end_turn" };
        },
      },
    });
    assert.equal(calls, 3);
    assert.equal(episode.transcript.filter((r) => r.type === "reminder").length, Number(visible));
    assert.equal(episode.reason, "human-transfer");
  }
});

test("successful human handoff ends immediately without farewell loops or later writes", async () => {
  let calls = 0;
  const episode = await runEpisode({
    index: 0,
    tag: "terminal-control",
    conversationCache: true,
    provider: {
      async call(request) {
        assert.deepEqual(request.cache_control, { type: "ephemeral" });
        calls++;
        assert.ok(calls <= 2, "No model call is permitted after handoff");
        return {
          id: `fixture-${calls}`,
          usd: 0,
          content:
            calls === 1
              ? [{ type: "text", text: "My mobile data is broken." }]
              : [
                  {
                    type: "tool_use",
                    id: "handoff",
                    name: "transfer_to_human_agents",
                    input: { summary: "Unresolved connection issue" },
                  },
                  { type: "tool_use", id: "must-not-run", name: "refuel_data", input: {} },
                ],
          stopReason: calls === 1 ? "end_turn" : "tool_use",
        };
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(episode.reason, "human-transfer");
  assert.equal(episode.cost.toolCalls, 1);
  assert.equal(episode.verdict.passed, false);
});

test("development evidence preserves dialogue while excluding private user state and post-handoff chatter", () => {
  const speech = (seat, text, calls = []) => ({
    seat,
    content: [{ type: "text", text }, ...calls],
  });
  const projected = projectFeedback({
    verdict: { passed: false, checks: ["HIDDEN_ASSERTION"] },
    reason: "budget-limit",
    transcript: [
      speech("user", "Mamadou Diallo at 555-123-2002: device roaming is off."),
      speech("user", "PRIVATE_USER_REASONING", [
        { type: "tool_use", name: "check_network_status" },
      ]),
      { type: "tool", seat: "user", name: "check_network_status", content: "PRIVATE_STATE" },
      {
        type: "tool",
        seat: "actor",
        name: "get_line",
        error: false,
        content: JSON.stringify({
          data_used_gb: 15,
          full_name: "Mamadou Diallo",
          line_id: "L1001",
        }),
      },
      speech("actor", "Please enable device roaming."),
      {
        type: "tool",
        seat: "actor",
        name: "transfer_to_human_agents",
        error: false,
        content: "OK",
      },
      speech("user", "POST_HANDOFF_CHATTER"),
    ],
  });
  assert.equal(projected.termination, "human-transfer");
  const text = JSON.stringify(projected);
  assert.ok(text.includes("device roaming is off") && text.includes("data_used_gb"));
  assert.ok(!/Mamadou|555-|L1001|PRIVATE|HIDDEN|POST_HANDOFF/.test(text));
  assert.equal(projected.timeline.length, 4);
});

test("paid requests reserve before dispatch, settle usage and retain failures", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "tau-ledger-"));
  const root = path.join(parent, "study");
  fs.mkdirSync(root);
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fixture-key";
  let calls = 0;
  try {
    const provider = createProvider(root, 1, async () => {
      calls++;
      const rows = fs
        .readFileSync(path.join(root, "provider.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(rows.at(-1).type, "intent");
      if (calls === 2) throw Error("network failure");
      return Response.json({
        model,
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      });
    });
    await assert.rejects(provider.call({ messages: [] }, { localRemaining: 0 }), /ceiling/);
    assert.equal(calls, 0);
    const result = await provider.call({ messages: [{ role: "user", content: "synthetic" }] });
    assert.equal(result.usd, 0.0006);
    await assert.rejects(provider.call({ messages: [] }), /network failure/);
    await assert.rejects(provider.call({ messages: [] }), /unresolved/);
    const rows = priorExposure(parent);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].unresolved, true);
    assert.ok(rows[1].usd > 0);
    assert.ok(!fs.readFileSync(path.join(root, "provider.jsonl"), "utf8").includes("fixture-key"));
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
