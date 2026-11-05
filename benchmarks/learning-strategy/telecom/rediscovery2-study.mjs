import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { createBridge } from "./bridge.mjs";
import { checkFreeze, freezeSources, consumedCases } from "./procedure-protocol.mjs";
import {
  feedbackSummary,
  engineerPacket,
  diagnosisRequest,
  generateProgram,
  parseResponse,
  diagnosticProbes,
} from "./rediscovery2-engineer.mjs";
import { runEpisode, ADAPTER_REVISION } from "./rediscovery2-episode.mjs";
import {
  ACTOR,
  ENGINEER,
  TRAINING,
  CONFIRMATION,
  FRESH,
  RECIPIENT,
  BRANCHES,
  ROUNDS,
  NATURAL,
  DECISION,
  selectCandidate,
  comparisonSchedule,
  checkPartitions,
} from "./rediscovery2-protocol.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./rediscovery2-provider.mjs";
import { executionInstructions, programProvider } from "./rediscovery2-runtime.mjs";

const [mode, id, stage, sourceId] = process.argv.slice(2);
assert.ok(["prepare", "run"].includes(mode) && /^[\w-]+$/.test(id ?? ""));
const results = "benchmarks/learning-strategy/results",
  root = path.join(results, id);
const read = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
const zero = { providerUsd: 0, toolCalls: 0, wallMs: 0 };
const budget = { providerUsd: 150, toolCalls: 100000, wallMs: 86400000 };
const serviceAt = (name) =>
  new ProceduralLearning(
    new ProceduralLearningStore(new DatabaseSync(path.join(root, `${name}.sqlite`)), {
      mode: "shadow",
      maxEntries: 100,
      executionBudget: budget,
    }),
  );
