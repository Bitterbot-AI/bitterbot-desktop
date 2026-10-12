"""Render a reproducible JSON/Markdown accounting report; never invent a score."""
import argparse
import json
from pathlib import Path
import sqlite3
from core import atomic
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--run",type=Path,required=True)
    a=p.parse_args();root=a.run.resolve()
    db=sqlite3.connect("file:"+str(root/"accounting.sqlite")+"?mode=ro",uri=True)
    phases={}
    for (raw,) in db.execute("SELECT payload FROM requests"):
        row=json.loads(raw);key=row["stage"]+"/"+row["kind"]
        phase=phases.setdefault(key,{"requests":0,"errors":0,"prompt_tokens":0,"completion_tokens":0,"seconds":0,"usd":0})
        phase["requests"]+=1;phase["errors"]+=row["status"]!="success"
        phase["prompt_tokens"]+=row.get("usage",{}).get("prompt_tokens",0)
        phase["completion_tokens"]+=row.get("usage",{}).get("completion_tokens",0)
        phase["seconds"]+=row.get("seconds",0)
        phase["usd"]+=row.get("cost_usd",row["reserved_usd"])
    result={"phases":phases,"cost_usd":sum(x["usd"] for x in phases.values()),
            "official_score":None,"complete":(root/"completion.json").exists()}
    if result["complete"]:
        result["official_metrics"]=json.loads((root/"combined_metrics.json").read_text())
        result["official_score"]=result["official_metrics"]
        overview=root/"submission/bitterbot/submission_overview.json"
        result["official_submission"]=json.loads(overview.read_text())
    atomic(root/"report.json",result)
    lines=["# Run report","",f"Complete official run: {result['complete']}",
           f"API cost including unresolved reservations: US$ {result['cost_usd']:.6f}","",
           "| Phase/model role | Calls | Errors/unresolved | Input tokens | Output tokens | Seconds | USD |",
           "|---|---:|---:|---:|---:|---:|---:|"]
    for key,value in sorted(phases.items()):
        lines.append(f"| {key} | {value['requests']} | {value['errors']} | {value['prompt_tokens']} | {value['completion_tokens']} | {value['seconds']:.3f} | {value['usd']:.6f} |")
    if not result["complete"]:lines+=["","No official score: evaluation has not completed."]
    else:lines+=["","Official combined metrics:","",json.dumps(result["official_metrics"],indent=2)]
    (root/"report.md").write_text("\n".join(lines)+"\n")
    db.close()
if __name__=="__main__":main()
