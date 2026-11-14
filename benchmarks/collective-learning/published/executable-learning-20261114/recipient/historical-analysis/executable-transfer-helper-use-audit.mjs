import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root = '/home/vicmg/.local/share/bitterbot-studies/executable-transfer-20261114-v2';
const out = '/mnt/d/Bitterbot/bitterbot-desktop/reports/collective-learning/executable-transfer-20261114-v2';
const records = [];
for (const file of (await fs.readdir(path.join(root, 'agent-records'))).filter(f => f.endsWith('-learned.json'))) {
  const r = JSON.parse(await fs.readFile(path.join(root, 'agent-records', file), 'utf8'));
  const raw = await fs.readFile(path.join(root, 'sessions', r.runId + '.jsonl'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), r.sessionHash);
  const results = raw.split('\n').filter(Boolean).map(JSON.parse).map(x => x.message).filter(m => m?.role === 'toolResult');
  const invocations = r.helperInvocations.map(call => {
    const result = results.find(m => m.toolCallId === call.id);
    const text = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const command = call.arguments.command;
    const pythonInvoked = /(?:^|&&|;|\n)\s*python3\s+(?:\/workspace\/)?skill\/helpers\/fill_docx\.py\s/.test(command);
    const echoOfExitStatus = /echo\s+["']EXIT(?::\s*|=)\$\?["']/.test(command);
    const explicitZero = /(?:^|\n)EXIT(?::\s*|=)0(?:\r?\n|$)/.test(text);
    const observedSuccessful = pythonInvoked && !result?.isError &&
      (echoOfExitStatus ? explicitZero : result?.details?.exitCode === 0);
    return { id: call.id, pythonInvoked, echoOfExitStatus, explicitZero, observedSuccessful,
      outputTextHash: crypto.createHash('sha256').update(text).digest('hex') };
  });
  records.push({ id: r.id, wholeSkillRead: r.reads.includes('SKILL.md'),
    successObserved: invocations.some(i => i.observedSuccessful), invocations });
}
const report = { records, allObserved: records.every(r => r.wholeSkillRead && r.successObserved),
  limits: 'Checks actual recorded Python invocation and helper exit-status output when echoed; shell exit 0 alone cannot certify a helper followed by echo. This is session/tool evidence, not OS-level access tracing.' };
console.log(JSON.stringify({ runs: records.length, allObserved: report.allObserved, records }));
if (process.argv.includes('--final')) {
  assert.equal(records.length, 12);
  assert(report.allObserved);
  await fs.writeFile(path.join(out, 'helper-use-audit.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
