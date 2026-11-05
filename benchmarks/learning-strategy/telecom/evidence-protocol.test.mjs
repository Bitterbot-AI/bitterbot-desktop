import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clusterInterval,
  EVIDENCE_PROFILES,
  evidenceSchedule,
  interfaceGate,
} from "./evidence-protocol.mjs";
import { createProvider, priorExposure } from "./provider.mjs";
test("prospective stages have disjoint cases and balanced complete assignments", () => {
  const { compliance, comparison } = EVIDENCE_PROFILES;
  assert.ok(compliance.indices.every((i) => !comparison.indices.includes(i)));
  for (const [name, profile] of Object.entries(EVIDENCE_PROFILES)) {
    const blocks = evidenceSchedule(profile),
      keys = blocks.flatMap((b) => b.indices.map((i) => `${b.arm}:${b.repetition}:${i}`));
    assert.equal(keys.length, name === "compliance" ? 6 : 81);
    assert.equal(new Set(keys).size, keys.length);
    for (const b of blocks)
      assert.deepEqual(
        [...b.indices].sort((a, b) => a - b),
        profile.indices,
      );
    if (name === "comparison")
      for (const arm of profile.arms)
        assert.equal(
          new Set(
            blocks
              .map((b, i) => ({ b, i }))
              .filter(({ b }) => b.arm === arm)
              .map(({ i }) => i % 3),
          ).size,
          3,
        );
  }
});
test("interface gate retains failures and requires fresh evidence without task success", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    label: String(i),
    index: i % 3,
    termination: "human-transfer",
    nonemptyReports: 1,
    refreshedFacts: 1,
    reminders: 0,
  }));
  assert.equal(interfaceGate(rows, 6).passed, true);
  assert.equal(interfaceGate(rows.slice(1), 6).passed, false);
  rows[0].termination = "simulator-observation-failure";
  assert.equal(interfaceGate(rows, 6).passed, false);
  assert.deepEqual(interfaceGate(rows, 6).invalid, ["0"]);
  rows[0].termination = "user-ended";
  rows[0].nonemptyReports = 0;
  assert.equal(interfaceGate(rows, 6).passed, false);
});
test("cluster intervals keep cases as units and reproduce deterministic bounds", () => {
  assert.equal(clusterInterval([]), null);
  const same = clusterInterval([0.5, 0.5, 0.5]);
  assert.equal(same.low, 0.5);
  assert.equal(same.high, 0.5);
  const a = clusterInterval([-1, 0, 1]);
  assert.deepEqual(a, clusterInterval([-1, 0, 1]));
  assert.equal(a.mean, 0);
  assert.ok(a.low < 0 && a.high > 0);
});

test("independent concurrent provider lanes preserve unique intents, reservations and receipts in one ledger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telecom-lane-test-")),
    root = path.join(dir, "run");
  fs.mkdirSync(root);
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "offline-test-credential";
  const waiting = [];
  try {
    const transport = (_url, options) =>
      new Promise((resolve) =>
        waiting.push(() =>
          resolve(
            new Response(
              JSON.stringify({
                model: JSON.parse(options.body).model,
                content: [{ type: "text", text: "offline" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 100, output_tokens: 10 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      );
    const providers = [
      createProvider(root, 0.25, transport),
      createProvider(root, 0.25, transport),
    ];
    const calls = providers.map((p, i) =>
      p.call(
        { messages: [{ role: "user", content: "Offline test" }] },
        { tag: `conditional-${i}-3:user:0` },
      ),
    );
    assert.equal(waiting.length, 2);
    const pending = priorExposure(dir);
    assert.equal(pending.length, 2);
    assert.ok(pending.every((r) => r.unresolved));
    assert.equal(new Set(pending.map((r) => r.id)).size, 2);
    waiting[1]();
    waiting[0]();
    await Promise.all(calls);
    const settled = priorExposure(dir);
    assert.equal(settled.length, 2);
    assert.ok(settled.every((r) => !r.unresolved));
    assert.ok(providers.every((p) => p.status().reserved === 0 && p.status().unresolved === 0));
    assert.ok(Math.abs(settled.reduce((s, r) => s + r.usd, 0) - 0.0009) < 1e-12);
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = old;
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
