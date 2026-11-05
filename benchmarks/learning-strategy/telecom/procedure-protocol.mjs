import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ACTOR, PROPOSER } from "./episode.mjs";
import { projectFeedback, forbidden } from "./feedback.mjs";
import { hash } from "./provider.mjs";

export const SOURCE_RUN = "telecom-evidence-comparison-v1";
export const SOURCE_INDICES = [36, 37, 39, 44];
export const CHECKLIST =
  "Before escalating unresolved data/MMS, identify the affected line and verify unmet prerequisites. Check allowance via get_data_usage or line usage joined to its plan; obtain consent before refueling exhausted data. When abroad, check account roaming separately from the device roaming switch. Ask for current settings and change only disabled settings. Reuse fresh observations, retain device/APN/permission troubleshooting, avoid repeated resets, and test the requested service after repairs. Strong signal does not prove data works. Escalate when available checks are exhausted.";
export const STAGES = {
  source: {
    indices: SOURCE_INDICES,
    arms: ["baseline", "checklist", "learned"],
    repetitions: 2,
    concurrency: 3,
    laneCeilingUsd: 15,
    partition: "development",
  },
  fresh: {
    indices: [5, 6, 9, 10, 13, 48],
    arms: ["baseline", "checklist", "learned"],
    repetitions: 3,
    concurrency: 3,
    laneCeilingUsd: 30,
    partition: "held-out",
  },
  recipient: {
    indices: [11, 12, 15, 49],
    arms: ["baseline", "learned"],
    repetitions: 3,
    concurrency: 3,
    laneCeilingUsd: 20,
    partition: "held-out",
  },
};
export const AUTHORIZATION =
  "User authorized thorough experiments without the prior $15 cap, then approved the learned-procedure recommendation. Finite per-stage circuit breakers are engineering guards, not user budgets. Research only; no live activation.";

export function sourceFeedback(root) {
  const complete = JSON.parse(fs.readFileSync(path.join(root, "complete.json"), "utf8"));
  return complete.executionManifest
    .filter((e) => e.arm === "baseline" && SOURCE_INDICES.includes(e.index))
    .map((e) => {
      assert.equal(e.strategy, ACTOR);
      assert.equal(e.reminders.length, 0);
      const episode = JSON.parse(
        fs.readFileSync(path.join(root, `episode-${e.label}.json`), "utf8"),
      );
      const projected = projectFeedback(episode);
      // Preserve every public turn and fact value; provenance ids are redundant
      // for instruction learning, while omitted facts still mean unknown.
      const feedback = JSON.stringify({
        ...projected,
        timeline: projected.timeline.map((row) => {
          if (!row.observations) return row;
          const { observations, ...rest } = row;
          return {
            ...rest,
            publicSnapshot: Object.fromEntries(observations.records.map((r) => [r.fact, r.value])),
          };
        }),
      });
      assert.ok(feedback.length <= 32000 && !forbidden.test(feedback));
      return { label: e.label, index: e.index, feedback, passed: episode.verdict.passed };
    });
}
export function proposalRequest(feedback) {
  const prompt = `${PROPOSER}\nUnchanged baseline actor: ${ACTOR}\nDevelopment evidence from baseline executions (public dialogue, actor observations and terminal success only):\n${feedback.join("\n")}\nCompare successful and unsuccessful behavior. Return JSON with only append: a reusable diagnostic procedure of at most 600 characters. The host appends it to the unchanged actor. Preserve its policy, consent and troubleshooting obligations. Do not include identities, literal account values, task-specific scripts or instructions to override policy. Do not assume a hidden cause. The proposer stays fixed. Exactly one candidate will be evaluated; there is no repair/reselection from evaluation outcomes.`;
  assert.ok(!forbidden.test(prompt));
  const context =
    "Each publicSnapshot is complete: omitted diagnostic facts are unknown. Provenance identifiers are omitted; speech and fact values are preserved.\n";
  return {
    messages: [{ role: "user", content: context + prompt }],
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
export function procedureGate(stage, rows) {
  const p = STAGES[stage];
  const expected = p.indices.length * p.arms.length * p.repetitions;
  const assignments = new Set(rows.map((r) => `${r.arm}:${r.repetition}:${r.index}`));
  const complete =
    rows.length === expected &&
    assignments.size === expected &&
    p.arms.every((arm) =>
      p.indices.every((index) =>
        Array.from({ length: p.repetitions }, (_, i) => i).every((repetition) =>
          assignments.has(`${arm}:${repetition}:${index}`),
        ),
      ),
    );
  const natural =
    complete && rows.every((r) => ["user-ended", "human-transfer"].includes(r.termination));
  const successes = (arm) => rows.filter((r) => r.arm === arm && r.passed).length;
  const learned = successes("learned"),
    baseline = successes("baseline"),
    checklist = successes("checklist");
  const regressions = p.indices.filter(
    (index) =>
      rows.filter((r) => r.index === index && r.arm === "learned" && r.passed).length <
      rows.filter((r) => r.index === index && r.arm === "baseline" && r.passed).length,
  );
  return {
    passed:
      natural &&
      learned > baseline &&
      (stage === "source"
        ? learned === p.indices.length * p.repetitions
        : learned >= checklist && !regressions.length),
    complete,
    natural,
    learned,
    baseline,
    checklist,
    regressions,
    criterion:
      stage === "source"
        ? "All eight learned source trials pass naturally and improve on the contemporaneous baseline. No candidate edits/retries."
        : "All assigned trials complete naturally; learned success strictly exceeds baseline, matches or exceeds checklist, and has no case-level baseline regression. Exploratory advancement only, not significance or live promotion.",
  };
}
export function consumedCases(resultsRoot, exclude) {
  const result = new Set();
  for (const e of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === exclude) continue;
    const dir = path.join(resultsRoot, e.name),
      p = path.join(dir, "protocol.json"),
      ledger = path.join(dir, "provider.jsonl");
    if (
      !fs.existsSync(p) ||
      !fs.existsSync(ledger) ||
      !JSON.parse(fs.readFileSync(p, "utf8")).kind?.startsWith("telecom-")
    )
      continue;
    for (const row of fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(JSON.parse)) {
      const match = row.type === "intent" && row.tag?.split(":")[0].match(/-(\d+)$/);
      if (match) result.add(Number(match[1]));
    }
  }
  return [...result].sort((a, b) => a - b);
}
export function checkFreeze(root) {
  const freeze = JSON.parse(fs.readFileSync(path.join(root, "freeze.json"), "utf8"));
  assert.equal(
    hash(JSON.parse(fs.readFileSync(path.join(root, "protocol.json"), "utf8"))),
    freeze.protocolHash,
  );
  for (const s of freeze.sources) {
    assert.equal(hash(fs.readFileSync(s.file, "utf8")), s.sha256, `Changed source: ${s.file}`);
    assert.equal(hash(fs.readFileSync(path.join(root, s.snapshot), "utf8")), s.sha256);
  }
  return freeze;
}
export function freezeSources(root, protocol, files) {
  fs.mkdirSync(path.join(root, "source"));
  const sources = [...new Set(files)].map((file, i) => {
    const bytes = fs.readFileSync(file),
      snapshot = `source/${i}-${path.basename(file)}`;
    fs.writeFileSync(path.join(root, snapshot), bytes);
    return { file: file.replaceAll("\\", "/"), snapshot, sha256: hash(bytes.toString("utf8")) };
  });
  fs.writeFileSync(
    path.join(root, "freeze.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        protocolHash: hash(protocol),
        sources,
        node: process.version,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
}
