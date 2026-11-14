"""Independent template-based check; values must occur at their intended positions."""
import json
import posixpath
import re
import xml.etree.ElementTree as ET
from check_common import InvalidArtifact, bounded_zip, normalize, verdict, xml

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def enabled(element):
    if element is None:
        return False
    value=element.get(W+'val','true').lower()
    if value not in ['true','false','1','0','on','off']:
        raise InvalidArtifact('invalid-document-boolean')
    return value in ['true','1','on']


def document(file):
    with bounded_zip(file) as archive:
        names=set(archive.namelist())
        if "word/document.xml" not in names:
            raise InvalidArtifact("missing-document-part")
        main=xml(archive.read('word/document.xml'))
        body=main.find(W+'body')
        if body is None:
            raise InvalidArtifact('missing-document-body')
        relationships={}
        if 'word/_rels/document.xml.rels' in names:
            for relation in xml(archive.read('word/_rels/document.xml.rels')):
                identity=relation.get('Id')
                if identity in relationships:
                    raise InvalidArtifact('duplicate-document-relationship')
                relationships[identity]=relation
        settings=xml(archive.read('word/settings.xml')) if 'word/settings.xml' in names else ET.Element(W+'settings')
        even=enabled(settings.find(W+'evenAndOddHeaders'))
        sections=body.findall(W+'p/'+W+'pPr/'+W+'sectPr')+body.findall(W+'sectPr')
        if not sections:
            sections=[ET.Element(W+'sectPr')]
        inherited={}
        effective=[]
        for section in sections:
            seen=set()
            for kind in ['header','footer']:
                for reference in section.findall(W+kind+'Reference'):
                    role=reference.get(W+'type')
                    key=(kind,role)
                    relation=relationships.get(reference.get(R+'id'))
                    if role not in ['default','first','even'] or key in seen or relation is None:
                        raise InvalidArtifact('invalid-document-header-reference')
                    seen.add(key)
                    if not relation.get('Type','').endswith('/'+kind) or relation.get('TargetMode','Internal')!='Internal':
                        raise InvalidArtifact('invalid-document-header-relationship')
                    target=relation.get('Target','')
                    if not target or target.startswith('/') or '\\' in target or ':' in target:
                        raise InvalidArtifact('invalid-document-header-target')
                    target=posixpath.normpath(posixpath.join('word',target))
                    if target.startswith('../') or target not in names:
                        raise InvalidArtifact('missing-template-part')
                    part=xml(archive.read(target))
                    if part.tag!=W+('hdr' if kind=='header' else 'ftr'):
                        raise InvalidArtifact('invalid-document-header-part')
                    inherited[key]=part
            active={}
            for kind in ['header','footer']:
                for page in ['default','first','even']:
                    role=page if (page=='first' and enabled(section.find(W+'titlePg'))) or (page=='even' and even) else 'default'
                    active[kind+':'+page]=inherited.get((kind,role),ET.Element(W+'empty'))
            effective.append(active)
        return main,effective


def paragraphs(root):
    return ["".join(t.text or "" for t in p.iter(W + "t")) for p in root.iter(W + "p")]


def expanded_paragraphs(root, data):
    result = []
    # Contract v2: only templates containing the conditional require its governor.
    keep = data.get("RELOCATION_PACKAGE") == "Yes"
    for text in paragraphs(root):
        if '{{IF_RELOCATION}}' in text and 'RELOCATION_PACKAGE' not in data:
            raise ValueError('Host supplied a conditional without its required governor')
        text = re.sub(r"\{\{IF_RELOCATION\}\}(.*?)\{\{END_IF_RELOCATION\}\}", lambda m: m[1] if keep else "", text, flags=re.S)
        text = re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: str(data[m[1]]), text)
        if normalize(text):
            result.append(normalize(text))
    return result


def check_offer(source, output):
    data = json.loads((source / "employee_data.json").read_text())
    original, original_sections = document(source / "offer_letter_template.docx")
    actual, actual_sections = document(output)
    issues = []
    comparisons=[('document',original,actual)]
    if len(original_sections)!=len(actual_sections):
        issues.append('section-structure-changed')
    for index,(expected,observed) in enumerate(zip(original_sections,actual_sections)):
        comparisons.extend((f'section-{index}:{role}',root,observed[role]) for role,root in expected.items())
    for name, root, observed_root in comparisons:
        expected = expanded_paragraphs(root, data)
        observed = [normalize(p) for p in paragraphs(observed_root) if normalize(p)]
        if expected != observed:
            issues.append("template-text-or-placement-mismatch:" + name)
        if any("{{" in p or "}}" in p for p in observed):
            issues.append("unresolved-placeholder:" + name)
        if len(list(root.iter(W + "tbl"))) != len(list(observed_root.iter(W + "tbl"))):
            issues.append("table-structure-changed:" + name)
    return verdict(issues, {"effectiveSections":len(original_sections),"relocationIncluded": data.get("RELOCATION_PACKAGE") == "Yes"})
