import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const repo = process.cwd();
const out = path.join(repo, 'reports/collective-learning/executable-transfer-20261114-v2');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const audit = await read(path.join(out, 'interruption-audit.json'));
const cost = await read(path.join(out, 'cost-reconciliation.json'));
const file = path.join(repo, 'research/collective-learning/executable-transfer-continuation/run.ts');
let source = await fs.readFile(path.join(repo, 'research/collective-learning/executable-transfer-v2/run.ts'), 'utf8');
const replace = (from, to) => { assert(source.includes(from), 'Missing exact source fragment'); source = source.replace(from, to); };
replace('import type { Cost } from "./study.js";', 'import type { Cost } from "../executable-transfer-v2/study.js";');
replace('await import("./study.js")', 'await import("../executable-transfer-v2/study.js")');
replace('const [\n', `const amendment = await read<{runnerHash:string; allowedInterruptedId:string; originalRecordHash:string; auditHash:string}>(path.join(exported, "continuation-amendment.json"));
assert.equal(crypto.createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex"), amendment.runnerHash);
const receipt = await read<{hash:string}>(path.join(exported, "interruption-audit.json"));
assert.equal(receipt.hash, amendment.auditHash);
const [\n`);
replace('const dir = path.dirname(fileURLToPath(import.meta.url));', 'const dir = suite; // Verify the original frozen driver suite unchanged.');
replace('const completed = await read<{ completePairs: number }>', 'const completed = await read<{ attemptedPairs: number }>');
replace('assert.equal(completed.completePairs, 12);', 'assert.equal(completed.attemptedPairs, 12);\n  assert.equal(ledger.unresolved(), 0);');
replace('assert(record.cost && ["pass", "task-failure"].includes(record.outcome));\n          continue;', `if (job.id === amendment.allowedInterruptedId) {
            assert.equal(record.outcome, "interrupted");
            assert.equal(record.cost, null);
            assert.equal(crypto.createHash("sha256").update(await fs.readFile(recordPath)).digest("hex"), amendment.originalRecordHash);
            const reconciled = db.prepare("SELECT receipt FROM study_cost_reconciliations WHERE id=?").get(job.id) as {receipt:string}|undefined;
            assert(reconciled);
            assert.equal((JSON.parse(reconciled.receipt) as {hash:string}).hash, amendment.auditHash);
            const charge = db.prepare("SELECT state,cost FROM study_charges WHERE id=?").get(job.id) as {state:string;cost:string};
            assert.equal(charge.state, "settled"); assert(charge.cost);
          } else assert(record.cost && ["pass", "task-failure"].includes(record.outcome));
          continue;`);
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, source, { flag: 'wx' });
const amendment = {
  schemaVersion: 1, createdAt: new Date().toISOString(),
  originalFreeze: 'bfbc663d9cfa389dca81ebccbf89927b14965e79759f91fd820030616cc308e5',
  runner: path.relative(repo, file).replaceAll(path.sep, '/'), runnerHash: sha(source),
  allowedInterruptedId: audit.id, originalRecordHash: audit.originalRecordHash, auditHash: audit.hash,
  reconciledCostUsd: cost.cost.providerUsd,
  purpose: 'Resume only the 16 unstarted jobs in the original preselected schedule after inspecting and reconciling one host tool-limit interruption. No retry or replacement.',
  unchanged: ['package', 'fixtures', 'task prompt', 'model', 'environment', '20-tool limit', '300-second deadline', 'original sequence', '$20 combined stage cap', '$250 total authority'],
  outcomePolicy: 'Keep the interrupted run in the attempted denominator and all-cost totals. Exclude it from completed matched-pair correctness and cost-per-completion analyses; report its supplementary passing artifact separately. Report all 12 scheduled pairs and 11 possible fully checked pairs without claiming a complete 12-pair endpoint.',
  retentionPolicy: 'After all 24 scheduled evaluation attempts and the original >=24-hour deadline, six learned-only retention cases remain eligible under the same $20 ledger. Require zero unresolved costs; retention does not replace the interrupted comparison.',
  stopPolicy: 'Any new interruption, unknown cost, invalid checker, source change or admission failure stops the continuation for inspection. Historical $28.80 holds remain reserved.',
  claim: 'Post-interruption continuation of a development pilot, transparently amended after observed outcomes. No powered collective-learning efficacy claim.',
};
await fs.writeFile(path.join(out, 'continuation-amendment.json'), JSON.stringify(amendment, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ runnerHash: amendment.runnerHash, remainingJobs: 16, stageCapUsd: 20 }));
