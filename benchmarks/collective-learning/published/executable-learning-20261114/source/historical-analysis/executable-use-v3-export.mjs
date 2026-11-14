import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../..',import.meta.url));
const root='/home/vicmg/.local/share/bitterbot-studies/executable-use-20261114-v3';
const out=path.join(repo,'reports/collective-learning',path.basename(root));
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const write=async (file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const baseline=await read(path.join(out,'baseline.json'));
const validation=await read(path.join(out,'validate.json')).catch(()=>({records:[],qualified:false}));
const proposal=await read(path.join(out,'proposal.json')).catch(()=>null);
const failed=await read(path.join(out,'proposal-failed.json')).catch(()=>null);
const comparison=await read(path.join(out,'comparison-readout.json')).catch(()=>null);
const diagnostic=await read(path.join(out,'proposal-execution.json')).catch(()=>null);
const groups=['selection','selection-invalid','evaluation','evaluation-invalid','regression'];
const rows=(proposal?['parent','candidate','control']:['parent','control']).map(arm=>({arm,
  partitions:Object.fromEntries(groups.map(partition=>{
    const records=[...baseline.records,...validation.records].filter(r=>r.arm===arm&&r.partition===partition);
    return [partition,{passed:records.filter(r=>r.grade.status==='pass').length,total:records.length}];
  }))}));
const paired=baseline.records.filter(r=>r.arm==='parent' && validation.records.some(c=>c.caseId===r.caseId)).map(p=>({parent:p,candidate:validation.records.find(c=>c.caseId===p.caseId)}));
assert(paired.every(p=>p.candidate));
const improvements=paired.filter(p=>p.parent.grade.status!=='pass'&&p.candidate.grade.status==='pass');
const regressions=paired.filter(p=>p.parent.grade.status==='pass'&&p.candidate.grade.status!=='pass');
const result={schemaVersion:1,generatedAt:new Date().toISOString(),stage:failed?'stopped-on-unresolved-proposal':!validation.qualified?'qualification-incomplete':comparison?.completePairs===8?'complete':'comparison-incomplete',
  packageHash:proposal?.packageHash??null,hostEditedCode:false,repair:rows,
  improvements:improvements.map(p=>p.parent.caseId),regressions:regressions.map(p=>p.parent.caseId),
  directExecutions:baseline.records.length+validation.records.length,
  directWallMs:[...baseline.records,...validation.records].reduce((n,r)=>n+r.wallMs+r.checkerWallMs,0),
  providerUsdForDirectChecks:0,repairGeneration:proposal?.cost??null,comparison,
  proposalExecution:diagnostic,
  qualification:validation.qualified?'Study-only checked package. No production activation, canary graduation or peer transfer performed.':'No new qualified package. No qualification or performance conclusion is inferred from a completed proposal alone.',
  interpretation:comparison?'Paired ordinary-agent efficiency pilot after host-checked executable repair. See finite-panel results and accounting; collective-learning efficacy is still unproven.':'Baseline established; repair was interrupted with unresolved cost. No new improvement or efficiency conclusion.',
  budget:comparison?.budget??proposal?.budget??failed.budget,
};
await write(path.join(out,'readout.json'),result);
if(process.platform==='linux') {
  if(failed && diagnostic?.candidate) {
    for(const f of diagnostic.candidate.manifest.files) {
      const source=path.join(root,'quarantine',diagnostic.runId,'content',f.path);
      const bytes=await fs.readFile(source);assert.equal(hash(bytes),f.hash);
      const target=path.join(out,'unvalidated-package',f.path);await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,bytes,{flag:'wx'});
    }
  }
  const comparisonFreeze=await read(path.join(out,'comparison-frozen.json')).catch(()=>null);
  for(const [relative,expected] of Object.entries(comparisonFreeze?.sources??{})) {
    const bytes=await fs.readFile(path.join(repo,relative));assert.equal(hash(bytes),expected);
    const target=path.join(out,'analysis-source',relative);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});
  }
  for(const name of ['executable-use-v3-export.mjs','executable-use-v3-replay.py','executable-use-v3-audit.mjs','executable-use-v3-verify.mjs','executable-use-v3-failure-audit.py','executable-use-v3-interpret.mjs']) {
    const target=path.join(out,'analysis-source',name);await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(path.join(repo,'research/collective-learning',name),target,fs.constants.COPYFILE_EXCL);
  }
  for(const name of ['execution-source.tar.gz','source-files.txt'])
    await fs.copyFile(path.join(root,name),path.join(out,name),fs.constants.COPYFILE_EXCL);
  for(const name of await fs.readdir(path.join(root,'runs'),{recursive:true})) {
    const source=path.join(root,'runs',name),stat=await fs.lstat(source);
    if(stat.isDirectory())continue;
    assert(stat.isFile()&&!stat.isSymbolicLink());
    const target=path.join(out,'direct-runs',name);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);
  }
  const fixtures=path.join(repo,'research/collective-learning/executable-use-v3/fixtures');
  for(const name of await fs.readdir(fixtures,{recursive:true})) {
    const source=path.join(fixtures,name),stat=await fs.lstat(source);if(stat.isDirectory())continue;
    assert(stat.isFile()&&!stat.isSymbolicLink());const target=path.join(out,'fixtures',name);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);
  }
}
const prior=[];
for(const study of ['executable-learning-20261113-v1','executable-repair-20261113-v1','executable-use-20261113-v1','executable-use-20261114-v2']) {
  const directory=path.join(repo,'reports/collective-learning',study),manifest=await read(path.join(directory,'export-manifest.json'));
  for(const file of manifest.files) {
    const bytes=await fs.readFile(path.join(directory,file.path));assert.equal(hash(bytes),file.sha256,study+':'+file.path);
  }
  prior.push({study,verifiedFiles:manifest.files.length,unchanged:true});
}
await write(path.join(out,'prior-results-preserved.json'),{prior});
const files=[];
for(const name of await fs.readdir(out,{recursive:true})) {
  const file=path.join(out,name),stat=await fs.lstat(file);if(stat.isDirectory())continue;
  assert(stat.isFile()&&!stat.isSymbolicLink());const bytes=await fs.readFile(file);
  files.push({path:name.replaceAll(path.sep,'/'),bytes:bytes.length,sha256:hash(bytes)});
}
await write(path.join(out,'export-manifest.json'),{schemaVersion:1,files});
console.log(JSON.stringify({repair:rows,improvements:improvements.length,regressions:regressions.length,
  comparison:comparison?.arms,budget:result.budget,exportedFiles:files.length,prior},null,2));
