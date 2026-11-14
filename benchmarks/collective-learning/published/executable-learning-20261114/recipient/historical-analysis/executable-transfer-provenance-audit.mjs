import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const repo='/mnt/d/Bitterbot/bitterbot-desktop';
const out=path.join(repo,'reports/collective-learning/executable-transfer-20261114-v2');
const read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const frozen=await read('frozen.json'),amendment=await read('continuation-amendment.json'),audit=await read('interruption-audit.json');
for(const [file,hash] of Object.entries(frozen.sources))assert.equal(sha(await fs.readFile(path.join(repo,file))),hash,file);
assert.equal(sha(await fs.readFile(path.join(repo,amendment.runner))),amendment.runnerHash);
for(const [file,hash] of Object.entries(audit.sourceHashes))assert.equal(sha(await fs.readFile(path.join(repo,file))),hash,file);
const propagationSources={};
for(const file of ['node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js','node_modules/@mariozechner/pi-agent-core/dist/agent.js'])
  propagationSources[file]=sha(await fs.readFile(path.join(repo,file)));
const result={checkedAt:new Date().toISOString(),allMatched:true,frozenSourceFiles:Object.keys(frozen.sources).length,
  frozenHash:frozen.hash,continuationRunnerHash:amendment.runnerHash,cancellationAuditHash:audit.hash,
  cancellationDependencySourcesVerified:Object.keys(audit.sourceHashes).length,propagationSources,
  propagationReview:'Installed AgentSession.abort calls this.agent.abort before its first await; Agent.abort synchronously aborts its controller. These additional source hashes supplement the preserved between-calls reconciliation.',
  limit:'Confirms current source bytes still match the frozen execution snapshot; not a claim of monitoring every filesystem change during execution.'};
await fs.writeFile(path.join(out,'frozen-source-verification.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
