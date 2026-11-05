import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  exportStrategyPacket,
  importStrategyPacket,
} from "../../../src/memory/learning-strategy-peer.ts";
import { learningHash } from "../../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { ACTOR, PROPOSER, runEpisode, ADAPTER_REVISION } from "./episode.mjs";
import { projectFeedback } from "./feedback.mjs";
import { createProvider, model, rates, hash, priorExposure } from "./provider.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  resultsRoot = path.join(here, "../results");
const id = process.argv[2],
  pilotId = process.argv[3],
  previousId = process.argv[4];
if (![id, pilotId].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v)))
  throw Error("Usage: learn.mjs unique-id completed-pilot-id");
if (previousId !== undefined && !/^[A-Za-z0-9_-]+$/.test(previousId))
  throw Error("Invalid previous correction id");
const appendOnly = previousId !== undefined;
const readPrevious = (name) =>
  JSON.parse(fs.readFileSync(path.join(resultsRoot, previousId, name), "utf8"));
if (appendOnly) {
  assert.equal(readPrevious("complete.json").sourceGate, false);
  assert.equal(readPrevious("protocol.json").pilotId, pilotId);
}
const pilot = path.join(resultsRoot, pilotId),
  readPilot = (n) => JSON.parse(fs.readFileSync(path.join(pilot, n), "utf8"));
const pilotComplete = readPilot("complete.json");
assert.equal(
  readPilot("protocol.json").adapterRevision,
  ADAPTER_REVISION,
  "A changed simulator requires a new baseline; historical outcomes are development evidence only",
);
if (appendOnly) assert.equal(readPrevious("protocol.json").adapterRevision, ADAPTER_REVISION);
assert.equal(pilotComplete.headroomGate, true);
const lockPath = path.join(resultsRoot, ".collector.lock"),
  lock = fs.openSync(lockPath, "wx");
fs.writeSync(lock, JSON.stringify({ pid: process.pid, id }));
process.once("exit", () => {
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
});
const root = path.join(resultsRoot, id);
fs.mkdirSync(root);
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2), { flag: "wx" });
const event = (v) =>
  fs.appendFileSync(
    path.join(root, "events.jsonl"),
    JSON.stringify({ ...v, at: new Date().toISOString() }) + "\n",
  );
const exposureRows = priorExposure(resultsRoot),
  exposure = exposureRows.reduce((s, r) => s + r.usd, 0);
