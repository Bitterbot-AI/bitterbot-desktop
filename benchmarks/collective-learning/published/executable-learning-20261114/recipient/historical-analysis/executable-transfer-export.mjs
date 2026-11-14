import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const version=process.argv[2]??'v2';assert(['v1','v2'].includes(version));
const repo=fileURLToPath(new URL('../..',import.meta.url));
const study='executable-transfer-20261114-'+version;
const root='/home/vicmg/.local/share/bitterbot-studies/'+study;
const out=path.join(repo,'reports/collective-learning',study);
const read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=async(name,v)=>fs.writeFile(path.join(out,name),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const validation=await read('validate.json');
const comparison=await read('comparison-readout.json').catch(()=>null);
const imported=await read('recipient-import.json');
const frozen=await read('frozen.json');
const candidate=await read('candidate-package.json');
const rows=['control','candidate'].map(arm=>{
  const rs=validation.records.filter(r=>r.arm===arm);
  return {arm,passed:rs.filter(r=>r.grade.status==='pass').length,total:rs.length,
    failures:rs.filter(r=>r.grade.status!=='pass').map(r=>({caseId:r.caseId,issues:r.grade.issues}))};
});
const result={schemaVersion:1,createdAt:new Date().toISOString(),stage:!validation.qualified?'qualification-rejected':comparison?.completePairs===12?'evaluation-complete':comparison?.attemptedPairs===12?'evaluation-complete-with-interruption':'comparison-incomplete',
  packageHash:imported.packageHash,hostEditedPackage:false,import:imported,qualification:rows,
  directExecutions:validation.records.length,directWallMs:validation.records.reduce((n,r)=>n+r.wallMs+r.checkerWallMs,0),
  comparison,budget:comparison?.budget??validation.budget,
  retention:{status:version==='v1'?'superseded-preflight':'not-yet-measured',notBefore:new Date(frozen.retentionNotBefore).toISOString(),
    cases:6,automaticJobScheduled:false},
  scope:'Operator-assisted signed offline import into an isolated recipient process/store. Same physical host and pinned dependency image, changed CPU/memory/timezone. No production activation, automatic Circle distribution, public mesh or pooled-evidence benefit claim.'};
await write('readout.json',result);
const copy=async(source,target)=>{await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);};
for(const name of ['execution-source.tar.gz','source-files.txt','transfer-bundle.json']){
  if(name==='execution-source.tar.gz')assert.equal(hash(await fs.readFile(path.join(root,name))),frozen.archiveHash);
  await copy(path.join(root,name),path.join(out,name));
}
for(const f of candidate.manifest.files){
  const source=path.join(root,'recipient-packages/packages',candidate.packageHash,'content',f.path);
  assert.equal(hash(await fs.readFile(source)),f.hash);await copy(source,path.join(out,'package',f.path));
}
for(const [sourceDir,targetDir] of [[path.join(root,'runs'),'direct-runs'],[path.join(repo,'research/collective-learning/executable-transfer-'+version+'/fixtures'),'fixtures']])
  for(const name of await fs.readdir(sourceDir,{recursive:true})){
    const source=path.join(sourceDir,name),stat=await fs.lstat(source);if(stat.isDirectory())continue;
    assert(stat.isFile()&&!stat.isSymbolicLink());await copy(source,path.join(out,targetDir,name));
  }
for(const name of ['executable-transfer-export.mjs','executable-transfer-audit.mjs','executable-transfer-verify.mjs','executable-transfer-replay.py','executable-transfer-report.mjs',
  'executable-transfer-interruption-audit.mjs','executable-transfer-reconcile.mjs','build-transfer-continuation.mjs',
  'executable-transfer-helper-use-audit.mjs','executable-transfer-run-instructions.json','executable-transfer-xml-audit.py',
  'executable-transfer-provenance-audit.mjs'])
  await copy(path.join(repo,'research/collective-learning',name),path.join(out,'analysis-source',name));
if(version==='v2')await copy(path.join(repo,'research/collective-learning/executable-transfer-continuation/run.ts'),path.join(out,'analysis-source/continuation-run.ts'));
const previous=['executable-learning-20261113-v1','executable-repair-20261113-v1','executable-use-20261113-v1','executable-use-20261114-v2','executable-use-20261114-v3'];
if(version==='v2')previous.push('executable-transfer-20261114-v1');
const preserved=[];
for(const name of previous){
  const directory=path.join(repo,'reports/collective-learning',name),manifest=JSON.parse(await fs.readFile(path.join(directory,'export-manifest.json'),'utf8'));
  for(const f of manifest.files)assert.equal(hash(await fs.readFile(path.join(directory,f.path))),f.sha256,name+':'+f.path);
  preserved.push({study:name,files:manifest.files.length,unchanged:true});
}
await write('prior-results-preserved.json',{preserved});
const files=[];
for(const name of await fs.readdir(out,{recursive:true})){
  const file=path.join(out,name),stat=await fs.lstat(file);if(stat.isDirectory())continue;assert(stat.isFile()&&!stat.isSymbolicLink());
  const bytes=await fs.readFile(file);files.push({path:name.replaceAll(path.sep,'/'),bytes:bytes.length,sha256:hash(bytes)});
}
await write('export-manifest.json',{schemaVersion:1,files});
console.log(JSON.stringify({stage:result.stage,qualification:rows,budget:result.budget,exportedFiles:files.length,preserved}));
