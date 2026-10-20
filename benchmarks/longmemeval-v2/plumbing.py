"""A real-data smoke run. Never emits a benchmark score."""
import argparse
import json
from pathlib import Path
from core import *
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--trajectory",type=Path,required=True)
    p.add_argument("--config",type=Path,default=HERE/"plumbing.json")
    p.add_argument("--output",type=Path,required=True)
    p.add_argument("--env-file",type=Path,default=REPO/".env")
    args=p.parse_args()
    cfg=json.loads(args.config.read_text())
    trajectory=safe_trajectory(json.loads(args.trajectory.read_text()))
    args.output.mkdir(parents=True,exist_ok=True)
    if (args.output/"attempt").exists():
        raise RuntimeError("Use a new output directory; failed attempt remains inspectable")
    atomic(args.output/"manifest.json",{"pins":PINS,"config":cfg,"code":code_manifest(),
          "trajectory_sha256":sha(args.trajectory),"scope":"one real trajectory; no official score"})
    broker=Broker(HERE/".runtime/plumbing-budget",cfg,credentials(args.env_file))
    worker=Worker(args.output/"attempt",cfg,broker,EPOCH_MS)
    try:
        broker.stage="ingestion"
        ingest=worker.call("ingest",trajectory=trajectory,now=EPOCH_MS)
        broker.stage="consolidation"
        consolidate=worker.call("consolidate",now=EPOCH_MS+30*60*1000)
        broker.stage="dreaming"
        dream=worker.call("dream",now=EPOCH_MS+90*60*1000)
        broker.stage="retrieval"
        query=worker.call("query",query=trajectory["goal"],now=EPOCH_MS+2*60*60*1000)
        if not query:raise RuntimeError("Real-data retrieval returned no evidence")
        worker.close(EPOCH_MS+2*60*60*1000)
        atomic(args.output/"result.json",{"status":"passed","ingestion":ingest,
              "consolidation":consolidate,"dream":dream,"retrieval_items":len(query),
              "api_cost_usd":sum(x.get("cost_usd",x["reserved_usd"]) for x in broker.entries),
              "official_score":None})
    except BaseException as exc:
        worker.abort()
        atomic(args.output/"result.json",{"status":"failed","error":str(exc),"official_score":None})
        raise
if __name__=="__main__":main()
