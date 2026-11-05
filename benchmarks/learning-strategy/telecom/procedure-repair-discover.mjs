import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StrategyAppendSchema } from "../../../src/memory/learning-strategy-contract.ts";
import { learningHash } from "../../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { createBridge } from "./bridge.mjs";
import { ACTOR, PROPOSER } from "./episode.mjs";
import { forbidden } from "./feedback.mjs";
import {
  sourceFeedback,
  proposalRequest,
  SOURCE_RUN,
  AUTHORIZATION,
  freezeSources,
  checkFreeze,
} from "./procedure-protocol.mjs";
import { createProvider, priorExposure, usageCost, model, hash } from "./provider.mjs";

const [mode, id] = process.argv.slice(2);
assert.ok(["prepare", "run", "audit"].includes(mode) && /^[\w-]+$/.test(id ?? ""));
const results = "benchmarks/learning-strategy/results",
  root = path.join(results, id),
  priorRoot = path.join(results, "telecom-procedure-discovery-v2");
const read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const prior = (n) => JSON.parse(fs.readFileSync(path.join(priorRoot, n), "utf8"));
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
function errors(append, tools) {
  const names = [
    ...new Set(
      append.match(
        /\b(?:get|check|set|toggle|reset|reboot|grant|enable|disable|refuel|run|can|reseat|transfer)_[a-z0-9_]+\b/g,
      ) ?? [],
    ),
  ];
  return {
    characters: append.trim().length,
    overLimit: append.trim().length > 600,
    unknownTools: names.filter((n) => !tools.includes(n)),
  };
}
function requestFor(draft, tools) {
  return {
    messages: [
      {
        role: "user",
        content: `Repair the representation of this learned procedure before any task evaluation. Keep its diagnostic intent and ordering; do not introduce a new troubleshooting hypothesis or use any instance-specific answer. Preserve the unchanged baseline's policy and consent obligations. Compress to at most 500 characters to leave margin under the hard 600-character contract. Use only the available native tool names when naming a tool. Return JSON with only append. There is exactly one repair attempt.\nBaseline: ${ACTOR}\nNative tool names: ${JSON.stringify(tools)}\nValidator findings: ${JSON.stringify(errors(draft, tools))}\nOriginal learned draft: ${draft}`,
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { append: { type: "string" } },
          required: ["append"],
          additionalProperties: false,
        },
      },
    },
  };
}
function checkPrior() {
  const f = prior("freeze.json");
  assert.equal(hash(prior("protocol.json")), f.protocolHash);
  for (const s of f.sources)
    assert.equal(hash(fs.readFileSync(path.join(priorRoot, s.snapshot), "utf8")), s.sha256);
  const p = prior("proposal.json"),
    r = prior(`responses/${p.id}.json`);
  const ledger = fs
    .readFileSync(path.join(priorRoot, "provider.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].id, p.id);
  assert.equal(ledger[1].id, p.id);
  assert.equal(r.status, 200);
  assert.equal(r.response.model, model);
  assert.equal(hash(r.request), ledger[0].promptHash);
  assert.equal(usageCost(r.response.usage), p.cost);
  assert.equal(ledger[1].usd, p.cost);
  const feedback = sourceFeedback(path.join(results, SOURCE_RUN));
  assert.deepEqual(feedback, prior("source-feedback.json"));
  assert.deepEqual(r.request, {
    model,
    max_tokens: 2048,
    ...proposalRequest(feedback.map((x) => x.feedback)),
  });
  assert.deepEqual(
    JSON.parse(
      r.response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    ),
    p.edit,
  );
  assert.ok(p.edit.append.trim().length > 600);
  assert.equal(prior("incomplete.json").provider.unresolved, 0);
  return { freeze: f, proposal: p, feedback };
}
if (mode === "prepare") {
  const verified = checkPrior(),
    bridge = createBridge();
  let tools;
  try {
    const c = await bridge.request({ method: "reset", index: 36 });
    tools = [...new Set([...c.agentTools, ...c.userTools].map((t) => t.function.name))].sort();
  } finally {
    bridge.close();
  }
  const draft = verified.proposal.edit.append,
    request = requestFor(draft, tools);
  assert.ok(Buffer.byteLength(JSON.stringify({ model, max_tokens: 2048, ...request })) <= 140000);
  const protocol = {
    ...prior("protocol.json"),
    pipelineRevision: "one-contract-repair-v3",
    priorAttempt: "telecom-procedure-discovery-v2",
    priorProviderUsd: verified.proposal.cost,
    priorProposalId: verified.proposal.id,
    repairAttempts: 1,
    repairTools: tools,
    repairFindings: errors(draft, tools),
    circuitBreakerUsd: 1,
    amendment:
      "The one-shot candidate exceeded 600 characters and referenced a nonexistent tool. Preserve its rejection. Before any behavioral evaluation, one model repair gets only that draft, mechanical validator findings and the public native tool-name inventory. Same 600-character bound, manual checklist, panels and gates; no task outcomes or private diagnoses added. Both calls count in discovery allocation. Any further contract failure stops this attempt.",
    authorization: AUTHORIZATION,
  };
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  write("source-feedback.json", verified.feedback);
  write("repair-request.json", request);
  const files = [
    ...verified.freeze.sources.map((s) => s.file),
    ...verified.freeze.sources.map((s) => path.join(priorRoot, s.snapshot)),
    "benchmarks/learning-strategy/telecom/procedure-repair-discover.mjs",
    ...[
      "protocol.json",
      "freeze.json",
      "baseline.json",
      "proposal.json",
      "incomplete.json",
      "provider.jsonl",
      `responses/${verified.proposal.id}.json`,
    ].map((n) => path.join(priorRoot, n)),
    ...["source-feedback.json", "repair-request.json"].map((n) => path.join(root, n)),
  ];
  freezeSources(root, protocol, files);
  console.log(
    JSON.stringify({
      status: "prepared",
      findings: protocol.repairFindings,
      promptBytes: Buffer.byteLength(JSON.stringify(request)),
      newProviderCalls: 0,
    }),
  );
} else {
  checkFreeze(root);
  const verified = checkPrior(),
    protocol = read("protocol.json"),
    request = requestFor(verified.proposal.edit.append, protocol.repairTools);
  assert.deepEqual(request, read("repair-request.json"));
  if (mode === "audit") {
    const p = read("proposal.json"),
      r = read(`responses/${p.id}.json`),
      c = read("candidate.json"),
      b = read("baseline.json"),
      complete = read("complete.json");
    const ledger = fs
      .readFileSync(path.join(root, "provider.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].id, p.id);
    assert.equal(ledger[1].id, p.id);
    assert.equal(ledger[0].type, "intent");
    assert.equal(ledger[1].type, "receipt");
    assert.equal(r.status, 200);
    assert.equal(r.response.model, model);
    assert.equal(hash(r.request), ledger[0].promptHash);
    assert.deepEqual(r.request, { model, max_tokens: 2048, ...request });
    assert.deepEqual(ledger[1].usage, r.response.usage);
    assert.equal(usageCost(r.response.usage), p.cost);
    assert.equal(ledger[1].usd, p.cost);
    assert.ok(p.cost <= ledger[0].quote);
    assert.deepEqual(
      JSON.parse(
        r.response.content
          .filter((v) => v.type === "text")
          .map((v) => v.text)
          .join("\n"),
      ),
      p.edit,
    );
    StrategyAppendSchema.parse(p.edit);
    assert.deepEqual(errors(p.edit.append, protocol.repairTools).unknownTools, []);
    assert.ok(!forbidden.test(JSON.stringify(p.edit)));
    assert.equal(c.actor, ACTOR + "\n\n" + p.edit.append.trim());
    assert.equal(c.proposer, PROPOSER);
    assert.deepEqual(c.parents, [learningHash(b)]);
    assert.equal(learningHash(c), complete.candidateHash);
    assert.equal(complete.provider.spent, p.cost);
    assert.equal(complete.discoveryAllocationUsd, p.cost + verified.proposal.cost);
    const db = new DatabaseSync(path.join(root, "source.sqlite"), { readOnly: true }),
      runs = db.prepare("SELECT status,cost FROM learning_runs").all();
    assert.equal(runs.length, 13);
    assert.ok(runs.every((r) => r.status === "settled"));
    assert.equal(
      runs.reduce((s, r) => s + JSON.parse(r.cost).providerUsd, 0),
      p.cost,
    );
    assert.deepEqual(
      db
        .prepare("SELECT feedback FROM strategy_trials ORDER BY rowid")
        .all()
        .map((v) => v.feedback),
      verified.feedback.map((v) => v.feedback),
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM strategy_proposals WHERE child=?").get(learningHash(c)).n,
      1,
    );
    db.close();
    write("audit.json", {
      status: "passed",
      calls: 1,
      priorRejectedCallsVerified: 1,
      exactRequests: true,
      sourceFeedbackReconstructed: true,
      candidateHash: learningHash(c),
      providerUsd: p.cost,
      discoveryAllocationUsd: complete.discoveryAllocationUsd,
    });
    console.log(JSON.stringify(read("audit.json")));
  } else {
    const lockPath = path.join(results, ".collector.lock"),
      lock = fs.openSync(lockPath, "wx");
    fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
    const budget = { providerUsd: 1, toolCalls: 0, wallMs: 600000 },
      service = new ProceduralLearning(
        new ProceduralLearningStore(new DatabaseSync(path.join(root, "source.sqlite")), {
          mode: "shadow",
          executionBudget: budget,
        }),
      ),
      provider = createProvider(root, 1);
    try {
      const exposure = priorExposure(results);
      write("project-budget.json", {
        priorExposure: exposure,
        ceiling: exposure.reduce((s, r) => s + r.usd, 0) + 1,
        authorization: AUTHORIZATION,
      });
      const lab = service.strategies,
        baseline = lab.archive.add(prior("baseline.json"));
      write("baseline.json", lab.archive.get(baseline));
      const zero = { providerUsd: 0, toolCalls: 0, wallMs: 0 };
      lab.registerPanel({
        id: "consumed-source",
        scope: protocol.scope,
        partition: "development",
        sharing: "shareable",
        feedbackLimit: 32000,
        model,
        verifierHash: hash("audited-actor-visible-source-replay-v1"),
        isolation: "sandbox",
        cases: verified.feedback.map((r) => ({ id: r.label, input: { label: r.label } })),
        quote: () => ({ ...zero, wallMs: 10000 }),
        execute: async (_s, i) => ({
          output: verified.feedback.find((r) => r.label === i.label),
          cost: zero,
        }),
        verify: async (_i, r) => ({ passed: r.passed, feedback: r.feedback, cost: zero }),
      });
      await lab.evaluate(baseline, "consumed-source", budget);
      const child = await lab.propose({
        parent: baseline,
        panel: "consumed-source",
        evolveProposer: false,
        editMode: "append",
        fixedProposer: PROPOSER,
        quote: { providerUsd: 1, toolCalls: 0, wallMs: 300000 },
        budget,
        generate: async (_context, signal) => {
          const response = await provider.call(request, {
            tag: "procedure-contract-repair",
            maxTokens: 2048,
            localRemaining: 1,
            signal,
          });
          const text = response.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n"),
            edit = JSON.parse(text);
          write("proposal.json", { id: response.id, edit, cost: response.usd });
          assert.notEqual(response.stopReason, "max_tokens");
          assert.ok(!forbidden.test(text));
          return {
            edit,
            cost: { providerUsd: response.usd, toolCalls: 0, wallMs: response.wallMs },
          };
        },
      });
      assert.deepEqual(
        errors(read("proposal.json").edit.append, protocol.repairTools).unknownTools,
        [],
      );
      write("candidate.json", lab.archive.get(child));
      write("complete.json", {
        status: "complete",
        candidateHash: child,
        baselineHash: baseline,
        provider: provider.status(),
        discoveryAllocationUsd: verified.proposal.cost + provider.status().spent,
      });
      console.log(
        JSON.stringify({
          status: "complete",
          candidate: lab.archive.get(child),
          provider: provider.status(),
          discoveryAllocationUsd: read("complete.json").discoveryAllocationUsd,
        }),
      );
    } catch (error) {
      write("incomplete.json", { error: error.message, provider: provider.status() });
      throw error;
    } finally {
      await service.close();
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
}
