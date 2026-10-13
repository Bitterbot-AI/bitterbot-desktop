"""Fetch immutable official artifacts; stream the large trajectory file into SQLite."""
import argparse
import json
from pathlib import Path
import sqlite3
import subprocess
import urllib.request
from core import *

def download(root, name, revision):
    target = root/name
    target.parent.mkdir(parents=True,exist_ok=True)
    if not target.exists():
        temp=target.with_suffix(target.suffix+".part")
        urllib.request.urlretrieve(
            "https://huggingface.co/datasets/"+PINS["dataset"]["repo"]+"/resolve/"+revision+"/"+name,temp)
        temp.replace(target)
    return target

def prepare(root, screenshots=False):
    root.mkdir(parents=True,exist_ok=True)
    revision=PINS["dataset"]["revision"]
    for name in ["checksums.sha256","SCHEMA.md","README.md","questions.jsonl","haystacks/lme_v2_medium.json","trajectories.jsonl"]:
        print("Preparing",name,flush=True)
        download(root,name,revision)
    expected={}
    for line in (root/"checksums.sha256").read_text().splitlines():
        value,name=line.split(maxsplit=1)
        expected[name.lstrip("*")]=value
    for name in ["questions.jsonl","trajectories.jsonl","haystacks/lme_v2_medium.json"]:
        if sha(root/name)!=expected[name]:
            raise RuntimeError("Official checksum mismatch: "+name)
    db=sqlite3.connect(root/"trajectories.sqlite")
    db.execute("CREATE TABLE IF NOT EXISTS trajectories (id TEXT PRIMARY KEY, domain TEXT, bytes INTEGER, states INTEGER, payload TEXT)")
    if not (root/"prepared.json").exists():
        db.execute("DELETE FROM trajectories")
        with (root/"trajectories.jsonl").open() as source:
            for line in source:
                t=safe_trajectory(json.loads(line))
                db.execute("INSERT INTO trajectories VALUES (?,?,?,?,?)",
                    (t["id"],t["domain"],len(line.encode()),len(t["states"]),line))
        db.commit()
    questions=[json.loads(x) for x in (root/"questions.jsonl").read_text().splitlines()]
    haystacks=json.loads((root/"haystacks/lme_v2_medium.json").read_text())
    summary={}
    for domain in ["web","enterprise"]:
        qs=[q for q in questions if q["domain"]==domain]
        histories={tuple(haystacks[q["id"]]) for q in qs}
        trajectory_counts={row[0]:(row[1],row[2]) for row in db.execute("SELECT id,bytes,states FROM trajectories WHERE domain=?",(domain,))}
        for history in histories:
            if len(set(history))!=len(history) or any(t not in trajectory_counts for t in history):
                raise RuntimeError("Invalid haystack")
        summary[domain]={"questions":len(qs),"distinct_ordered_histories":len(histories),
                         "trajectory_ingestions":sum(map(len,histories)),
                         "history_bytes":sum(trajectory_counts[t][0] for h in histories for t in h),
                         "history_states":sum(trajectory_counts[t][1] for h in histories for t in h)}
    db.close()
    if screenshots:
        for name in expected:
            if name.startswith(("question_screenshots/","trajectory_screenshots/")):
                download(root,name,revision)
                if sha(root/name)!=expected[name]:
                    raise RuntimeError("Screenshot checksum mismatch: "+name)
    atomic(root/"prepared.json",{"revision":revision,"sha256":{name:sha(root/name) for name in
         ["questions.jsonl","trajectories.jsonl","haystacks/lme_v2_medium.json"]},"index_sha256":sha(root/"trajectories.sqlite"),"inventory":summary,
         "screenshot_archives_verified":screenshots})
    return summary

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--data-root",type=Path,required=True)
    p.add_argument("--screenshots",action="store_true")
    a=p.parse_args()
    print(json.dumps(prepare(a.data_root.resolve(),a.screenshots),indent=2))
