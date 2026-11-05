import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hash } from "./rediscovery2-provider.mjs";

const root = path.resolve(process.argv[2] ?? ""),
  read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8")),
  sha = (n) => hash(fs.readFileSync(path.join(root, n), "utf8"));
const p = read("protocol.json"),
  complete = read("complete.json"),
  audit = read("audit.json"),
  context = read("public-context.json");
assert.equal(audit.status, "passed");
assert.equal(audit.completeHash, sha("complete.json"));
const receipts = fs
    .readFileSync(path.join(root, "provider.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((r) => r.type === "receipt"),
  rm = new Map(receipts.map((r) => [r.id, r]));
const uncached = (r) => {
  const u = r.usage;
  return (
    ((u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) *
      3 +
      u.output_tokens * 15) /
    1e6
  );
};
const rows = [...p.assignments, ...p.panelAssignments].map((a) => {
  const filename = `attempt-${a.label}.json`,
    t = read(filename),
    actions = t.result.events.filter((e) => e.type === "action"),
    observations = actions.filter((e) => e.status === "returned"),
    mms = observations.filter((e) => e.action.tool === "user.can_send_mms"),
    last = mms.at(-1);
  const outcome = last
    ? last.response.content === "Your messaging app can send MMS messages."
    : null;
  const writes = actions.filter(
    (e) => context.tools.find((tool) => tool.tool === e.action.tool)?.effect === "WRITE",
  );
  const invalid = actions.filter((e) => {
    const args = JSON.parse(e.action.argumentsJson);
    return (
      (args.customer_id && args.customer_id !== t.bindings?.customerId) ||
      (args.line_id && args.line_id !== t.bindings?.lineId)
    );
  });
  return {
    ...a,
    beforePassed: t.result.beforePassed,
    afterPassed: t.result.afterPassed,
    status: t.result.status,
    interfaceError: t.result.error ?? null,
    procedureStatus: t.procedureState?.status ?? null,
    selfVerified: t.procedureState?.selfVerified ?? null,
    bindingAbstention: !!t.bindingError,
    ...t.cost,
    uncachedEquivalentUsd: t.calls.reduce((s, c) => s + uncached(rm.get(c.id)), 0),
    writes: writes.length,
    writeTools: writes.map((e) => e.action.tool),
    wrongEntityActions: invalid.length,
    toolErrors: observations.filter((e) => e.response.error).length,
    invalidSubmissions: t.result.events.filter((e) => e.type === "rejection").length,
    publicServiceResult: outcome,
    serviceGradeDisagreement: outcome !== null && outcome !== t.result.afterPassed,
    falseSelfVerification: t.procedureState?.selfVerified === true && t.result.afterPassed !== true,
    attemptHash: sha(filename),
  };
});
const artifacts = read("artifacts.json").artifacts;
const byCandidate = artifacts.map((a) => {
  const compiled = rows.filter(
      (r) => r.scope === "primary" && r.candidate === a.candidate && r.arm === "compiled",
    ),
    advice = rows.filter(
      (r) => r.scope === "primary" && r.candidate === a.candidate && r.arm === "advice",
    );
  const success = (rs) => rs.filter((r) => r.afterPassed === true).length;
  const additional = rows.filter((r) => r.scope === "panel" && r.candidate === a.candidate);
  const failureKinds = {};
  for (const r of additional.filter((r) => r.beforePassed === false && r.afterPassed !== true)) {
    const k = r.bindingAbstention ? "identity-abstention" : (r.procedureStatus ?? r.status);
    failureKinds[k] = (failureKinds[k] ?? 0) + 1;
  }
  return {
    candidate: a.candidate,
    valid: a.valid,
    generationUsd: a.generationUsd,
    compiledRepairs: success(compiled),
    adviceRepairs: success(advice),
    assignedEach: compiled.length,
    compiledMinusAdvice: success(compiled) - success(advice),
    additionalUnrepaired: failureKinds,
    perCase: p.inputs.map((i) => ({
      index: i.index,
      compiled: success(compiled.filter((r) => r.index === i.index)),
      advice: success(advice.filter((r) => r.index === i.index)),
    })),
    adviceUncachedEquivalentUsd: advice.reduce((s, r) => s + r.uncachedEquivalentUsd, 0),
  };
});
const review = {
  assignments: rows.length,
  interfaceErrors: rows
    .filter((r) => r.interfaceError)
    .map((r) => ({ label: r.label, error: r.interfaceError })),
  wrongEntityActions: rows.reduce((s, r) => s + r.wrongEntityActions, 0),
  toolErrors: rows.reduce((s, r) => s + r.toolErrors, 0),
  invalidSubmissions: rows.reduce((s, r) => s + r.invalidSubmissions, 0),
  serviceChecks: rows.filter((r) => r.publicServiceResult !== null).length,
  serviceGradeDisagreements: rows.filter((r) => r.serviceGradeDisagreement).map((r) => r.label),
  falseSelfVerifications: rows.filter((r) => r.falseSelfVerification).map((r) => r.label),
  writeTools: [...new Set(rows.flatMap((r) => r.writeTools))],
};
const analysis = {
  status: "complete",
  protocolHash: sha("protocol.json"),
  auditHash: sha("audit.json"),
  completeHash: sha("complete.json"),
  summary: complete.summary,
  panel: complete.panel,
  gatePassed: complete.gatePassed,
  byCandidate,
  review,
  providerUsd: receipts.reduce((s, r) => s + r.usd, 0),
  uncachedEquivalentUsd: receipts.reduce((s, r) => s + uncached(r), 0),
  cumulativeExposureUsd: complete.cumulativeExposureUsd,
  interpretation:
    "Two procedure generations from one prior discovery history; four consumed case clusters. Compiled repetitions are deterministic. Additional44 states are also previously consumed, including28 failed/16 healthy, and are not44 new tasks. Compiled execution removes inference by design; no claim that model weights or general capability improved. All assignments, identity abstentions and failures retained.",
};
for (const [name, value] of [
  ["analysis.json", JSON.stringify(analysis, null, 2) + "\n"],
  ["trials.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n"],
])
  fs.writeFileSync(path.join(root, name), value, { flag: "wx" });
fs.copyFileSync(
  new URL(import.meta.url),
  path.join(root, "analysis-source.mjs"),
  fs.constants.COPYFILE_EXCL,
);
console.log(JSON.stringify(analysis, null, 2));
