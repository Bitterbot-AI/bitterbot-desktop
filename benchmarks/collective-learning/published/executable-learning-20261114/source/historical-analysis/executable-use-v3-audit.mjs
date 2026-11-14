import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const repo='/mnt/d/Bitterbot/bitterbot-desktop';
const root='/home/vicmg/.local/share/bitterbot-studies/executable-use-20261114-v3';
const out=path.join(repo,'reports/collective-learning',path.basename(root));
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const plan=await read(path.join(root,'comparison-frozen.json'));
const records=[];
const fields=['input','output','cacheRead','cacheWrite'];
const sumUsage=items=>Object.fromEntries(fields.map(k=>[k,items.reduce((n,u)=>n+(u[k]??0),0)]));
const cost=u=>fields.reduce((n,k)=>n+u[k]*plan.rates[k],0)/1e6;
for(const job of plan.schedule) {
  const r=await read(path.join(root,'agent-records',job.id+'.json'));
  const raw=await fs.readFile(path.join(root,'sessions',r.runId+'.jsonl'),'utf8');
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),r.sessionHash);
  const responses=raw.split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.message?.role==='assistant'&&x.message.usage);
  const usage=sumUsage(responses.map(x=>x.message.usage));
  const runnerUsage=sumUsage([r.usage]);
  const matches=fields.every(k=>usage[k]===runnerUsage[k]);
  records.push({id:r.id,caseId:r.caseId,arm:r.arm,outcome:r.outcome,
    observedAssistantResponses:responses.length,usage,runnerUsage,matches,
    observedProviderUsd:cost(usage),ledgerProviderUsd:r.cost?.providerUsd??null,
    costMatches:r.cost!==null&&Math.abs(cost(usage)-r.cost.providerUsd)<1e-9,
    latencyMs:r.latencyMs,checkerWallMs:r.checkerWallMs,agentLatencyMs:r.latencyMs-r.checkerWallMs,
    wholeSkillRead:r.reads.includes('SKILL.md'),observedHelperCommand:r.helperInvocations.length>0});
}
const median=xs=>{const a=xs.toSorted((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
const firstCase=plan.schedule[0].caseId;
const latency=['frozen','learned'].map(arm=>{
  const rs=records.filter(r=>r.arm===arm),rest=rs.filter(r=>r.caseId!==firstCase);
  return {arm,runs:rs.length,medianMs:median(rs.map(r=>r.latencyMs)),
    meanMs:rs.reduce((n,r)=>n+r.latencyMs,0)/rs.length,
    agentExcludingChecker:{medianMs:median(rs.map(r=>r.agentLatencyMs)),meanMs:rs.reduce((n,r)=>n+r.agentLatencyMs,0)/rs.length},
    excludingFirstPair:{runs:rest.length,medianMs:median(rest.map(r=>r.latencyMs)),meanMs:rest.reduce((n,r)=>n+r.latencyMs,0)/rest.length,
      agentMedianMs:median(rest.map(r=>r.agentLatencyMs)),agentMeanMs:rest.reduce((n,r)=>n+r.agentLatencyMs,0)/rest.length}};
});
const report={allUsageAgrees:records.every(r=>r.matches&&r.costMatches),records,latency,
  limits:'Observed assistant responses with usage are not an exact count of every attempted provider HTTP request. Latency sensitivity excludes the first pair from both arms as specified before comparison.'};
await fs.writeFile(path.join(out,'usage-and-latency-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({allUsageAgrees:report.allUsageAgrees,latency}));
assert(report.allUsageAgrees,'Reported usage differs from saved response usage; reconcile before claiming cost improvement');
