"""Independent libxml2 parse of task-failure artifacts and their matched helper outputs."""
import hashlib,json,pathlib,platform,sys,zipfile
from lxml import etree
repo=pathlib.Path(__file__).resolve().parents[2]
report=repo/'reports/collective-learning/executable-transfer-20261114-v2'
all_records=[json.loads(p.read_text(encoding='utf8')) for p in (report/'agent-records').glob('*.json')]
failed_cases={r['caseId'] for r in all_records if r['outcome']=='task-failure' and 'malformed-xml' in r['grade']['issues']}
records=[]
for r in all_records:
    if r['caseId'] not in failed_cases:continue
    file=report/'agent-outputs'/(r['id']+'.docx')
    assert hashlib.sha256(file.read_bytes()).hexdigest()==r['outputHash']
    errors=[]
    parsed=0
    with zipfile.ZipFile(file) as archive:
        entries=archive.infolist()
        assert len(entries)<=512 and sum(e.file_size for e in entries)<=24*1024*1024
        for e in entries:
            if not e.filename.endswith('.xml'):continue
            data=archive.read(e.filename)
            assert b'<!DOCTYPE' not in data.upper() and b'<!ENTITY' not in data.upper()
            try:
                etree.fromstring(data,etree.XMLParser(resolve_entities=False,no_network=True))
                parsed+=1
            except etree.XMLSyntaxError as error:
                errors.append(dict(part=e.filename,position=list(error.position),message=str(error)))
    records.append(dict(id=r['id'],originalOutcome=r['outcome'],parsedXmlParts=parsed,errors=errors))
result=dict(platform=platform.system(),parser='libxml2 via lxml (host checker uses Python ElementTree)',
            records=records,xmlFailuresConfirmed=all(bool(r['errors'])==(r['originalOutcome']=='task-failure') for r in records))
print(json.dumps(result))
if '--final' in sys.argv:
    assert result['xmlFailuresConfirmed']
    with (report/('independent-xml-audit-'+platform.system().lower()+'.json')).open('x',encoding='utf8') as file:
        file.write(json.dumps(result,indent=2)+'\n')