write("project-budget.json", {
  ceiling: 10,
  priorExposure: exposureRows,
  remaining: 10 - exposure,
});
const protocol = {
  schemaVersion: 1,
  kind: "telecom-single-correction-transfer",
  adapterRevision: ADAPTER_REVISION,
  observationMode: "structured",
  editMode: appendOnly ? "append" : "replace",
  conversationCache: appendOnly,
  previousCorrection: previousId ?? null,
  model,
  rates,
  pilotId,
  sourceIndices: [14, 45],
  recipientIndices: [38, 41],
  maxCalls: 96,
  perEpisodeUsd: 1.25,
  initialActor: ACTOR,
  initialProposer: PROPOSER,
  generations: 1,
  evolveProposer: false,
  gate: "Candidate must naturally complete both source cases and strictly improve source success over replayed pilot baseline. Otherwise stop before transfer.",
  partition:
    "Pilot outcomes motivated this study. Reserve distinct repair combinations 38 and 41 before generating the candidate; 38 includes data exhaustion, 41 does not. Same domain and task families; no broad unseen-family generalization claim.",
  comparison:
    "Unchanged actor versus one learned actor instruction transferred by signed in-process envelope into separate fresh recipient stores. Proposer stays fixed. This is not a verified-cache comparison or a test of recursive meta-learning.",
  selection:
    "Exactly one proposal. No repair retries or candidate reselection using held-out results. Source qualification is not imported. Held-out recipient executions provide local evidence, without live promotion.",
  accounting:
    "Pilot baseline episodes are replayed at zero new provider cost. Allocate the entire pilot plus this source discovery to a transferred deployment separately from physical spend.",
  order:
    "Source candidate first, then recipient baseline on both cases, then transferred candidate on both. Sampling unseeded; one observation per arm/case, exploratory only.",
  sourceFeedback: appendOnly
    ? "Ordered actor-visible dialogue and selected account observations from both pilot and failed correction, stopping at first successful handoff. Previous correction is explicitly identified. Max 32000 characters per source case; fail before collection on overflow. No reference solutions, native assertions, private user tools or held-out feedback. Synthetic source customers only."
    : "Host projection of actor-visible tool observations and binary outcomes. No reference solutions, initialization state, native assertion details, customer-private tool results or held-out feedback.",
  editConstraint: appendOnly
    ? "Exactly one proposal of at most 600 characters appended by the lab to the unchanged baseline actor, with proposer fixed. Text preservation is not a semantic non-regression guarantee; the source gate still applies."
    : "Complete actor replacement, proposer fixed.",
  budgetStop:
    "No unpriced retries or ceiling increase; resource-censored episodes are never successful evidence. A budget stop can leave transfer inconclusive.",
};
write("protocol.json", protocol);
const pilotFreeze = readPilot("freeze.json");
const files = [
  ...new Set([
    ...pilotFreeze.sources.map((s) => s.file),
    path.relative(process.cwd(), path.join(here, "grounding.mjs")),
    path.relative(process.cwd(), path.join(here, "diagnostic-observations.mjs")),
    path.relative(process.cwd(), path.join(here, "public-observations.mjs")),
    path.relative(process.cwd(), path.join(here, "learn.mjs")),
    "src/memory/learning-strategy-peer.ts",
    "src/agents/skills/envelope-validation.ts",
    path.relative(process.cwd(), path.join(here, "feedback.mjs")),
    ...["complete.json", "episode-14.json", "episode-45.json"].map((n) =>
      path.relative(process.cwd(), path.join(pilot, n)),
    ),
    ...(appendOnly
      ? [
          "complete.json",
          "protocol.json",
          "candidate.json",
          "episode-source-development-14.json",
          "episode-source-development-45.json",
        ].map((n) => path.relative(process.cwd(), path.join(resultsRoot, previousId, n)))
      : []),
  ]),
];
fs.mkdirSync(path.join(root, "source"));
const sources = files.map((file, i) => {
  const body = fs.readFileSync(file),
    snapshot = `source/${i}-${path.basename(file)}`;
  fs.writeFileSync(path.join(root, snapshot), body);
  return { file: file.replaceAll("\\", "/"), snapshot, sha256: hash(body.toString("utf8")) };
});
write("freeze.json", {
  at: new Date().toISOString(),
  protocolHash: hash(protocol),
  node: process.version,
  sources,
});
const provider = createProvider(root, 10 - exposure),
  services = [];
