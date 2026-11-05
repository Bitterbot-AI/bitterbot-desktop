// Post-collection audit and descriptive failure analysis; not a selection rule.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyze } from "./analyze.mjs";

const root = path.resolve(process.argv[2]);
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const jsonl = (name) =>
  fs.readFileSync(path.join(root, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const analysis = analyze(root);
const protocol = read("protocol.json");
const ledger = jsonl("provider.jsonl");
const intents = new Map(ledger.filter((r) => r.type === "intent").map((r) => [r.id, r]));
const stops = {};
let recomputedUsd = 0;
for (const receipt of ledger.filter((r) => r.type === "receipt")) {
  const raw = read(`responses/${receipt.id}.json`),
    intent = intents.get(receipt.id);
  if (
    raw.status !== 200 ||
    raw.response.model !== protocol.model ||
    raw.tag !== intent.tag ||
    JSON.stringify(raw.response.usage) !== JSON.stringify(receipt.usage) ||
    createHash("sha256").update(raw.prompt).digest("hex") !== intent.promptHash
  )
    throw Error(`Raw response/receipt mismatch: ${receipt.id}`);
  const u = raw.response.usage,
    rates = protocol.rates;
  const usd =
    (u.input_tokens * rates.input +
      u.output_tokens * rates.output +
      (u.cache_read_input_tokens ?? 0) * rates.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * rates.cacheWrite) /
    1e6;
  if (Math.abs(usd - receipt.usd) > 1e-10 || usd > intent.quote)
    throw Error("Raw usage cost mismatch or reservation overrun");
  recomputedUsd += usd;
  stops[raw.response.stop_reason] = (stops[raw.response.stop_reason] ?? 0) + 1;
}
if (Math.abs(recomputedUsd - analysis.physicalProviderUsd) > 1e-8)
  throw Error("Provider total mismatch");
const freeze = read("freeze.json");
const frozenWorld = freeze.sources.find((s) => s.file.endsWith("/world.mjs"));
const world = await import(pathToFileURL(path.join(root, frozenWorld.snapshot)).href);
const events = jsonl("events.jsonl");
const diagnostics = {
  episodes: 0,
  passed: 0,
  invalidAction: 0,
  failedInconsistentSubmission: 0,
  failedConsistentSubmission: 0,
  noConsistentHypothesis: 0,
};
for (const trial of events.filter((r) => r.kind === "trial")) {
  diagnostics.episodes++;
  const [domain, version] = trial.task.split(":");
  const possible = world
    .hypotheses(domain, Number(version))
    .filter((h) =>
      trial.output.history.every(
        ({ probe, result }) =>
          JSON.stringify(world.apply(domain, h, probe)) === JSON.stringify(result),
      ),
    );
  if (!possible.length) diagnostics.noConsistentHypothesis++;
  if (trial.passed) diagnostics.passed++;
  else if (trial.output.invalid) diagnostics.invalidAction++;
  else if (possible.some((h) => h.id === trial.output.id)) diagnostics.failedConsistentSubmission++;
  else diagnostics.failedInconsistentSubmission++;
}
const panels = fs
  .readdirSync(root)
  .filter((f) => f.endsWith("-panel.json"))
  .map(read);
const controls = panels.flatMap((panel) => panel.diagnosticControl ?? []);
const result = {
  postHoc: true,
  recomputedUsd,
  receiptsChecked: analysis.calls,
  stops,
  diagnostics,
  invalidProposals: events.filter((r) => r.kind === "invalid-proposal").length,
  deterministicControl: { passed: controls.filter((r) => r.passed).length, total: controls.length },
  interpretation:
    "Descriptive failure categories across all development and final episodes, including reused tasks. They are not independent observations or causal treatment effects. A wrong consistent submission indicates probes left behavior unresolved; inconsistent submissions indicate tracking/calculation/action errors.",
};
fs.writeFileSync(path.join(root, "audit.json"), JSON.stringify(result, null, 2), { flag: "wx" });
console.log(JSON.stringify(result, null, 2));
