// Portable Node alternative for hosts that already provide Node.js.
const fs = require("node:fs");
const path = require("node:path");
const task = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sources = task.sources.filter((s) => s.status === "current");
if (new Set(task.sources.map((s) => s.id)).size !== task.sources.length) throw new Error("Duplicate source identifier");
const findings = sources.map((s) => ({ metric: s.metric, value: s.value, sourceId: s.id, date: new Date(s.publishedAt).toISOString().slice(0, 10) }));
const conflict = sources.some((a) => sources.some((b) => a.metric === b.metric && a.value !== b.value));
const brief = { question: task.question, findings, uncertainties: [conflict ? "Sources conflict; verify definitions and time windows." : "General applicability remains uncertain."], recommendation: "Run a limited pilot while verifying unresolved evidence.", followUp: { owner: task.followUpOwner, action: "Confirm source definitions and report remaining uncertainty." } };
fs.writeFileSync(process.argv[3], JSON.stringify(brief));
const template = fs.readFileSync(path.join(__dirname, "../templates/brief.md"), "utf8");
const fields = { question: brief.question, findings: findings.map((f) => `- ${f.metric}: ${f.value} [${f.sourceId}, ${f.date}]`).join("\n"), uncertainties: brief.uncertainties.join("\n"), recommendation: brief.recommendation, ...brief.followUp };
fs.writeFileSync(process.argv[4], template.replace(/\{(\w+)\}/g, (_, key) => fields[key] ?? ""));
