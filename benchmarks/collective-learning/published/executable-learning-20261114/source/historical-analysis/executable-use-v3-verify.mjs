import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repo=fileURLToPath(new URL('../..',import.meta.url));
const out=path.join(repo,'reports/collective-learning/executable-use-20261114-v3');
const read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const manifest=await read('export-manifest.json');
for(const file of manifest.files) {
  const absolute=path.resolve(out,file.path);
  const relative=path.relative(out,absolute);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const bytes=await fs.readFile(absolute);
  assert.equal(bytes.length,file.bytes,file.path);
  assert.equal(hash(bytes),file.sha256,file.path);
}
const candidate=await read('candidate-package.json');
for(const file of candidate.manifest.files) {
  const bytes=await fs.readFile(path.join(out,'package',file.path));
  assert.equal(bytes.length,file.size,file.path);
  assert.equal(hash(bytes),file.hash,file.path);
}
const report={platform:process.platform,exportedFilesVerified:manifest.files.length,
  packageFilesVerified:candidate.manifest.files.length,packageHash:candidate.packageHash,
  allMatched:true,verifiedAt:new Date().toISOString()};
await fs.writeFile(path.join(out,'export-verification-'+process.platform+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
