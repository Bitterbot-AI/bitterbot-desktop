import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createBridge } from "./bridge.mjs";
import { checkFreeze, consumedCases, freezeSources } from "./procedure-protocol.mjs";
import { createProvider, model, rates, priorExposure, hash, usageCost } from "./provider.mjs";
import { PublicObservationSession } from "./public-observations.mjs";
import {
  explicitPurchasePreference,
  CUSTOMER_CONTRACT_REVISION,
} from "./rediscovery2-customer-contract.mjs";
import { userContext } from "./rediscovery2-episode.mjs";

const [mode, id] = process.argv.slice(2);
assert.ok(
  ["prepare", "run", "audit"].includes(mode) &&
    /^telecom-contract-qualification-v\d+$/.test(id ?? ""),
);
const results = "benchmarks/learning-strategy/results",
  root = path.join(results, id);
const read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
const offers = [
  {
    id: "smaller",
    speech:
      "Additional data is needed to resolve the issue. I can add 1 GB for a total of $2. May I add that 1 GB now?",
    expected: "Decline the 1GB offer and request exactly 2GB; do not authorize 1GB.",
  },
  {
    id: "larger",
    speech:
      "Additional data is needed to resolve the issue. I can add 3 GB for a total of $6. May I add that 3 GB now?",
    expected: "Decline the 3GB offer and request exactly 2GB; do not authorize 3GB.",
  },
  {
    id: "preferred",
    speech:
      "Additional data is needed to resolve the issue. I can add exactly 2 GB for a total of $4 without changing your plan. May I add that 2 GB now?",
    expected:
      "Explicitly approve exactly 2GB at the stated $4 total price; no different quantity or plan change.",
  },
  {
    id: "unpriced",
    speech:
      "Additional data is needed to resolve the issue. I can add exactly 2 GB without changing your plan. May I add it now?",
    expected:
      "Request the total price before authorizing the 2GB purchase; no unconditional approval.",
  },
];
async function requestFor(trial) {
  const bridge = createBridge();
  try {
    const context = explicitPurchasePreference(
      await bridge.request({ method: "reset", index: trial.index }),
    );
    return {
      ...userContext(context),
      messages: [
        {
          role: "user",
          content: `Support agent: ${offers.find((o) => o.id === trial.offer).speech}`,
        },
      ],
      cache_control: { type: "ephemeral" },
    };
  } finally {
    bridge.close();
  }
}
function publicReply(response) {
  const calls = response.content.filter((b) => b.type === "tool_use");
  assert.notEqual(response.stopReason, "max_tokens");
  if (calls.length) {
    assert.equal(calls.length, 1, "No extra tools in a purchase-preference reply");
    assert.equal(calls[0].name, "share_observations");
    const session = new PublicObservationSession();
    session.publish(calls[0].input);
    return calls[0].input.speech;
  }
  const speech = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  assert.ok(speech);
  return speech;
}
if (mode === "prepare") {
  const indices = [14, 28, 37, 39, 45];
  assert.ok(indices.every((i) => consumedCases(results).includes(i)));
  const base = checkFreeze(path.join(results, "telecom-rediscovery-discovery-v2"));
  const trials = indices.flatMap((index) =>
    offers.flatMap((offer) =>
      [0, 1].map((repetition) => ({
        index,
        offer: offer.id,
        repetition,
        label: `contract-${offer.id}-r${repetition}-${index}`,
        expected: offer.expected,
      })),
    ),
  );
  const protocol = {
    kind: "telecom-explicit-preference-qualification",
    revision: CUSTOMER_CONTRACT_REVISION,
    model,
    rates,
    indices,
    trials,
    ceilingUsd: 10,
    maxTokens: 1024,
    criterion:
      "All 40 replies must pass the ordinary publication boundary and manual semantic review against the preregistered offer-specific expectations. No automatic lexical consent inference, no repairs/retries. This qualifies narrow purchase-preference behavior, not full-conversation compliance, task improvement or official benchmark parity.",
  };
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  freezeSources(root, protocol, [
    ...base.sources.map((s) => s.file).filter((f) => !f.includes("/results/")),
    ...[
      "rediscovery2-customer-contract.mjs",
      "rediscovery2-episode.mjs",
      "rediscovery2-contract-qualify.mjs",
    ].map((n) => `benchmarks/learning-strategy/telecom/${n}`),
  ]);
  console.log(JSON.stringify({ status: "prepared", trials: trials.length }));
} else {
  checkFreeze(root);
  const p = read("protocol.json");
  const lockPath = path.join(results, ".collector.lock"),
    lock = mode === "run" ? fs.openSync(lockPath, "wx") : null;
  if (lock !== null) fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
  const provider = mode === "run" ? createProvider(root, p.ceilingUsd) : null;
  const prior = priorExposure(results)
      .filter((r) => r.run !== id)
      .reduce((s, r) => s + r.usd, 0),
    rows = [];
  try {
    if (mode === "run")
      assert.ok(!fs.existsSync(path.join(root, "provider.jsonl")), "No implicit retries");
    const ledger =
      mode === "audit"
        ? fs
            .readFileSync(path.join(root, "provider.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse)
        : [];
    for (const trial of p.trials) {
      const request = await requestFor(trial);
      let response;
      if (provider)
        response = await provider.call(request, { tag: trial.label, maxTokens: p.maxTokens });
      else {
        const row = read(`trial-${trial.label}.json`),
          raw = read(`responses/${row.responseId}.json`);
        assert.equal(raw.status, 200);
        assert.deepEqual(raw.request, { model, max_tokens: p.maxTokens, ...request });
        assert.equal(raw.tag, trial.label);
        const intent = ledger.find((r) => r.type === "intent" && r.id === row.responseId),
          receipt = ledger.find((r) => r.type === "receipt" && r.id === row.responseId);
        assert.equal(intent.promptHash, hash(raw.request));
        assert.deepEqual(receipt.usage, raw.response.usage);
        response = {
          id: row.responseId,
          content: raw.response.content,
          stopReason: raw.response.stop_reason,
          usd: usageCost(raw.response.usage),
        };
        assert.equal(response.usd, receipt.usd);
      }
      let speech = null,
        interfaceError = null;
      try {
        speech = publicReply(response);
      } catch (error) {
        interfaceError = error.message;
      }
      const row = {
        ...trial,
        responseId: response.id,
        speech,
        interfaceError,
        providerUsd: response.usd,
        semanticReviewRequired: true,
      };
      if (provider) write(`trial-${trial.label}.json`, row);
      else assert.deepEqual(row, read(`trial-${trial.label}.json`));
      rows.push(row);
      console.error(JSON.stringify({ label: trial.label, interfaceValid: !interfaceError }));
    }
    if (!provider) {
      assert.equal(ledger.filter((r) => r.type === "intent").length, rows.length);
      assert.equal(ledger.filter((r) => r.type === "receipt").length, rows.length);
    }
    const output = {
      status: "collected-awaiting-semantic-review",
      audit: !provider,
      trials: rows.length,
      interfacePassed: rows.filter((r) => !r.interfaceError).length,
      providerUsd: rows.reduce((s, r) => s + r.providerUsd, 0),
      cumulativeExposureUsd: prior + rows.reduce((s, r) => s + r.providerUsd, 0),
      rows,
      ...(provider ? { provider: provider.status() } : {}),
    };
    if (provider) write("complete.json", output);
    else write("audit.json", output);
    console.log(JSON.stringify({ ...output, rows: undefined }));
  } finally {
    if (lock !== null) {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
}
