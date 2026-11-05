import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkFreeze } from "./procedure-protocol.mjs";
import { hash } from "./rediscovery2-provider.mjs";
import { verifyControllerSequence } from "./repair-learning-runtime.mjs";

const [command, rootArg, outArg] = process.argv.slice(2),
  root = path.resolve(rootArg),
  out = path.resolve(outArg);
assert.ok(["collect", "audit"].includes(command));
checkFreeze(root);
const readAt = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")),
  read = (n) => readAt(root, n),
  fileHash = (f) => hash(fs.readFileSync(f, "utf8"));
assert.equal(read("audit.json").status, "passed");
const p = read("protocol.json"),
  parent = path.join(path.dirname(root), p.sourceRun),
  old = readAt(parent, "retention.json").records.map((r) =>
    readAt(parent, `repair-${r.label}.json`),
  );
const knownInputs = new Set(old.filter((r) => r.status === "verified").map((r) => r.sourceHash)),
  seen = new Set(),
  selected = [];
for (const a of p.assignments) {
  const input = p.inputs.find((i) => i.alias === a.alias),
    attempt = read(`attempt-${a.label}.json`);
  if (knownInputs.has(input.sha256) || attempt.result.afterPassed !== true) continue;
  const actions = attempt.result.events
    .filter((e) => e.type === "action")
    .map((e) => ({
      tool: e.action.tool,
      args: Object.fromEntries(
        Object.entries(JSON.parse(e.action.argumentsJson)).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }));
  const key = hash({ input: input.sha256, actions });
  if (seen.has(key)) continue;
  seen.add(key);
  selected.push({
    label: a.label,
    sourceHash: input.sha256,
    sequenceHash: key,
    attemptHash: fileHash(path.join(root, `attempt-${a.label}.json`)),
  });
}
const selection = {
  kind: "post-collection-exploratory-repair-retention",
  rule: "All distinct successful primary action sequences on source inputs without a verified repair in the preceding study. Deduplicate by input hash and normalized ordered actions, first assigned representative. No hand-authored actions; no change to primary outcomes; exact-input evidence only.",
  sourceRun: path.basename(root),
  sourceAuditHash: fileHash(path.join(root, "audit.json")),
  providerCalls: 0,
  selected,
};
const write = (n, v) =>
  fs.writeFileSync(path.join(out, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
if (command === "collect") {
  assert.ok(!fs.existsSync(out));
  fs.mkdirSync(out);
  write("selection.json", selection);
  fs.copyFileSync(
    new URL(import.meta.url),
    path.join(out, "retention-source.mjs"),
    fs.constants.COPYFILE_EXCL,
  );
} else {
  assert.deepEqual(selection, readAt(out, "selection.json"));
  assert.equal(
    fileHash(new URL(import.meta.url)),
    fileHash(path.join(out, "retention-source.mjs")),
  );
}
const records = [];
for (const row of selected) {
  const assignment = p.assignments.find((a) => a.label === row.label),
    input = p.inputs.find((i) => i.alias === assignment.alias);
  assert.equal(fileHash(path.join(root, input.input)), input.sha256);
  const record = await verifyControllerSequence({
    assignment,
    source: { index: input.index, episode: read(input.input) },
    attempt: read(`attempt-${assignment.label}.json`),
  });
  record.sourceHash = input.sha256;
  record.attemptHash = row.attemptHash;
  if (command === "collect") write(`repair-${row.label}.json`, record);
  else assert.deepEqual(record, readAt(out, `repair-${row.label}.json`));
  records.push({
    label: row.label,
    index: input.index,
    status: record.status,
    necessaryOnInput: record.necessaryOnInput,
    replays: record.rows.length,
  });
  console.log(JSON.stringify(records.at(-1)));
}
write(command === "collect" ? "complete.json" : "audit.json", {
  status: command === "collect" ? "complete" : "passed",
  providerCalls: 0,
  records,
  note: "Post-collection exact-input repair/omission evidence. No generalized or recipient benefit. The audit repeats every full and omission replay after checking the unchanged frozen execution source.",
});