if (mode === "prepare") {
  checkPartitions();
  assert.equal(read(".tmp", "rediscovery2-audit-preflight.json").status, "passed");
  assert.ok(["seed", "discovery", "confirmation", "fresh"].includes(stage));
  const recoveryRoot = path.join(results, "telecom-contract-qualification-v1"),
    base = checkFreeze(recoveryRoot);
  assert.equal(read(recoveryRoot, "audit.json").audit, true);
  assert.equal(read(recoveryRoot, "review.json").status, "passed");
  const consumed = consumedCases(results, id);
  assert.ok([...TRAINING, ...CONFIRMATION].every((i) => consumed.includes(i)));
  assert.ok([...FRESH, ...RECIPIENT].every((i) => !consumed.includes(i)));
  const native = read("benchmarks/learning-strategy/telecom", "native-sources.json");
  const scope = {
    tool: "tau2-telecom-native",
    version: native.commit,
    operation: "customer-support",
    contractHash: hash({
      native,
      adapter: ADAPTER_REVISION,
      programRuntime: "delivery-specific-advice-with-compiler-repair-v2",
    }),
  };
  const baseline = {
    schemaVersion: 1,
    scope,
    actor: ACTOR,
    proposer: ENGINEER,
    parents: [],
    sharing: "private",
    expiresAt: Date.now() + 30 * 86400000,
  };
  const protocol = {
    kind: "telecom-corrected-autonomous-rediscovery",
    stage,
    scope,
    baseline,
    model,
    rates,
    adapterRevision: ADAPTER_REVISION,
    maxCalls: 128,
    perEpisodeUsd: 3,
    concurrency: 3,
    laneCeilingUsd: 75,
    rounds: ROUNDS,
    branches: BRANCHES,
    observationMode: "structured",
    conversationCache: true,
    consumedCases: consumed,
    decision: DECISION,
    authorization:
      "User authorized thorough experiments without the former cap and approved autonomous rediscovery. Research only; no live activation or peer publication.",
    candidateIdentity:
      "Archive actor field stores the generated declarative program; the pinned runtime interprets it. Original actor/policy unchanged. The engineer has only explicit model requests and native diagnostic tools, no filesystem/repository access. Manual checklist, ledger and human diagnosis are never model inputs.",
  };
  let context,
    initial,
    source = null;
  if (stage === "discovery") {
    const b = createBridge();
    try {
      const c = await b.request({ method: "reset", index: TRAINING[0] });
      context = { policy: c.policy, agentTools: c.agentTools, userTools: c.userTools };
    } finally {
      b.close();
    }
    assert.ok(/^[\w-]+$/.test(sourceId ?? ""));
    const history = path.join(results, sourceId);
    source = history;
    checkFreeze(history);
    assert.equal(read(history, "protocol.json").stage, "seed");
    assert.equal(read(history, "protocol.json").scope.contractHash, scope.contractHash);
    assert.equal(read(history, "measurement-review.json").status, "passed");
    protocol.sourceRun = sourceId;
    assert.equal(read(history, "audit.json").status, "passed");
    initial = TRAINING.map((index, position) => ({
      case: `case-${position}`,
      index,
      episode: read(history, `episode-baseline-0-${index}.json`),
    }));
    protocol.indices = TRAINING;
    protocol.initialHistory =
      "Audited baseline seed under the amended customer contract; used as engineering experience, not independent efficacy outcomes.";
    protocol.maximumEngineerCalls = 36;
    protocol.newEvaluationEpisodes = 72;
    protocol.maxNewProviderUsd = 300;
    for (const branch of ["experience", "blind"]) {
      const packet = engineerPacket({
        branch,
        round: 0,
        actor: ACTOR,
        context,
        bank: new Map(initial.map((r) => [r.case, r])),
        feedback: initial.map((r) => JSON.stringify(feedbackSummary(r.episode, r.case))),
      });
      assert.ok(Buffer.byteLength(JSON.stringify(diagnosisRequest(packet))) < 190000);
    }
  } else if (stage === "seed") {
    protocol.indices = TRAINING;
    protocol.repetitions = 1;
    protocol.arms = ["baseline"];
    protocol.actors = { baseline: ACTOR };
    protocol.schedule = comparisonSchedule(protocol.arms, protocol.indices, 1);
    protocol.newEvaluationEpisodes = 6;
    protocol.maxNewProviderUsd = protocol.laneCeilingUsd;
  } else {
    assert.ok(/^[\w-]+$/.test(sourceId ?? ""));
    source = path.join(results, sourceId);
    checkFreeze(source);
    assert.equal(read(source, "audit.json").status, "passed");
    assert.equal(read(source, "measurement-review.json").status, "passed");
    const sp = read(source, "protocol.json"),
      sc = read(source, "complete.json");
    assert.equal(sp.scope.contractHash, scope.contractHash);
    if (stage === "confirmation") {
      assert.equal(sp.stage, "discovery");
      assert.equal(sc.status, "complete");
      assert.ok(
        sc.selections.every((s) => s.valid),
        "Every comparison branch needs a valid selection",
      );
      protocol.indices = CONFIRMATION;
      protocol.repetitions = 2;
      protocol.arms = ["baseline", ...BRANCHES];
      protocol.nominated = sc.nominated;
      protocol.actors = {
        baseline: ACTOR,
        ...Object.fromEntries(sc.selections.map((r) => [r.branch, r.actor])),
      };
      protocol.sourceSelections = sc.selections;
    } else {
      assert.equal(sp.stage, "confirmation");
      const analysis = read(source, "analysis.json");
      assert.equal(analysis.advancementGate.passed, true);
      protocol.indices = FRESH;
      protocol.repetitions = 3;
      protocol.nominated = sp.nominated;
      protocol.pairedBlind = sp.nominated.replace("experience", "blind");
      protocol.arms = ["baseline", protocol.nominated, protocol.pairedBlind];
      protocol.actors = Object.fromEntries(protocol.arms.map((a) => [a, sp.actors[a]]));
    }
    assert.ok(
      protocol.nominated && protocol.actors[protocol.nominated] !== ACTOR,
      "No valid autonomous nominee",
    );
    protocol.schedule = comparisonSchedule(protocol.arms, protocol.indices, protocol.repetitions);
    protocol.sourceRun = sourceId;
    protocol.newEvaluationEpisodes =
      protocol.arms.length * protocol.indices.length * protocol.repetitions;
    protocol.maxNewProviderUsd = protocol.schedule.length * protocol.laneCeilingUsd;
  }
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  const extra = [];
  if (initial) {
    write("initial-history.json", initial);
    write("engineer-context.json", context);
    extra.push(path.join(root, "initial-history.json"), path.join(root, "engineer-context.json"));
  }
  if (source)
    extra.push(
      ...[
        "protocol.json",
        "complete.json",
        "audit.json",
        "measurement-review.json",
        ...(stage === "fresh" ? ["analysis.json"] : []),
      ].map((n) => path.join(source, n)),
    );
  const code = fs
    .readdirSync("benchmarks/learning-strategy/telecom")
    .filter((n) => n.startsWith("rediscovery2-") && n.endsWith(".mjs"))
    .map((n) => `benchmarks/learning-strategy/telecom/${n}`);
  freezeSources(root, protocol, [
    ...base.sources.map((s) => s.file),
    ...code,
    "benchmarks/learning-strategy/telecom/rediscovery-compile-feedback.mjs",
    ...extra,
    path.join(recoveryRoot, "audit.json"),
    path.join(recoveryRoot, "complete.json"),
    path.join(recoveryRoot, "review.json"),
  ]);
  write("preflight.json", {
    status: "ready",
    stage,
    newEvaluationEpisodes: protocol.newEvaluationEpisodes,
    engineerCalls: protocol.engineerCalls ?? 0,
    priorExposureUsd: priorExposure(results).reduce((s, r) => s + r.usd, 0),
  });
  console.log(JSON.stringify(read(root, "preflight.json")));
} else {
  checkFreeze(root);
  assert.ok(
    !fs.existsSync(path.join(root, "provider.jsonl")) &&
      !fs.existsSync(path.join(root, "complete.json")),
    "No implicit run retries",
  );
  const p = read(root, "protocol.json");
  if (p.stage === "fresh")
    assert.ok(p.indices.every((i) => !consumedCases(results, id).includes(i)));
  const prior = priorExposure(results).reduce((s, r) => s + r.usd, 0);
  const lockPath = path.join(results, ".collector.lock"),
    lock = fs.openSync(lockPath, "wx");
  fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
  write("project-budget.json", { priorExposure: priorExposure(results), priorExposureUsd: prior });
  const providers = [],
    episodes = [],
    proposals = [],
    selections = [];
  let fatal = null;
  const status = () => ({
    spent: providers.reduce((s, v) => s + v.status().spent, 0),
    reserved: providers.reduce((s, v) => s + v.status().reserved, 0),
    unresolved: providers.reduce((s, v) => s + v.status().unresolved, 0),
  });
  async function evaluateEpisode(provider, entry, signal) {
    const e = await runEpisode({
      index: entry.index,
      strategy: executionInstructions(entry.actor),
      tag: entry.label,
      signal,
      maxCalls: p.maxCalls,
      maxUsd: p.perEpisodeUsd,
      conversationCache: true,
      observationMode: "structured",
      provider: programProvider(provider, entry.actor, (event) =>
        fs.appendFileSync(path.join(root, "program-events.jsonl"), JSON.stringify(event) + "\n"),
      ),
    });
    write(`episode-${entry.label}.json`, e);
    episodes.push({
      ...entry,
      passed: e.verdict.passed && NATURAL.includes(e.reason),
      termination: e.reason,
      modelCalls: e.transcript.filter((r) => r.id).length,
      providerUsd: e.cost.providerUsd,
    });
    console.log(
      JSON.stringify({
        event: "episode-complete",
        label: entry.label,
        passed: e.verdict.passed,
        termination: e.reason,
      }),
    );
    return e;
  }
  async function discovery(branchName) {
    const branch = branchName.startsWith("experience") ? "experience" : "blind";
    const provider = createProvider(root, p.laneCeilingUsd);
    providers.push(provider);
    const service = serviceAt(branchName),
      lab = service.strategies,
      candidates = [];
    let round = -1,
      bank = new Map(read(root, "initial-history.json").map((r) => [r.case, r]));
    const context = read(root, "engineer-context.json");
    let previousCompilerFeedback = null;
    let parent = lab.archive.add(p.baseline);
    const seed = parent;
    try {
      lab.registerPanel({
        id: "training",
        scope: p.scope,
        partition: "development",
        sharing: "private",
        feedbackLimit: 32000,
        model,
        verifierHash: hash({ native: p.scope.version, adapter: p.adapterRevision }),
        isolation: "sandbox",
        cases: TRAINING.map((index, i) => ({
          id: `case-${i}`,
          input: { index, case: `case-${i}` },
        })),
        quote: () =>
          round < 0
            ? { ...zero, wallMs: 10000 }
            : { providerUsd: 3, toolCalls: 1000, wallMs: 1800000 },
        execute: async (candidate, input, signal) => {
          if (round < 0) return { output: bank.get(input.case).episode, cost: zero };
          const e = await evaluateEpisode(
            provider,
            {
              label: `${branchName}-r${round}-case-${input.index}`,
              branch: branchName,
              round,
              index: input.index,
              case: input.case,
              actor: candidate.actor,
              store: branchName,
            },
            signal,
          );
          bank.set(input.case, { index: input.index, episode: e });
          return { output: e, cost: e.cost };
        },
        verify: async (input, e) => ({
          passed: e.verdict.passed && NATURAL.includes(e.reason),
          feedback:
            branch === "experience"
              ? JSON.stringify(feedbackSummary(e, input.case))
              : "Execution feedback withheld.",
          cost: zero,
        }),
      });
      await lab.evaluate(parent, "training", budget);
      for (round = 0; round < p.rounds; round++) {
        const label = `${branchName}-r${round}`;
        let generated;
        const child = await lab.propose({
          parent,
          panel: "training",
          evolveProposer: false,
          fixedProposer: ENGINEER,
          editMode: "replace",
          quote: { providerUsd: 8, toolCalls: 100, wallMs: 600000 },
          budget,
          generate: async (input, signal) => {
            const started = performance.now();
            const packet = engineerPacket({
              branch,
              round,
              actor: input.parent.actor,
              feedback: input.feedback,
              context,
              bank,
              previousCompilerFeedback,
            });
            const diagnostic = await provider.call(diagnosisRequest(packet), {
              tag: `${label}:diagnosis`,
              maxTokens: 2048,
              localRemaining: 8,
              signal,
            });
            let diagnosis;
            try {
              diagnosis = parseResponse(diagnostic);
            } catch (error) {
              diagnosis = {
                hypotheses: `Invalid diagnostic plan: ${error.message}`,
                probes: [],
                delivery: "system",
              };
            }
            const probeResults = await diagnosticProbes(diagnosis, branch, bank);
            const batch = await generateProgram(provider, packet, diagnosis, probeResults, {
              label,
              remainingUsd: 8 - diagnostic.usd,
              signal,
            });
            const programAttempts = batch.attempts,
              response = batch.response,
              spent = diagnostic.usd + batch.usd;
            generated = batch.generated;
            previousCompilerFeedback = batch.feedback;
            const record = {
              label,
              branch: branchName,
              round,
              parent,
              packet,
              diagnosisId: diagnostic.id,
              programId: response.id,
              programAttempts,
              diagnosis,
              probeResults,
              generated,
              providerUsd: spent,
            };
            write(`proposal-${label}.json`, record);
            proposals.push(record);
            return {
              edit: { actor: generated.valid ? generated.actor : ACTOR, proposer: ENGINEER },
              cost: {
                providerUsd: record.providerUsd,
                toolCalls: probeResults.reduce((s, r) => s + (r.actions?.length ?? 0), 0),
                wallMs: performance.now() - started,
              },
            };
          },
        });
        const result = await lab.evaluate(child, "training", budget);
        const group = episodes.filter((e) => e.branch === branchName && e.round === round);
        const row = {
          branch: branchName,
          round,
          hash: child,
          actor: lab.archive.get(child).actor,
          valid: generated.valid,
          successes: result.successes,
          total: result.total,
          modelCalls: group.reduce((s, e) => s + e.modelCalls, 0),
          result,
        };
        candidates.push(row);
        write(`round-${label}.json`, row);
        parent = child;
        console.log(
          JSON.stringify({
            event: "round-complete",
            label,
            valid: generated.valid,
            successes: result.successes,
          }),
        );
      }
      const selected = selectCandidate(candidates);
      const selection = {
        branch: branchName,
        ...(selected ?? {
          valid: false,
          round: -1,
          hash: seed,
          actor: ACTOR,
          successes: 0,
          modelCalls: Infinity,
        }),
        candidates,
      };
      lab.archive.seal(p.scope, [selection.hash]);
      selections.push(selection);
      write(`selection-${branchName}.json`, selection);
    } finally {
      await service.close();
    }
  }
  async function comparison(block) {
    const store = `${block.arm}-${block.repetition}`,
      provider = createProvider(root, p.laneCeilingUsd);
    providers.push(provider);
    const service = serviceAt(store),
      lab = service.strategies;
    try {
      const candidate = lab.archive.add({ ...p.baseline, actor: p.actors[block.arm] });
      if (p.stage !== "seed") lab.archive.seal(p.scope, [candidate]);
      lab.registerPanel({
        id: "confirmation",
        scope: p.scope,
        partition: p.stage === "seed" ? "development" : "held-out",
        sharing: "private",
        model,
        verifierHash: hash({ native: p.scope.version, adapter: p.adapterRevision }),
        isolation: "sandbox",
        cases: block.indices.map((index) => ({ id: String(index), input: { index } })),
        quote: () => ({ providerUsd: 3, toolCalls: 1000, wallMs: 1800000 }),
        execute: async (c, input, signal) => {
          const e = await evaluateEpisode(
            provider,
            {
              label: `${store}-${input.index}`,
              arm: block.arm,
              repetition: block.repetition,
              index: input.index,
              actor: c.actor,
              store,
            },
            signal,
          );
          return { output: e, cost: e.cost };
        },
        verify: async (_input, e) => ({
          passed: e.verdict.passed && NATURAL.includes(e.reason),
          feedback: "held-out",
          cost: zero,
        }),
      });
      const result = await lab.evaluate(candidate, "confirmation", budget);
      if (p.stage === "seed") lab.archive.seal(p.scope, [candidate]);
      write(`evaluation-${store}.json`, result);
    } finally {
      await service.close();
    }
  }
  const work = p.stage === "discovery" ? [...p.branches] : [...p.schedule];
  let cursor = 0;
  const worker = async () => {
    while (cursor < work.length && !fatal) {
      const item = work[cursor++];
      try {
        if (p.stage === "discovery") await discovery(item);
        else await comparison(item);
      } catch (error) {
        fatal ??= error;
        throw error;
      }
    }
  };
  try {
    const settled = await Promise.allSettled(Array.from({ length: p.concurrency }, () => worker()));
    if (settled.some((r) => r.status === "rejected")) {
      write("incomplete.json", {
        error: fatal?.message,
        episodes,
        proposals: proposals.map((r) => r.label),
        provider: status(),
      });
      throw fatal;
    }
    selections.sort((a, b) => p.branches.indexOf(a.branch) - p.branches.indexOf(b.branch));
    const nominees = selections
      .filter((s) => s.branch.startsWith("experience") && s.valid)
      .toSorted(
        (a, b) => b.successes - a.successes || a.modelCalls - b.modelCalls || a.round - b.round,
      );
    write("complete.json", {
      status: "complete",
      stage: p.stage,
      episodes,
      proposalLabels: proposals.map((r) => r.label),
      selections,
      nominated: p.stage === "discovery" ? (nominees[0]?.branch ?? null) : p.nominated,
      provider: status(),
      priorExposureUsd: prior,
      cumulativeExposureUsd: prior + status().spent,
    });
    console.log(
      JSON.stringify({
        event: "complete",
        episodes: episodes.length,
        proposals: proposals.length,
        nominated: nominees[0]?.branch,
        provider: status(),
      }),
    );
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
