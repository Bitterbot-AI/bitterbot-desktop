import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LearningStrategySchema } from "../../../src/memory/learning-strategy-contract.ts";
import { learningHash } from "../../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { ACTOR, PROPOSER } from "./episode.mjs";
import { forbidden } from "./feedback.mjs";
import {
  SOURCE_RUN,
  CHECKLIST,
  sourceFeedback,
  freezeSources,
  checkFreeze,
} from "./procedure-protocol.mjs";
import { model, hash, usageCost } from "./provider.mjs";

const id = process.argv[2];
assert.ok(/^[\w-]+$/.test(id ?? ""));
const results = "benchmarks/learning-strategy/results",
  root = path.join(results, id),
  priorRoot = path.join(results, "telecom-procedure-discovery-v3");
const prior = (n) => JSON.parse(fs.readFileSync(path.join(priorRoot, n), "utf8"));
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
const freeze = checkFreeze(priorRoot),
  p = prior("proposal.json"),
  raw = prior(`responses/${p.id}.json`),
  priorProtocol = prior("protocol.json");
const ledger = fs
  .readFileSync(path.join(priorRoot, "provider.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(ledger.length, 2);
assert.equal(ledger[0].id, p.id);
assert.equal(ledger[1].id, p.id);
assert.equal(raw.status, 200);
assert.equal(raw.response.model, model);
assert.equal(hash(raw.request), ledger[0].promptHash);
assert.deepEqual(raw.request, { model, max_tokens: 2048, ...prior("repair-request.json") });
assert.equal(usageCost(raw.response.usage), p.cost);
assert.equal(ledger[1].usd, p.cost);
assert.deepEqual(
  JSON.parse(
    raw.response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
  ),
  p.edit,
);
const originalRoot = path.join(results, priorProtocol.priorAttempt),
  originalProposal = JSON.parse(fs.readFileSync(path.join(originalRoot, "proposal.json"), "utf8")),
  originalRaw = JSON.parse(
    fs.readFileSync(path.join(originalRoot, `responses/${originalProposal.id}.json`), "utf8"),
  );
assert.equal(originalRaw.status, 200);
assert.equal(usageCost(originalRaw.response.usage), priorProtocol.priorProviderUsd);
assert.deepEqual(
  JSON.parse(
    originalRaw.response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
  ),
  originalProposal.edit,
);
const append = p.edit.append.trim();
assert.ok(append.length > 600 && append.length <= 800);
assert.ok(CHECKLIST.length <= 800);
assert.ok(!forbidden.test(append));
const names =
  append.match(
    /\b(?:get|check|set|toggle|reset|reboot|grant|enable|disable|refuel|run|can|reseat|transfer)_[a-z0-9_]+\b/g,
  ) ?? [];
assert.ok(names.every((n) => priorProtocol.repairTools.includes(n)));
LearningStrategySchema.shape.actor.parse(ACTOR + "\n\n" + append);
const feedback = sourceFeedback(path.join(results, SOURCE_RUN));
assert.deepEqual(feedback, prior("source-feedback.json"));
const protocol = {
  ...priorProtocol,
  pipelineRevision: "unchanged-draft-800-v4",
  maxAppend: 800,
  priorAttempt: "telecom-procedure-discovery-v3",
  adoptedProposalId: p.id,
  adoptedAppend: append,
  newProviderCalls: 0,
  discoveryAllocationUsd: p.cost + priorProtocol.priorProviderUsd,
  amendment:
    "Before any behavioral evaluation, both advice arms receive an 800-character addition allowance. Use the existing complete-actor API with an exact preserved baseline prefix; adopt the 667-character repaired machine draft unchanged. The original 669-character candidate and 667-character repair remain recorded as rejected under their frozen 600-character contracts. No manual wording edits, new proposal requests or outcome-based selection. All source/fresh/recipient panels and behavioral gates remain unchanged.",
};
fs.mkdirSync(root);
write("protocol.json", protocol);
write("source-feedback.json", feedback);
freezeSources(root, protocol, [
  ...freeze.sources.map((s) => s.file),
  "benchmarks/learning-strategy/telecom/procedure-adopt-draft.mjs",
  ...[
    "protocol.json",
    "baseline.json",
    "proposal.json",
    "incomplete.json",
    "provider.jsonl",
    `responses/${p.id}.json`,
  ].map((n) => path.join(priorRoot, n)),
  path.join(root, "source-feedback.json"),
]);
const budget = { providerUsd: 0, toolCalls: 0, wallMs: 120000 },
  service = new ProceduralLearning(
    new ProceduralLearningStore(new DatabaseSync(path.join(root, "source.sqlite")), {
      mode: "shadow",
      executionBudget: budget,
    }),
  );
try {
  const lab = service.strategies,
    baseline = lab.archive.add(prior("baseline.json")),
    zero = { providerUsd: 0, toolCalls: 0, wallMs: 0 };
  write("baseline.json", lab.archive.get(baseline));
  assert.equal(lab.archive.get(baseline).actor, ACTOR);
  lab.registerPanel({
    id: "consumed-source",
    scope: protocol.scope,
    partition: "development",
    sharing: "shareable",
    feedbackLimit: 32000,
    model,
    verifierHash: hash("audited-actor-visible-source-replay-v1"),
    isolation: "sandbox",
    cases: feedback.map((r) => ({ id: r.label, input: { label: r.label } })),
    quote: () => ({ ...zero, wallMs: 5000 }),
    execute: async (_s, i) => ({ output: feedback.find((r) => r.label === i.label), cost: zero }),
    verify: async (_i, r) => ({ passed: r.passed, feedback: r.feedback, cost: zero }),
  });
  await lab.evaluate(baseline, "consumed-source", budget);
  const child = await lab.propose({
    parent: baseline,
    panel: "consumed-source",
    evolveProposer: false,
    editMode: "replace",
    fixedProposer: PROPOSER,
    quote: { ...zero, wallMs: 10000 },
    budget,
    generate: async (ctx) => {
      assert.deepEqual(
        ctx.feedback,
        feedback.map((r) => r.feedback),
      );
      return { edit: { actor: ACTOR + "\n\n" + append, proposer: PROPOSER }, cost: zero };
    },
  });
  const candidate = lab.archive.get(child);
  assert.equal(candidate.actor, ACTOR + "\n\n" + p.edit.append.trim());
  assert.equal(candidate.proposer, PROPOSER);
  assert.deepEqual(candidate.parents, [baseline]);
  assert.equal(learningHash(candidate), child);
  write("candidate.json", candidate);
  const runs = service.store.db.prepare("SELECT status,cost FROM learning_runs").all();
  assert.equal(runs.length, 13);
  assert.ok(runs.every((r) => r.status === "settled"));
  assert.equal(
    runs.reduce((s, r) => s + JSON.parse(r.cost).providerUsd, 0),
    0,
  );
  write("complete.json", {
    status: "complete",
    candidateHash: child,
    baselineHash: baseline,
    provider: { spent: 0, reserved: 0, unresolved: 0 },
    discoveryAllocationUsd: protocol.discoveryAllocationUsd,
  });
  write("audit.json", {
    status: "passed",
    candidateHash: child,
    sourceFeedbackReconstructed: true,
    unchangedMachineDraft: true,
    baselinePrefixPreserved: true,
    validNativeToolNames: true,
    calls: 0,
    priorProviderCalls: 2,
    priorProviderUsd: protocol.discoveryAllocationUsd,
    sqlRuns: 13,
    sqlProviderUsd: 0,
    additionCharacters: append.length,
    manualAdditionCharacters: CHECKLIST.length,
  });
  checkFreeze(root);
  console.log(
    JSON.stringify({
      status: "complete",
      candidateHash: child,
      additionCharacters: append.length,
      manualAdditionCharacters: CHECKLIST.length,
      discoveryAllocationUsd: protocol.discoveryAllocationUsd,
      actor: candidate.actor,
    }),
  );
} finally {
  await service.close();
}
