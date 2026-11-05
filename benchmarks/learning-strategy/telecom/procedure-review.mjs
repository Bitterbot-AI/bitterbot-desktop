import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.mjs";
import { hash } from "./provider.mjs";

// Post-collection diagnostics. These probes never reach a model or change a trial outcome.
const root = path.resolve(process.argv[2] ?? "");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const audit = read("audit.json"),
  analysis = read("procedure-analysis.json"),
  freeze = read("freeze.json");
assert.equal(audit.status, "passed");
assert.equal(analysis.status, "passed");
const protocol = read("protocol.json");
assert.equal(protocol.kind, "telecom-procedure-comparison");
assert.equal(
  analysis.episodes.length,
  protocol.indices.length * protocol.arms.length * protocol.repetitions,
);
for (const source of freeze.sources)
  assert.equal(hash(fs.readFileSync(source.file, "utf8")), source.sha256);
const taskFile =
  "benchmarks/learning-strategy/datasets/tau-bench-v2-en/upstream/data/tau2/multilingual/en/telecom_tasks_en.json";
assert.ok(freeze.sources.some((s) => path.resolve(s.file) === path.resolve(taskFile)));
const tasks = JSON.parse(fs.readFileSync(taskFile, "utf8"));
// Classification comes from the pinned native tool decorators, not name guesses.
const toolTypes = new Map();
for (const [seat, file] of [
  ["actor", "tools.py"],
  ["user", "user_tools.py"],
]) {
  const nativePath = `benchmarks/learning-strategy/telecom/vendor/src/tau2/domains/telecom/${file}`;
  assert.ok(freeze.sources.some((s) => path.resolve(s.file) === path.resolve(nativePath)));
  const native = fs.readFileSync(nativePath, "utf8");
  for (const match of native.matchAll(/@is_tool\(ToolType\.(READ|WRITE|GENERIC)\)\s+def (\w+)\(/g))
    toolTypes.set(`${seat}:${match[2]}`, match[1]);
}
assert.equal(toolTypes.get("actor:refuel_data"), "WRITE");
assert.equal(toolTypes.get("actor:transfer_to_human_agents"), "GENERIC");
assert.equal(toolTypes.get("user:can_send_mms"), "READ");
const rows = [];
for (const trial of analysis.episodes) {
  const task = tasks[trial.index],
    episode = read(`episode-${trial.label}.json`),
    tools = episode.transcript.filter((e) => e.type === "tool");
  assert.equal(tools.length, trial.toolCalls);
  for (const tool of tools)
    assert.ok(
      toolTypes.has(`${tool.seat}:${tool.name}`),
      `Unclassified native tool: ${tool.seat}:${tool.name}`,
    );
  const mutations = tools.filter((t) => toolTypes.get(`${t.seat}:${t.name}`) === "WRITE");
  const mutationKeys = new Set(
    mutations.map((t) =>
      JSON.stringify([
        t.seat,
        t.name,
        Object.entries(t.arguments).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    ),
  );
  const row = {
    ...trial,
    taskId: task.id,
    nativeChecks: task.evaluation_criteria.env_assertions.map((check, i) => ({
      ...check,
      passed: episode.verdict.checks[i],
    })),
    toolCounts: Object.fromEntries(
      [...new Set(tools.map((e) => e.name))]
        .sort()
        .map((name) => [name, tools.filter((e) => e.name === name).length]),
    ),
    mutationCalls: mutations.length,
    repeatedMutationCalls: mutations.length - mutationKeys.size,
    mutations: mutations.map((t) => ({
      seat: t.seat,
      name: t.name,
      arguments: t.arguments,
      error: t.error,
    })),
    toolErrors: tools
      .filter((t) => t.error)
      .map((t) => ({ seat: t.seat, name: t.name, arguments: t.arguments, content: t.content })),
    failureState: null,
  };
  if (!trial.passed) {
    const bridge = createBridge();
    try {
      await bridge.request({ method: "reset", index: trial.index });
      for (const tool of tools) {
        const replay = await bridge.request({
          method: "call",
          role: tool.seat === "user" ? "user" : "assistant",
          name: tool.name,
          arguments: tool.arguments,
        });
        assert.equal(replay.content, tool.content);
        assert.equal(replay.error, tool.error);
      }
      assert.deepEqual(await bridge.request({ method: "judge" }), episode.verdict);
      const probes = [];
      const probe = async (role, name, args = {}) => {
        const result = await bridge.request({ method: "call", role, name, arguments: args });
        assert.equal(result.error, false, `${trial.label}: ${name}`);
        probes.push({ role, name, arguments: args, content: result.content });
        return result.content;
      };
      for (const name of [
        "check_network_status",
        "check_network_mode_preference",
        "check_sim_status",
        "check_apn_settings",
        "check_data_restriction_status",
        "check_wifi_calling_status",
        "check_vpn_status",
      ])
        await probe("user", name);
      if (task.id.startsWith("[mms_issue]")) {
        await probe("user", "check_app_permissions", { app_name: "messaging" });
        await probe("user", "can_send_mms");
      }
      const phone = task.initial_state.initialization_actions.find(
        (a) => a.func_name === "set_user_info",
      ).arguments.phone_number;
      const customer = JSON.parse(
        await probe("assistant", "get_customer_by_phone", { phone_number: phone }),
      );
      let affectedLine, plan;
      for (const id of customer.line_ids) {
        const line = JSON.parse(await probe("assistant", "get_details_by_id", { id }));
        if (line.phone_number === phone) {
          affectedLine = line;
          plan = JSON.parse(await probe("assistant", "get_details_by_id", { id: line.plan_id }));
          break;
        }
      }
      assert.ok(affectedLine && plan, `Missing affected line or plan: ${trial.label}`);
      const after = await bridge.request({ method: "judge" });
      for (const key of ["passed", "nativePassed", "checks", "replayMatch", "unrelatedPreserved"])
        assert.deepEqual(after[key], episode.verdict[key]);
      row.failureState = { probes, affectedLine, plan, originalOutcomeUnchanged: true };
    } finally {
      bridge.close();
    }
  }
  rows.push(row);
}
assert.equal(
  rows.reduce((sum, row) => sum + row.modelCalls, 0),
  audit.modelCalls,
);
const cases = [...new Set(rows.map((r) => r.index))].map((index) => ({
  index,
  taskId: tasks[index].id,
  arms: protocol.arms.map((arm) => {
    const group = rows.filter((r) => r.index === index && r.arm === arm);
    return {
      arm,
      episodes: group.length,
      successes: group.filter((r) => r.passed).length,
      mutationCalls: group.reduce((s, r) => s + r.mutationCalls, 0),
      repeatedMutationCalls: group.reduce((s, r) => s + r.repeatedMutationCalls, 0),
      meanModelCalls: group.reduce((s, r) => s + r.modelCalls, 0) / group.length,
    };
  }),
}));
const output = {
  status: "passed",
  postCollectionDiagnostic: true,
  changesFrozenOutcome: false,
  newProviderRequests: 0,
  exporterSnapshot: "source-postcollection-procedure-review.mjs",
  exporterSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")),
  cases,
  arms: protocol.arms.map((arm) => {
    const group = rows.filter((r) => r.arm === arm);
    return {
      arm,
      episodes: group.length,
      mutationCalls: group.reduce((s, r) => s + r.mutationCalls, 0),
      repeatedMutationCalls: group.reduce((s, r) => s + r.repeatedMutationCalls, 0),
      toolErrors: group.reduce((s, r) => s + r.toolErrors.length, 0),
    };
  }),
  failedTrials: rows.filter((r) => !r.passed),
  note: "Post-collection diagnostics, separate from frozen primary analysis. Final-state read-only probes were never available to models and are not repaired outcomes. All assigned trials remain in primary analysis. Mutation counts use native WRITE decorators. Repeated mutation calls repeat the same seat/name/arguments within an episode; counts do not establish redundancy, necessity or consent compliance.",
};
fs.writeFileSync(
  path.join(root, output.exporterSnapshot),
  fs.readFileSync(fileURLToPath(import.meta.url)),
  { flag: "wx" },
);
fs.writeFileSync(
  path.join(root, "trial-data.jsonl"),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { flag: "wx" },
);
fs.writeFileSync(path.join(root, "procedure-review.json"), JSON.stringify(output, null, 2) + "\n", {
  flag: "wx",
});
console.log(
  JSON.stringify({
    status: output.status,
    episodes: rows.length,
    failedTrialsReviewed: output.failedTrials.length,
    newProviderRequests: 0,
  }),
);
