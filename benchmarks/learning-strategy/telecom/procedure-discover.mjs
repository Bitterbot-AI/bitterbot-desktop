import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StrategyAppendSchema } from "../../../src/memory/learning-strategy-contract.ts";
import { learningHash } from "../../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { ACTOR, PROPOSER, ADAPTER_REVISION } from "./episode.mjs";
import { forbidden } from "./feedback.mjs";
import {
  SOURCE_RUN,
  STAGES,
  CHECKLIST,
  AUTHORIZATION,
  sourceFeedback,
  proposalRequest,
  checkFreeze,
  freezeSources,
} from "./procedure-protocol.mjs";
import { createProvider, priorExposure, hash, model, rates, usageCost } from "./provider.mjs";

const [mode, id] = process.argv.slice(2);
assert.ok(["prepare", "run", "audit"].includes(mode) && /^[\w-]+$/.test(id ?? ""));
const results = "benchmarks/learning-strategy/results",
  root = path.join(results, id),
  sourceRoot = path.join(results, SOURCE_RUN);
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const codeFiles = [
  "procedure-protocol.mjs",
  "procedure-protocol.test.mjs",
  "procedure-discover.mjs",
  "procedure-study.mjs",
  "procedure-audit.mjs",
  "procedure-analyze.mjs",
].map((n) => "benchmarks/learning-strategy/telecom/" + n);
if (mode === "prepare") {
  const originalFreeze = checkFreeze(sourceRoot);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sourceRoot, "audit.json"), "utf8")).status,
    "passed",
  );
  const feedback = sourceFeedback(sourceRoot);
  assert.equal(feedback.length, 12);
  const preparedRequest = proposalRequest(feedback.map((r) => r.feedback));
  assert.ok(
    Buffer.byteLength(JSON.stringify({ model, max_tokens: 2048, ...preparedRequest })) <= 140000,
    "Proposal exceeds provider payload bound before acquisition",
  );
  assert.ok(CHECKLIST.length <= 600);
  const native = JSON.parse(
    fs.readFileSync("benchmarks/learning-strategy/telecom/native-sources.json", "utf8"),
  );
  const protocol = {
    kind: "telecom-procedure-discovery",
    projectionRevision: "public-snapshot-values-v2",
    sourceRun: SOURCE_RUN,
    adapterRevision: ADAPTER_REVISION,
    model,
    rates,
    stages: STAGES,
    manualChecklist: CHECKLIST,
    maxAppend: 600,
    candidates: 1,
    evolveProposer: false,
    scope: {
      tool: "tau2-telecom-native",
      version: native.commit,
      operation: "customer-support",
      contractHash: hash({ native, adapterRevision: ADAPTER_REVISION }),
    },
    initialActor: ACTOR,
    initialProposer: PROPOSER,
    authorization: AUTHORIZATION,
    circuitBreakerUsd: 5,
    sourceProjection:
      "Twelve unchanged baseline executions from consumed cases 36,37,39,44, all three draws. Actor-visible projected feedback and binary native outcome only. No private customer tools, final-state probes, reference repairs, manual checklist or fresh case metadata in the proposal prompt. Synthetic source identities redacted by the existing bounded projector.",
    decision:
      "One append-only proposal through existing strategy lab, at most 600 characters. Freeze before evaluation. No manual edits, retries or reselection. Source: eight learned successes with strict contemporaneous baseline improvement. Fresh: strict baseline improvement, no per-case regression and at least checklist success. Only then signed in-process recipient comparison. These are exploratory advancement gates, not production promotion.",
  };
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  write("source-feedback.json", feedback);
  write("proposal-request.json", preparedRequest);
  freezeSources(root, protocol, [
    ...originalFreeze.sources.map((s) => s.file),
    ...codeFiles,
    "src/memory/learning-strategy-peer.ts",
    "src/agents/skills/envelope-validation.ts",
    ...["complete.json", "audit.json", ...feedback.map((r) => `episode-${r.label}.json`)].map((n) =>
      path.join(sourceRoot, n),
    ),
    ...["source-feedback.json", "proposal-request.json"].map((n) => path.join(root, n)),
  ]);
  console.log(
    JSON.stringify({
      status: "prepared",
      sourceTrials: feedback.length,
      sourceSuccesses: feedback.filter((r) => r.passed).length,
      feedbackCharacters: feedback.reduce((s, r) => s + r.feedback.length, 0),
      stages: STAGES,
    }),
  );
} else {
  checkFreeze(root);
  const protocol = read("protocol.json"),
    feedback = sourceFeedback(sourceRoot),
    request = proposalRequest(feedback.map((r) => r.feedback));
  assert.deepEqual(feedback, read("source-feedback.json"));
  assert.deepEqual(request, read("proposal-request.json"));
  if (mode === "audit") {
    const proposal = read("proposal.json"),
      complete = read("complete.json"),
      candidate = read("candidate.json"),
      baseline = read("baseline.json");
    const ledger = fs
      .readFileSync(path.join(root, "provider.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(ledger.length, 2);
    const [intent, receipt] = ledger,
      raw = read(`responses/${proposal.id}.json`);
    assert.equal(intent.type, "intent");
    assert.equal(receipt.type, "receipt");
    assert.equal(intent.id, receipt.id);
    assert.equal(receipt.id, proposal.id);
    assert.equal(raw.status, 200);
    assert.deepEqual(raw.request, { model, max_tokens: 2048, ...request });
    assert.equal(hash(raw.request), intent.promptHash);
    assert.equal(raw.response.model, model);
    assert.deepEqual(raw.response.usage, receipt.usage);
    assert.equal(usageCost(receipt.usage), receipt.usd);
    assert.equal(complete.provider.spent, receipt.usd);
    assert.equal(proposal.cost, receipt.usd);
    assert.ok(receipt.usd <= intent.quote);
    const edit = JSON.parse(
      raw.response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    );
    assert.deepEqual(edit, proposal.edit);
    StrategyAppendSchema.parse(edit);
    assert.ok(!forbidden.test(JSON.stringify(edit)));
    assert.equal(candidate.actor, ACTOR + "\n\n" + edit.append.trim());
    assert.equal(candidate.proposer, PROPOSER);
    assert.deepEqual(candidate.parents, [learningHash(baseline)]);
    assert.equal(learningHash(candidate), complete.candidateHash);
    const db = new DatabaseSync(path.join(root, "source.sqlite"), { readOnly: true });
    const runs = db.prepare("SELECT status,cost FROM learning_runs").all();
    assert.equal(runs.length, 13);
    assert.ok(runs.every((r) => r.status === "settled"));
    assert.equal(
      runs.reduce((s, r) => s + JSON.parse(r.cost).providerUsd, 0),
      receipt.usd,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM strategy_proposals WHERE child=?")
        .get(learningHash(candidate)).n,
      1,
    );
    assert.deepEqual(
      db
        .prepare("SELECT feedback FROM strategy_trials ORDER BY rowid")
        .all()
        .map((r) => r.feedback),
      feedback.map((r) => r.feedback),
    );
    db.close();
    write("audit.json", {
      status: "passed",
      calls: 1,
      sourceFeedbackRows: 12,
      sourceFeedbackReconstructed: true,
      exactProposalRequest: true,
      providerUsd: receipt.usd,
      candidateHash: learningHash(candidate),
    });
    console.log(JSON.stringify(read("audit.json")));
  } else {
    const lockPath = path.join(results, ".collector.lock"),
      lock = fs.openSync(lockPath, "wx");
    fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
    const budget = { providerUsd: 5, toolCalls: 0, wallMs: 600000 };
    const service = new ProceduralLearning(
      new ProceduralLearningStore(new DatabaseSync(path.join(root, "source.sqlite")), {
        mode: "shadow",
        maxEntries: 100,
        executionBudget: budget,
      }),
    );
    const provider = createProvider(root, 5);
    try {
      const prior = priorExposure(results);
      write("project-budget.json", {
        priorExposure: prior,
        ceiling: prior.reduce((s, r) => s + r.usd, 0) + 5,
        authorization: AUTHORIZATION,
      });
      const lab = service.strategies;
      const baseline = lab.archive.add({
        schemaVersion: 1,
        scope: protocol.scope,
        actor: ACTOR,
        proposer: PROPOSER,
        parents: [],
        sharing: "shareable",
        expiresAt: Date.now() + 7 * 86400000,
      });
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
        cases: feedback.map((r) => ({ id: r.label, input: { label: r.label } })),
        quote: () => ({ ...zero, wallMs: 10000 }),
        execute: async (_candidate, input) => ({
          output: feedback.find((r) => r.label === input.label),
          cost: zero,
        }),
        verify: async (_input, row) => ({ passed: row.passed, feedback: row.feedback, cost: zero }),
      });
      await lab.evaluate(baseline, "consumed-source", budget);
      const child = await lab.propose({
        parent: baseline,
        panel: "consumed-source",
        evolveProposer: false,
        editMode: "append",
        fixedProposer: PROPOSER,
        quote: { providerUsd: 5, toolCalls: 0, wallMs: 300000 },
        budget,
        generate: async (context, signal) => {
          assert.deepEqual(
            context.feedback,
            feedback.map((r) => r.feedback),
          );
          const response = await provider.call(proposalRequest(context.feedback), {
            tag: "procedure-proposal",
            maxTokens: 2048,
            localRemaining: 5,
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
      write("candidate.json", lab.archive.get(child));
      write("complete.json", {
        status: "complete",
        candidateHash: child,
        baselineHash: baseline,
        provider: provider.status(),
      });
      console.log(
        JSON.stringify({
          status: "complete",
          candidate: lab.archive.get(child),
          provider: provider.status(),
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
