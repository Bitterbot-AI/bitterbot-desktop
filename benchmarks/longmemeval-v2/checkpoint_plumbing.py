"""Exercise durable ingestion resume with a complete official trajectory, no score."""
import json
import argparse
import sqlite3
from pathlib import Path
from core import *
from run import build_history, restore
def main():
    cfg=json.loads((HERE/"plumbing.json").read_text())
    source=HERE/".runtime/plumbing-trajectory.json"
    t=safe_trajectory(json.loads(source.read_text()))
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",type=Path,default=HERE/".runtime/checkpoint-plumbing")
    root=parser.parse_args().output.resolve()
    root.mkdir(exist_ok=True,parents=True)
    broker=Broker(HERE/".runtime/plumbing-budget",cfg,credentials(REPO/".env"))
    db=sqlite3.connect(":memory:")
    db.execute("CREATE TABLE trajectories (id TEXT PRIMARY KEY,payload TEXT)")
    db.execute("INSERT INTO trajectories VALUES (?,?)",(t["id"],json.dumps(t)))
    manifest={"pins":PINS,"code":code_manifest(),"trajectory_sha256":sha(source),"config":cfg}
    atomic(root/"manifest.json",manifest)
    broker.case="plumbing-"+root.name
    started=time.time()
    before=broker.charged
    checkpoint=build_history(root/"histories",[t["id"]],db,cfg,broker,False)
    charges=broker.charged
    resumed=build_history(root/"histories",[t["id"]],db,cfg,broker,False)
    if resumed!=checkpoint or broker.charged!=charges:raise RuntimeError("Resume repeated completed work")
    profile=root/"query-attempt"
    restore(checkpoint,profile)
    broker.stage="retrieval"
    worker=Worker(profile,cfg,broker,ingestion_time(1))
    try:
        evidence=worker.call("query",query=t["goal"],now=ingestion_time(1))
        if not evidence:raise RuntimeError("No retrieved evidence")
        worker.close(ingestion_time(1))
    except BaseException:
        worker.abort();raise
    saved=json.loads((checkpoint/"checkpoint.json").read_text())
    atomic(root/"result.json",{"status":"passed","checkpoint_resume_verified":True,"started_at":started,"finished_at":time.time(),"accounting_case":broker.case,
        "trajectory_id":t["id"],"trajectory_bytes":source.stat().st_size,
        "dream_cycle":saved["dream"]["result"]["cycle"],"chunks":saved["dream"]["chunks"],
        "retrieval_items":len(evidence),"api_cost_this_test":broker.charged-before,
        "cumulative_authorized_plumbing_cost":broker.charged,"official_score":None})
    print(json.dumps(json.loads((root/"result.json").read_text()),indent=2))
if __name__=="__main__":main()
