// Offline, Node built-ins only. Authenticates the saved release; does not grant trust or install it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
const read=async name=>JSON.parse(await fs.readFile(new URL('recipient/'+name,import.meta.url),'utf8'));
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const bundle=await read('transfer-bundle.json'), source=await read('source-export.json'), recipient=await read('recipient-import.json');
assert.equal(hash(canonical(bundle)),source.bundleHash);
assert.equal(hash(canonical(bundle.release)),source.releaseId);
assert.equal(hash(canonical(bundle.manifest)),recipient.packageHash);
assert.equal(bundle.release.packageHash,recipient.packageHash);
assert.equal(bundle.release.publisher,source.publisher);
const {signature,...unsigned}=bundle.release;
const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(unsigned.publisher.slice(8),'hex')]),format:'der',type:'spki'});
assert(crypto.verify(null,Buffer.from(unsigned.protocol+'\n'+canonical(unsigned)),key,Buffer.from(signature,'hex')));
const files=new Map(bundle.files.map(([name,bytes])=>[name,Buffer.from(bytes,'base64')]));
assert.equal(files.size,bundle.manifest.files.length);
for(const file of bundle.manifest.files){assert.equal(hash(files.get(file.path)),file.hash);assert.equal(files.get(file.path).length,file.size);}
assert.notEqual(recipient.recipient,source.publisher);
assert.equal(recipient.localReceiptsImported,0);
console.log(JSON.stringify({signatureVerified:true,completePackageVerified:true,packageHash:recipient.packageHash,qualificationImported:false,scope:'historical offline handoff; no installation or publication performed'}));
