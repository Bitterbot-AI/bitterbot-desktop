"""Post-hoc explanation of the actual 2705 output, independently of checker imports."""
import difflib, hashlib, json, pathlib, re, zipfile
import xml.etree.ElementTree as ET
repo=pathlib.Path(__file__).resolve().parents[2]
out=repo/'reports/collective-learning/executable-use-20261114-v3'
fixture=repo/'research/collective-learning/executable-use-v3/fixtures/agent/agent-2705'
data=json.loads((fixture/'employee_data.json').read_text(encoding='utf8'))
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def paragraphs(file):
    with zipfile.ZipFile(file) as archive:
        root=ET.fromstring(archive.read('word/document.xml'))
    return [''.join(n.text or '' for n in p.iter(W+'t')) for p in root.iter(W+'p')]
def normalized(items):
    return [' '.join(x.split()) for x in items if x.strip()]
expected=[]
for p in paragraphs(fixture/'offer_letter_template.docx'):
    p=re.sub(r'\{\{IF_RELOCATION\}\}(.*?)\{\{END_IF_RELOCATION\}\}',
             lambda m:m[1] if data['RELOCATION_PACKAGE']=='Yes' else '',p,flags=re.S)
    expected.append(re.sub(r'\{\{([A-Z_]+)\}\}',lambda m:data[m[1]],p))
expected=normalized(expected)
arms=[]
for arm in ['frozen','learned']:
    identity='agent-agent-2705-'+arm
    record=json.loads((out/'agent-records'/(identity+'.json')).read_text(encoding='utf8'))
    file=out/'agent-outputs'/(identity+'.docx')
    assert hashlib.sha256(file.read_bytes()).hexdigest()==record['outputHash']
    observed=normalized(paragraphs(file))
    arms.append(dict(arm=arm,bodyMatchesContract=observed==expected,
                     bodyDiff=list(difflib.unified_diff(expected,observed,fromfile='public-contract',tofile=arm,lineterm=''))))
result=dict(caseId='agent-2705',governor=data['RELOCATION_PACKAGE'],
            exactYesComparison=data['RELOCATION_PACKAGE']=='Yes',unusedBareField=data['RELOCATION'],
            arms=arms,interpretation='Post-hoc mechanism inspection of existing artifacts, not a new trial or a full document verifier.')
with (out/'failure-mechanism-2705.json').open('x',encoding='utf8') as f:
    json.dump(result,f,indent=2,ensure_ascii=False);f.write('\n')
print(json.dumps(result,ensure_ascii=False))
assert not arms[0]['bodyMatchesContract'] and arms[1]['bodyMatchesContract']
