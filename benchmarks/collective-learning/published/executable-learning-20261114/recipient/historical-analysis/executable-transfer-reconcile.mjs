import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const repo = '/mnt/d/Bitterbot/bitterbot-desktop';
const root = '/home/vicmg/.local/share/bitterbot-studies/executable-transfer-20261114-v2';
const out = path.join(repo, 'reports/collective-learning', path.basename(root));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const audit = JSON.parse(await fs.readFile(path.join(out, 'interruption-audit.json'), 'utf8'));
const { hash, ...body } = audit;
assert.equal(hash, '890eea9c2f05b10d4f179df00375d0fa2195fcba993ca4205aa088272f18a90b');
assert.equal(digest(JSON.stringify(body)), hash);
assert.equal(audit.offlineProbe.fetchCalls, 0);
const raw = await fs.readFile(path.join(root, 'agent-records', audit.id + '.json'));
assert.equal(digest(raw), audit.originalRecordHash);
const record = JSON.parse(raw);
assert.equal(digest(await fs.readFile(path.join(root, 'sessions', record.runId + '.jsonl'))), audit.sessionHash);
const cost = { providerUsd: audit.observedProviderUsd, toolCalls: record.toolActions.length, wallMs: record.latencyMs };
const db = new DatabaseSync(path.join(root, 'ledger.sqlite'));
db.exec('BEGIN IMMEDIATE');
try {
  const row = db.prepare('SELECT * FROM study_charges WHERE id=?').get(audit.id);
  assert.deepEqual({ ...row }, audit.originalCharge);
  const observation = JSON.parse(row.observation);
  assert.equal(observation.success, null);
  assert.equal(observation.checked, false);
  observation.cost = cost;
  observation.latencyMs = cost.wallMs;
  db.exec('CREATE TABLE IF NOT EXISTS study_cost_reconciliations(id TEXT PRIMARY KEY, original_row TEXT NOT NULL, receipt TEXT NOT NULL)');
  db.prepare('INSERT INTO study_cost_reconciliations VALUES (?,?,?)').run(audit.id, JSON.stringify(row), JSON.stringify(audit));
  const result = db.prepare("UPDATE study_charges SET state='settled',cost=?,observation=? WHERE id=? AND state='unknown' AND cost IS NULL")
    .run(JSON.stringify(cost), JSON.stringify(observation), audit.id);
  assert.equal(result.changes, 1);
  // Original artifact and immutable per-run record retain the interruption and null original cost.
  assert.equal(db.prepare('SELECT artifact FROM study_charges WHERE id=?').get(audit.id).artifact, row.artifact);
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
const receipt = { id: audit.id, auditHash: hash, reconciledAt: new Date().toISOString(), cost,
  releasedReserveUsd: 7.2 - cost.providerUsd, outcomeUnchanged: true,
  originalRowPreserved: 'study_cost_reconciliations', originalRecordUnchanged: true };
await fs.writeFile(path.join(out, 'cost-reconciliation.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
