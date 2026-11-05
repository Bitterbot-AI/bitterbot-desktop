import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  prerequisiteSnapshot,
  withPrerequisiteLedger,
  TRAVEL_QUESTION,
} from "./prerequisite-ledger.mjs";
import { checkFreeze } from "./procedure-protocol.mjs";
import { hash } from "./provider.mjs";
const root = "benchmarks/learning-strategy/results/telecom-procedure-source-v1";
checkFreeze(root);
const read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
assert.equal(read("audit.json").status, "passed");
const rows = [];
let projectedCalls = 0,
  peakBytes = 0;
for (const entry of read("complete.json").executionManifest) {
  const episode = read(`episode-${entry.label}.json`);
  let last;
  for (const response of episode.transcript.filter((t) => t.id && t.seat === "actor")) {
    const raw = read(`responses/${response.id}.json`),
      before = hash(raw.request),
      projected = withPrerequisiteLedger(raw.request);
    assert.equal(hash(raw.request), before);
    assert.deepEqual(projected.snapshot, prerequisiteSnapshot(raw.request.messages));
    peakBytes = Math.max(peakBytes, Buffer.byteLength(JSON.stringify(projected.request)));
    assert.ok(Buffer.byteLength(JSON.stringify(projected.request)) <= 140000);
    assert.deepEqual(projected.request.system, raw.request.system);
    assert.deepEqual(projected.request.tools, raw.request.tools);
    last = projected.snapshot;
    projectedCalls++;
  }
  rows.push({ label: entry.label, originalPassed: episode.verdict.passed, lastSnapshot: last });
}
const failed = rows.filter((r) => !r.originalPassed);
assert.equal(failed.length, 7);
// Refueling invalidates previously read account facts. Do not revive old false
// values merely because final-state review later confirmed the same value.
assert.equal(
  failed.filter((r) => r.lastSnapshot.facts["account.roamingEnabled"].value === false).length,
  5,
);
assert.equal(
  failed.filter((r) => r.lastSnapshot.facts["account.roamingEnabled"].value === "unknown").length,
  2,
);
assert.ok(
  failed.every(
    (r) =>
      r.lastSnapshot.facts["customer.abroad"].value === "unknown" &&
      r.lastSnapshot.pending.some((p) => p.includes(TRAVEL_QUESTION)),
  ),
);
console.log(
  JSON.stringify(
    {
      status: "passed",
      episodes: rows.length,
      projectedActorCalls: projectedCalls,
      peakProjectedRequestBytes: peakBytes,
      failedHandoffsWithUnknownTravel: failed.length,
      newProviderCalls: 0,
      originalOutcomesChanged: false,
      note: "Offline request projection only; no model responded to the injected ledger. This qualifies coverage and serialization, not task benefit.",
      rows,
    },
    null,
    2,
  ),
);
