"""Host-owned DOCX outcome check. Never mounted into the builder workspace."""
import json
import pathlib
import sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'oracle'))
from check_offer import check_offer,document,expanded_paragraphs,W
from check_common import InvalidArtifact,bounded_zip,xml,verdict,normalize

def placement(root,data=None):
    """Keep table/row/cell boundaries, while allowing harmless run fragmentation."""
    result=[]
    for child in root:
        if child.tag==W+'body':result.extend(placement(child,data))
        elif child.tag==W+'p':
            texts=expanded_paragraphs(child,data) if data is not None else [normalize(''.join(t.text or '' for t in child.iter(W+'t')))]
            result.extend(('paragraph',text) for text in texts if text)
        elif child.tag==W+'tbl':
            result.append(('table',[[placement(cell,data) for cell in row.findall(W+'tc')] for row in child.findall(W+'tr')]))
    return result

def external_relationships(file):
    values=[]
    with bounded_zip(file) as archive:
        for name in archive.namelist():
            if name.endswith('.rels'):
                values.extend((node.get('Type'),node.get('Target'))
                              for node in xml(archive.read(name))
                              if node.get('TargetMode')=='External')
    return sorted(values)

def check(source,output):
    source,output=pathlib.Path(source),pathlib.Path(output)
    try:
        data=json.loads((source/'employee_data.json').read_text(encoding='utf8'))
        if not isinstance(data,dict) or not all(isinstance(k,str) and isinstance(v,str) for k,v in data.items()):
            return {'status':'checker-invalid','issues':['unsupported-host-input'],'details':{}}
        if not output.is_file():return verdict(['missing-output'])
        with bounded_zip(output) as archive:
            if any(any(marker in name.lower() for marker in ['vbaproject','activex','embeddings/']) for name in archive.namelist()):
                return verdict(['unsupported-active-content'])
        if external_relationships(output)!=external_relationships(source/'offer_letter_template.docx'):
            return verdict(['external-relationships-changed'])
        result=check_offer(source,output)
        expected,expected_sections=document(source/'offer_letter_template.docx')
        observed,observed_sections=document(output)
        pairs=[('document',expected,observed)]
        for i,(left,right) in enumerate(zip(expected_sections,observed_sections)):
            pairs.extend((f'section-{i}:{role}',part,right[role]) for role,part in left.items())
        for label,left,right in pairs:
            if placement(left,data)!=placement(right):result['issues'].append('table-cell-placement-mismatch:'+label)
        if result['issues']:result['status']='task-failure'
        return result
    except InvalidArtifact as error:
        return verdict([str(error)])
    except Exception as error:
        return {'status':'checker-invalid','issues':[type(error).__name__],'details':{}}

if __name__=='__main__':
    if not sys.flags.utf8_mode:raise SystemExit('Explicit -X utf8 required')
    print(json.dumps(check(sys.argv[1],sys.argv[2])))

