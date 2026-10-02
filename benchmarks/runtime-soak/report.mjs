// Summarise the soak driver's results: scenarios passed per agent, the checks
// that failed, and runs, model calls, errors and spend from the usage ledger.
//
//   node benchmarks/runtime-soak/report.mjs [tagPrefix[,tagPrefix...]]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const state = path.join(os.homedir(), ".bitterbot");
const tags = (process.argv[2] ?? "s").split(",");
const rows = fs
  .readFileSync(path.join(state, "eval/runtime-soak/results.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => tags.some((t) => r.tag.startsWith(t)));
const by = new Map();
for (const r of rows) {
  const key = `${r.agent} [${r.engine}/${r.policy}]`;
  const g = by.get(key) ?? { scen: new Map(), checks: new Map(), n: 0, ok: 0, ms: [] };
  g.n++;
  if (r.ok) g.ok++;
  g.ms.push(r.ms);
  const s = g.scen.get(r.scenario) ?? { n: 0, ok: 0 };
  s.n++;
  if (r.ok) s.ok++;
  g.scen.set(r.scenario, s);
  for (const c of r.checks) {
    const name = c.name.replace(/bigread \d+/, "bigread N");
    const k = g.checks.get(name) ?? { n: 0, ok: 0 };
    k.n++;
    if (c.ok) k.ok++;
    g.checks.set(name, k);
  }
  by.set(key, g);
}
for (const [key, g] of by) {
  console.log(`\n${key}: ${g.ok}/${g.n} scenarios passed`);
  console.log("  " + [...g.scen].map(([s, v]) => `${s} ${v.ok}/${v.n}`).join(", "));
  const failing = [...g.checks].filter(([, v]) => v.ok < v.n);
  for (const [name, v] of failing) console.log(`  ✗ ${v.n - v.ok}/${v.n}  ${name}`);
}
const db = new DatabaseSync(path.join(state, "usage-ledger.sqlite"), { readOnly: true });
console.log("\nledger, soak sessions:");
for (const r of db
  .prepare(
    "SELECT agent_id a, COALESCE(engine,'-') e, COUNT(DISTINCT run_id) runs, COUNT(*) calls, ROUND(SUM(cost_total),2) usd, SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) errs FROM usage_events WHERE session_key LIKE '%:soak-%' AND kind='chat' GROUP BY 1,2",
  )
  .all())
  console.log(
    `  ${r.a} engine=${r.e} runs=${r.runs} model calls=${r.calls} errors=${r.errs} $${r.usd}`,
  );
for (const r of db
  .prepare(
    "SELECT agent_id a, COUNT(*) n, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) bad FROM tool_calls WHERE session_key LIKE '%:soak-%' GROUP BY 1",
  )
  .all())
  console.log(`  ${r.a} tool calls=${r.n} tool errors=${r.bad}`);
