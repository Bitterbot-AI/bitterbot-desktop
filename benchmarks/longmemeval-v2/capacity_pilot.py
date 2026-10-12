"""Bounded real-history capacity pilot. No reader, judge, gold labels or official score."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
import fcntl
from core import HERE, REPO, PINS, Broker, Worker, atomic, event, sha, digest, credentials, code_manifest, ingestion_time
from run import build_history, restore

GIB=1024**3

def select_histories(data, db):
    # Selection uses domain, IDs and byte counts only; never opens questions.jsonl.
    info={r[0]:(r[1],r[2]) for r in db.execute("SELECT id,domain,bytes FROM trajectories")}
    unique={tuple(h) for h in json.loads((data/"haystacks/lme_v2_medium.json").read_text()).values()}
    result={}
    for domain in ("web","enterprise"):
        rows=sorted((sum(info[t][1] for t in h),digest(h),h) for h in unique if info[h[0]][0]==domain)
        size,key,history=rows[len(rows)//2]
        if any(info[t][0]!=domain for t in history):raise RuntimeError("Mixed-domain history")
        result[domain]={"history":list(history),"history_sha256":key,"bytes":size,"selection":"upper median total raw bytes among distinct ordered histories"}
    return result

def sample_resources():
    processes={}
    for path in Path("/proc").glob("[0-9]*/status"):
        try:
            fields=dict(line.split(":",1) for line in path.read_text().splitlines() if ":" in line)
            processes[int(path.parent.name)]=(int(fields["PPid"]),int(fields.get("VmRSS","0 kB").split()[0])*1024)
        except (OSError,ValueError,KeyError):pass
    owned={os.getpid()}
    while True:
        more={pid for pid,(parent,_) in processes.items() if parent in owned}
        if more<=owned:break
        owned|=more
    memory=dict(line.split(":",1) for line in Path("/proc/meminfo").read_text().splitlines())
    return {"rss_bytes":sum(processes.get(pid,(0,0))[1] for pid in owned),
            "available_bytes":int(memory["MemAvailable"].split()[0])*1024,
            "swap_free_bytes":int(memory["SwapFree"].split()[0])*1024}

def tree_bytes(path):
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--retry-errors",action="store_true")
    parser.add_argument("--web-through",type=int,choices=[16,32,479],default=32)
    args=parser.parse_args()
    root=HERE/".runtime/capacity-pilot"
    data=HERE/".runtime/data"
    root.mkdir(parents=True,exist_ok=True)
    lock=(root/"run.lock").open("a")
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    cfg=json.loads((HERE/"capacity-pilot.json").read_text())
    if cfg["budget_usd"]!=500:raise RuntimeError("Pilot cap must match the US$500 authorization")
    prepared=json.loads((data/"prepared.json").read_text())
    for name,expected in PINS["dataset"]["sha256"].items():
        if sha(data/name)!=expected:raise RuntimeError("Pinned dataset mismatch")
    if sha(data/"trajectories.sqlite")!=prepared["index_sha256"]:raise RuntimeError("Index drift")
    db=sqlite3.connect("file:"+str(data/"trajectories.sqlite")+"?mode=ro",uri=True)
    selection=select_histories(data,db)
    manifest={"config":cfg,"selection":selection,"pins":PINS,"code":code_manifest(),
              "python":subprocess.check_output(["python3","--version"],text=True).strip(),
              "node":subprocess.check_output([cfg["node"],"--version"],text=True).strip()}
    if (root/"manifest.json").exists() and json.loads((root/"manifest.json").read_text())!=manifest:
        raise RuntimeError("Pilot resume refused: identity changed")
    atomic(root/"manifest.json",manifest)
    broker=Broker(root,cfg,credentials(REPO/".env"))
    stop=threading.Event()
    peak=[0]
    def monitor():
        while not stop.is_set():
            resource=sample_resources()
            peak[0]=max(peak[0],resource["rss_bytes"])
            event(root/"resources.jsonl",**resource)
            stop.wait(5)
    thread=threading.Thread(target=monitor,daemon=True);thread.start()
    started=time.time()
    atomic(root/"status.json",{"status":"running","pid":os.getpid(),"budget_usd":cfg["budget_usd"],"started_at":started})
    def checkpoint_observer(checkpoint):
        state=json.loads((checkpoint/"checkpoint.json").read_text())
        resource=sample_resources()
        size=tree_bytes(root)
        item={"domain":broker.case,"count":state["count"],"profile_bytes":tree_bytes(checkpoint/"profile"),
              "pilot_bytes":size,"cost_usd":broker.charged,"peak_rss_bytes":peak[0],
              "chunks":state["dream"]["chunks"],"wall_seconds_this_attempt":time.time()-started,**resource}
        event(root/"capacity.jsonl",**item)
        atomic(root/"status.json",{"status":"running","pid":os.getpid(),"budget_usd":cfg["budget_usd"],**item})
        if size>50*GIB:raise RuntimeError("Pilot storage guard: 50 GiB")
        if resource["available_bytes"]<384*1024**2:raise RuntimeError("Pilot available-RAM guard: 384 MiB")
    try:
        for domain,selected in selection.items():
            if args.web_through<479 and domain!="web":continue
            for milestone in (4,16,32,64,256,500):
                if args.web_through<479 and milestone>args.web_through:continue
                history=selected["history"];count=min(milestone,len(history))
                marker=root/f"{domain}-{count}.json"
                if marker.exists():continue
                broker.case=domain;broker.failed=False
                checkpoint=build_history(root/"histories",history,db,cfg,broker,args.retry_errors,
                                         stop_count=count,on_checkpoint=checkpoint_observer)
                before=broker.charged
                if build_history(root/"histories",history,db,cfg,broker,False,stop_count=count)!=checkpoint or broker.charged!=before:
                    raise RuntimeError("Resume repeated completed work")
                profile=root/"queries"/f"{domain}-{count}-{time.time_ns()}"
                restore(checkpoint,profile)
                # Capacity retrieval probe: use a public acquisition goal, never gold labels.
                trajectory=json.loads(db.execute("SELECT payload FROM trajectories WHERE id=?",(history[count-1],)).fetchone()[0])
                broker.stage="retrieval"
                worker=Worker(profile,cfg,broker,ingestion_time(count))
                try:
                    evidence=worker.call("query",query=trajectory["goal"],now=ingestion_time(count))
                    worker.close(ingestion_time(count))
                except BaseException:
                    worker.abort();raise
                atomic(marker,{"domain":domain,"count":count,"query_kind":"public trajectory goal",
                               "retrieval_items":len(evidence),"cost_usd":broker.charged,"resume_verified":True})
                print(json.dumps({"milestone":domain,"count":count,"cost_usd":broker.charged}),flush=True)
            if args.web_through==479:
                # Release the sole-spender lock before scoring this completed domain.
                broker.close()
                try:
                    subprocess.run(["/tmp/bitterbot-lme-v2-venv/bin/python",
                                    str(HERE/"diagnostics/score_pilot.py"),"--domain",domain],check=True)
                finally:
                    broker=Broker(root,cfg,credentials(REPO/".env"))
        atomic(root/"status.json",{"status":"completed" if args.web_through==479 else "capacity review ready","web_through":args.web_through,"cost_usd":broker.charged,"peak_rss_bytes":peak[0],"official_score":None})
    except BaseException as exc:
        atomic(root/"status.json",{"status":"stopped","cost_usd":broker.charged,"peak_rss_bytes":peak[0],
                                  "error":str(exc),"error_type":type(exc).__name__,"official_score":None})
        raise
    finally:
        stop.set();thread.join(timeout=6)
        subprocess.run(["python3",str(HERE/"report.py"),"--run",str(root)],check=False)
        broker.close();db.close()

if __name__=="__main__":main()
