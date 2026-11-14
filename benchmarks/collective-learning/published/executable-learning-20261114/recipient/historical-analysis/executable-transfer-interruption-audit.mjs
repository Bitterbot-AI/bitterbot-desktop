import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
const repo = '/mnt/d/Bitterbot/bitterbot-desktop';
const root = '/home/vicmg/.local/share/bitterbot-studies/executable-transfer-20261114-v2';
const out = path.join(repo, 'reports/collective-learning', path.basename(root));
const id = 'agent-evaluation-service-order-4203-frozen';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const record = await read(path.join(root, 'agent-records', id + '.json'));
assert.equal(record.outcome, 'interrupted');
assert.equal(record.cost, null);
const raw = await fs.readFile(path.join(root, 'sessions', record.runId + '.jsonl'), 'utf8');
assert.equal(digest(raw), record.sessionHash);
const messages = raw.split('\n').filter(Boolean).map(JSON.parse).filter(r => r.message).map(r => r.message);
const assistants = messages.filter(m => m.role === 'assistant');
const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
const terminal = assistants.at(-1);
assert.equal(terminal.stopReason, 'aborted');
assert.equal(terminal.content.length, 0);
assert(fields.every(k => terminal.usage[k] === 0));
assert(assistants.slice(0, -1).every(m => m.stopReason === 'toolUse' && m.usage));
assert(assistants.every(m => m.provider === 'anthropic' && m.model === 'claude-opus-4-8'));
const lastTool = messages.at(-2);
assert.equal(lastTool.role, 'toolResult');
assert.equal(lastTool.isError, true);
assert(JSON.stringify(lastTool.content).includes('Package trial tool budget exhausted'));
assert.equal(record.toolActions.length, 21);
assert(record.toolActions.slice(0, -1).every(t => t.result.length === 1));
const usage = Object.fromEntries(fields.map(k => [k, assistants.reduce((sum, m) => sum + m.usage[k], 0)]));
assert(fields.every(k => usage[k] === record.usage[k]));
const plan = await read(path.join(root, 'comparison-frozen.json'));
const observedProviderUsd = fields.reduce((sum, k) => sum + usage[k] * plan.rates[k], 0) / 1e6;

// This probe cannot contact a provider: a supplied fetch always throws if invoked.
const aiDir = await fs.realpath(path.join(repo, 'node_modules/@mariozechner/pi-ai'));
const require = createRequire(path.join(aiDir, 'package.json'));
const sdkEntry = require.resolve('@anthropic-ai/sdk');
const { default: Anthropic } = await import(pathToFileURL(sdkEntry).href);
let fetchCalls = 0;
const client = new Anthropic({ apiKey: 'offline-probe-not-a-credential', maxRetries: 0,
  fetch: async () => { fetchCalls++; throw new Error('Network forbidden in offline probe'); } });
const cancel = new AbortController(); cancel.abort();
let abortName;
try {
  await client.messages.stream({ model: 'claude-opus-4-8', max_tokens: 1,
    messages: [{ role: 'user', content: 'offline probe' }] }, { signal: cancel.signal }).finalMessage();
  assert.fail('Pre-aborted request unexpectedly completed');
} catch (error) { abortName = error.constructor.name; }
assert.equal(abortName, 'APIUserAbortError');
assert.equal(fetchCalls, 0);
const sdkDir = path.dirname(sdkEntry);
const sourceFiles = [
  path.join(repo, 'src/agents/skills/collective/execution-context.ts'),
  path.join(repo, 'src/agents/pi-embedded-runner/run/attempt.ts'),
  path.join(repo, 'src/agents/pi-embedded-runner/run.ts'),
  path.join(repo, 'node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js'),
  path.join(aiDir, 'dist/providers/anthropic.js'),
  path.join(sdkDir, 'src/client.ts'), path.join(sdkDir, 'src/lib/MessageStream.ts'),
];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async f => [path.relative(repo, f), digest(await fs.readFile(f))])));
const output = path.join(out, 'agent-outputs', id + '.docx');
assert.equal(digest(await fs.readFile(output)), record.outputHash);
const result = await promisify(execFile)('python3', ['-B', '-X', 'utf8',
  path.join(repo, 'research/collective-learning/executable-transfer-v2/checker.py'),
  path.join(repo, 'research/collective-learning/executable-transfer-v2/fixtures/evaluation', record.caseId), output]);
const supplementaryArtifactGrade = JSON.parse(result.stdout);
const db = new DatabaseSync(path.join(root, 'ledger.sqlite'), { readOnly: true });
const charge = db.prepare('SELECT * FROM study_charges WHERE id=?').get(id); db.close();
assert.equal(charge.state, 'unknown');
assert.equal(charge.cost, null);
const body = {
  schemaVersion: 1, createdAt: new Date().toISOString(), id, runId: record.runId,
  originalOutcome: record.outcome, originalRecordHash: digest(await fs.readFile(path.join(root, 'agent-records', id + '.json'))),
  sessionHash: record.sessionHash, outputHash: record.outputHash, originalCharge: charge,
  usage, observedProviderUsd, sourceHashes: sources,
  offlineProbe: { fetchCalls, abortName, providerCallsAuthorized: false },
  basis: [
    'Tool 21 is rejected synchronously by the host before execution, after completed toolUse responses with recorded usage.',
    'Cancellation reaches the session synchronously. The agent loop then attempts its next turn with an already-aborted signal.',
    'The installed Anthropic SDK checks that signal before fetch. The offline SDK probe confirms zero fetches.',
    'The only terminal assistant message has aborted status, empty content and all-zero usage. Every earlier assistant response has complete usage matching the runner total.',
    'This specific host cancellation occurred between model calls. It is not a general rule that zero-usage or timed-out requests are free.',
  ],
  costClassification: 'Reconciled usage-derived cost at frozen model rates; not invoice reconciliation. No unaccounted in-flight request identified for this between-calls host cancellation.',
  supplementaryArtifactGrade,
  outcomePolicy: 'The main outcome remains interrupted, with no completion message. The saved document grade is a separate post-interruption observation, excluded from checked matched-pair success.',
};
const receipt = { ...body, hash: digest(JSON.stringify(body)) };
await fs.writeFile(path.join(out, 'interruption-audit.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ id, observedProviderUsd, offlineProbe: body.offlineProbe, supplementaryArtifactGrade, hash: receipt.hash }));
