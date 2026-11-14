"""Replay saved DOCX artifacts independently of the model runner, on either host OS."""
import hashlib,json,pathlib,platform,sys
repo=pathlib.Path(__file__).resolve().parents[2]
suite=repo/'research/collective-learning/executable-use-v3'
sys.path.insert(0,str(suite))
from checker import check
report=repo/'reports/collective-learning/executable-use-20261114-v3'
inventory=json.loads((suite/'fixtures/inventory.json').read_text(encoding='utf8'))
cases={f['id']:suite/'fixtures'/f['partition']/f['id'] for f in inventory}
original=repo/'research/collective-learning/executable-learning/fixtures/evaluation'
cases.update({'regression-'+folder.name:folder for folder in original.iterdir() if folder.is_dir()})
records=[]
for kind in ['baseline','validate']:
    if not (report/(kind+'.json')).exists():continue
    for r in json.loads((report/(kind+'.json')).read_text(encoding='utf8'))['records']:
        if 'invalid' in r['partition']:continue
        output=report/'direct-runs'/r['arm']/r['caseId']/'output/offer_letter_filled.docx'
        actual=check(cases[r['caseId']],output)
        digest=hashlib.sha256(output.read_bytes()).hexdigest() if output.exists() else None
        records.append(dict(id=r['arm']+':'+r['caseId'],agrees=actual['status']==r['grade']['status'],
                            hashMatches=digest==r['outputHash'],actual=actual))
for file in sorted((report/'agent-records').glob('*.json')):
    r=json.loads(file.read_text(encoding='utf8'))
    output=report/'agent-outputs'/(r['id']+'.docx')
    actual=check(cases[r['caseId']],output)
    digest=hashlib.sha256(output.read_bytes()).hexdigest() if output.exists() else None
    records.append(dict(id=r['id'],agrees=actual['status']==r['outcome'],hashMatches=digest==r['outputHash'],actual=actual))
result=dict(platform=platform.system(),artifacts=len(records),allAgreed=all(r['agrees'] and r['hashMatches'] for r in records),records=records)
(report/('artifact-replay-'+platform.system().lower()+'.json')).write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
print(json.dumps({k:v for k,v in result.items() if k!='records'}))
assert result['allAgreed']