const manifest = JSON.parse(fs.readFileSync(path.join(here, "native-sources.json")));
const scope = {
  tool: "tau2-telecom-native",
  version: manifest.commit,
  operation: "customer-support",
  contractHash: learningHash({ native: manifest, adapterRevision: ADAPTER_REVISION }),
};
const budget = { providerUsd: 10, toolCalls: 10000, wallMs: 100000000 };
const zero = { providerUsd: 0, toolCalls: 0, wallMs: 0 };
const sourceEpisodes = new Map(
  protocol.sourceIndices.map((i) => [i, readPilot(`episode-${i}.json`)]),
);
const forbidden =
  /(?:\b(?:Mamadou|Diallo|Priya|Patil)\b|555-\d{3}-\d{4}|\b[CLPBD]\d{4,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\[PERSONA:)/i;
function coarseFeedback(episode) {
  const observations = episode.transcript
    .filter((e) => e.type === "tool" && e.seat === "actor")
    .map((e) => {
      let value;
      try {
        value = JSON.parse(e.content);
      } catch {
        value = {};
      }
      const fields = [
        "status",
        "data_used_gb",
        "data_refueling_gb",
        "roaming_enabled",
        "data_limit_gb",
        "data_refueling_price_per_gb",
        "data_used",
        "data_limit",
        "data_remaining",
      ];
      return {
        tool: e.name,
        error: e.error,
        observed: Object.fromEntries(
          fields.filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]),
        ),
      };
    });
  const complaint = episode.publicConversation[0].text
    .replace(/Mamadou Diallo|Priya Patil|Mamadou|Priya/g, "CUSTOMER")
    .replace(/555-\d{3}-\d{4}/g, "PHONE");
  const result = JSON.stringify({
    complaint,
    passed: episode.verdict.passed,
    actorObservations: observations,
  });
  assert.ok(result.length < 6000 && !forbidden.test(result));
  return result;
}
const sourceFeedback = new Map(
  protocol.sourceIndices.map((index) => {
    const baseline = sourceEpisodes.get(index);
    const value = appendOnly
      ? JSON.stringify({
          baseline: projectFeedback(baseline),
          previousAttempt: {
            actor: readPrevious("candidate.json").actor,
            evidence: projectFeedback(readPrevious(`episode-source-development-${index}.json`)),
          },
        })
      : coarseFeedback(baseline);
    assert.ok(value.length <= (appendOnly ? 32000 : 6000), "Feedback exceeds frozen bound");
    assert.ok(!forbidden.test(value));
    return [index, value];
  }),
);
function feedback(episode) {
  const baselineIndex = [...sourceEpisodes].find(([, value]) => value === episode)?.[0];
  const result =
    baselineIndex === undefined
      ? appendOnly
        ? JSON.stringify(projectFeedback(episode))
        : coarseFeedback(episode)
      : sourceFeedback.get(baselineIndex);
  assert.ok(result.length <= (appendOnly ? 32000 : 6000));
  return result;
}
write(
  "source-feedback.json",
  protocol.sourceIndices.map((i) => ({ index: i, feedback: feedback(sourceEpisodes.get(i)) })),
);
function node(name) {
  const service = new ProceduralLearning(
    new ProceduralLearningStore(new DatabaseSync(path.join(root, `${name}.sqlite`)), {
      mode: "shadow",
      maxEntries: 100,
      executionBudget: budget,
    }),
  );
  services.push(service);
  return service.strategies;
}
function seed(lab) {
  return lab.archive.add({
    schemaVersion: 1,
    scope,
    actor: ACTOR,
    proposer: PROPOSER,
    parents: [],
    sharing: "shareable",
    expiresAt: Date.now() + 7 * 86400000,
  });
}
const executions = [];
function panel(lab, name, indices, partition, baselineReplayHash) {
  lab.registerPanel({
    id: name,
    scope,
    partition,
    model,
    verifierHash: hash(fs.readFileSync(path.join(here, "native.py"), "utf8")),
    isolation: "sandbox",
    sharing: "shareable",
    cases: indices.map((index) => ({ id: `case-${index}`, input: { index } })),
    ...(appendOnly ? { feedbackLimit: 32000 } : {}),
    quote: () => ({ providerUsd: protocol.perEpisodeUsd, toolCalls: 1000, wallMs: 1800000 }),
    execute: async (candidate, input, signal) => {
      if (learningHash(candidate) === baselineReplayHash)
        return { output: sourceEpisodes.get(input.index), cost: zero };
      const label = `${name}-${input.index}`;
      console.log(JSON.stringify({ event: "episode-start", label }));
      const result = await runEpisode({
        index: input.index,
        strategy: candidate.actor,
        provider,
        tag: label,
        signal,
        maxCalls: protocol.maxCalls,
        maxUsd: protocol.perEpisodeUsd,
        conversationCache: protocol.conversationCache,
        onEvent: (e) => event({ ...e, label }),
      });
      write(`episode-${label}.json`, result);
      executions.push({ label, index: input.index, strategy: candidate.actor, result });
      console.log(
        JSON.stringify({
          event: "episode-complete",
          label,
          passed: result.verdict.passed,
          reason: result.reason,
          cost: result.cost,
        }),
      );
      return { output: result, cost: result.cost };
    },
    verify: async (_input, result) => ({
      passed: result.verdict.passed && ["user-ended", "human-transfer"].includes(result.reason),
      feedback: partition === "development" ? feedback(result) : "held-out",
      cost: zero,
    }),
  });
}
try {
  const source = node("source"),
    baseline = seed(source);
  panel(source, "source-development", protocol.sourceIndices, "development", baseline);
  const priorResult = await source.evaluate(baseline, "source-development", budget);
  const child = await source.propose({
    parent: baseline,
    panel: "source-development",
    evolveProposer: false,
    editMode: protocol.editMode,
    fixedProposer: PROPOSER,
    quote: { providerUsd: appendOnly ? 0.6 : 0.3, toolCalls: 0, wallMs: 200000 },
    budget,
    generate: async (context, signal) => {
      const prompt = appendOnly
        ? `${context.instructions}\nUnchanged baseline actor: ${context.parent.actor}\nDevelopment evidence (baseline and a previous unsuccessful broad correction): ${context.feedback.join("\n")}\nCompare successful and failed behavior. Return JSON with only append: one reusable prerequisite or verification checklist of at most 600 characters. The host will append it to the unchanged baseline actor. Preserve existing troubleshooting and policy compliance. Do not invent universal rules from a single outcome, replace existing instructions, include task-specific scripts, identities or literal account values. Address the observed failure without repeating the previous regression. The proposer stays unchanged.`
        : `${context.instructions}\nCurrent actor: ${context.parent.actor}\nObserved development feedback: ${context.feedback.join("\n")}\nReturn JSON with actor (the complete reusable instructions, at most 4000 characters) and proposer (the unchanged current proposer). Preserve general troubleshooting ability. No customer identities, literal account IDs or task-specific answers. Current proposer: ${PROPOSER}`;
      assert.ok(!forbidden.test(prompt));
      const receipt = await provider.call(
        {
          messages: [{ role: "user", content: prompt }],
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: appendOnly
                  ? { append: { type: "string" } }
                  : { actor: { type: "string" }, proposer: { type: "string" } },
                required: appendOnly ? ["append"] : ["actor", "proposer"],
                additionalProperties: false,
              },
            },
          },
        },
        { tag: "proposal", maxTokens: 2048, localRemaining: appendOnly ? 0.6 : 0.3, signal },
      );
      const text = receipt.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
        edit = JSON.parse(text);
      if (receipt.stopReason === "max_tokens" || forbidden.test(text))
        throw Error("Invalid or private proposal");
      write("proposal.json", { id: receipt.id, edit, cost: receipt.usd });
      return { edit, cost: { providerUsd: receipt.usd, toolCalls: 0, wallMs: receipt.wallMs } };
    },
  });
  write("candidate.json", source.archive.get(child));
  const qualified = await source.evaluate(child, "source-development", budget);
  const sourceGate =
    qualified.successes > priorResult.successes &&
    qualified.successes === qualified.total &&
    executions.every((e) => ["user-ended", "human-transfer"].includes(e.result.reason));
  const recipients = [];
  if (sourceGate) {
    const content = exportStrategyPacket(source, child, "source-development"),
      bytes = Buffer.from(content),
      keys = generateKeyPairSync("ed25519");
    const envelope = {
      version: 1,
      name: "telecom-shadow-strategy",
      skill_md: bytes.toString("base64"),
      content_hash: hash(content),
      author_peer_id: "isolated-source",
      author_pubkey: keys.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64"),
      timestamp: Date.now(),
      signature: sign(null, bytes, keys.privateKey).toString("base64"),
    };
    write("transfer-envelope.json", envelope);
    for (const arm of ["baseline", "transferred"]) {
      const recipient = node(`recipient-${arm}`),
        target = arm === "baseline" ? seed(recipient) : importStrategyPacket(recipient, envelope);
      assert.equal(recipient.store.db.prepare("SELECT count(*) n FROM learning_runs").get().n, 0);
      panel(recipient, `recipient-${arm}`, protocol.recipientIndices, "held-out");
      recipient.archive.seal(scope, [target]);
      const result = await recipient.evaluate(target, `recipient-${arm}`, budget);
      recipients.push({ arm, result });
    }
  }
  const sourceCost =
    qualified.cost.providerUsd + JSON.parse(fs.readFileSync(path.join(root, "proposal.json"))).cost;
  write("complete.json", {
    priorResult,
    qualified,
    sourceGate,
    recipients,
    provider: provider.status(),
    executionManifest: executions.map((e) => ({
      label: e.label,
      index: e.index,
      strategy: e.strategy,
    })),
    priorExposureUsd: exposure,
    cumulativeExposureUsd: exposure + provider.status().spent,
    transferredDiscoveryAllocationUsd: pilotComplete.provider.spent + sourceCost,
    cumulativeDevelopmentAllocationUsd:
      pilotComplete.provider.spent +
      sourceCost +
      (appendOnly ? readPrevious("complete.json").provider.spent : 0),
    note: "One learned instruction, one source repetition, two held-out repair combinations; no recursive learning or verified-cache superiority claim.",
  });
  console.log(
    JSON.stringify({ event: "complete", sourceGate, recipients, provider: provider.status() }),
  );
} catch (error) {
  write("incomplete.json", { error: error.message, provider: provider.status() });
  throw error;
} finally {
  await Promise.allSettled(services.map((s) => s.close()));
}
