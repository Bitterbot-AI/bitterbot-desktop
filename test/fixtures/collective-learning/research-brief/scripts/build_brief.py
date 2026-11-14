"""Usage: python3 scripts/build_brief.py input.json brief.json brief.md"""
import json
from pathlib import Path
import sys
from normalize_sources import normalize
from citations import assemble

task = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
brief = assemble(task, normalize(task["sources"]))
Path(sys.argv[2]).write_text(json.dumps(brief, ensure_ascii=False), encoding="utf-8")
template = (Path(__file__).resolve().parent.parent / "templates" / "brief.md").read_text(encoding="utf-8")
text = template.format(question=brief["question"], findings="\n".join("- {metric}: {value} [{sourceId}, {date}]".format(**f) for f in brief["findings"]), uncertainties="\n".join("- " + u for u in brief["uncertainties"]), recommendation=brief["recommendation"], **brief["followUp"])
Path(sys.argv[3]).write_text(text, encoding="utf-8")
