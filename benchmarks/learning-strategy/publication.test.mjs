import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("published/telecom-repair-reuse-v1/", import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

test("published files retain their recorded SHA-256 hashes", () => {
  const manifest = read("manifest.json");
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, file)))
        .digest("hex"),
      hash,
      file,
    );
  }
  assert.equal(manifest.sourceAnalysisHash, manifest.files["evidence/analysis.json"]);
  assert.equal(manifest.sourceAuditHash, manifest.files["evidence/audit.json"]);
});

test("headline counts reconcile to all assigned trials, retaining failures", () => {
  const analysis = read("evidence/analysis.json");
  const trials = fs
    .readFileSync(path.join(root, "evidence/trials.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(trials.length, 148);
  assert.equal(new Set(trials.map((r) => r.label)).size, 148);
  assert.equal(trials.filter((r) => r.scope === "primary").length, 60);
  assert.equal(trials.filter((r) => r.scope === "panel").length, 88);
  assert.equal(analysis.gatePassed, false);
  assert.equal(trials.filter((r) => r.falseSelfVerification).length, 4);
  for (const candidate of ["candidate-0", "candidate-1"]) {
    for (const arm of ["advice", "compiled"]) {
      const rows = trials.filter(
        (r) => r.scope === "primary" && r.arm === arm && r.candidate === candidate,
      );
      assert.equal(rows.length, 12);
      assert.equal(rows.filter((r) => r.afterPassed).length, 6);
    }
    const panel = trials.filter((r) => r.scope === "panel" && r.candidate === candidate);
    assert.equal(panel.filter((r) => !r.beforePassed).length, 28);
    assert.equal(panel.filter((r) => !r.beforePassed && r.afterPassed).length, 12);
    const healthy = panel.filter((r) => r.beforePassed);
    assert.equal(healthy.length, 16);
    assert.ok(healthy.every((r) => r.afterPassed && r.writes === 0));
  }
  assert.ok(trials.filter((r) => r.arm === "compiled").every((r) => r.modelCalls === 0));
});
