"""Screening projection from real plumbing measurements; not a capacity guarantee."""
import json
import math
import sqlite3
from core import HERE, atomic

def main():
    runtime=HERE/".runtime"
    prepared=json.loads((runtime/"data/prepared.json").read_text())
    smoke=json.loads((runtime/"checkpoint-final/result.json").read_text())
    histories={tuple(v) for v in json.loads((runtime/"data/haystacks/lme_v2_medium.json").read_text()).values()}
    total_bytes=sum(v["history_bytes"] for v in prepared["inventory"].values())
    cycles=sum(math.ceil(len(h)/4) for h in histories)
    db=sqlite3.connect(runtime/"plumbing-budget/accounting.sqlite")
    rows=[json.loads(r[0]) for r in db.execute("SELECT payload FROM requests")]
    measured=[r for r in rows if r.get("case")==smoke["accounting_case"]]
    stages=[json.loads(l) for l in (runtime/"plumbing-budget/stages.jsonl").read_text().splitlines()]
    stages=[r for r in stages if r.get("case")==smoke["accounting_case"]]
    ingestion_cost=sum(r["cost_usd"] for r in measured if r["stage"]=="ingestion")
    dream_cost=sum(r["cost_usd"] for r in measured if r["stage"]=="dreaming")
    factor=total_bytes/smoke["trajectory_bytes"]
    ingest_seconds=sum(r["seconds"] for r in stages if r["stage"]=="ingest")
    dream_seconds=sum(r["seconds"] for r in stages if r["stage"]=="dream")
    result={
        "kind":"single-small-trajectory linear screening projection; NOT validated full-history throughput",
        "inventory":prepared["inventory"],"dream_cycles":cycles,"replayed_bytes":total_bytes,
        "sample_bytes":smoke["trajectory_bytes"],"byte_scale_factor":factor,
        "measured_ingestion_usd":ingestion_cost,"measured_dream_usd":dream_cost,
        "measured_ingestion_seconds":ingest_seconds,"measured_dream_seconds":dream_seconds,
        "projected_ingestion_usd":factor*ingestion_cost,
        "projected_dream_usd":cycles*dream_cost,
        "projected_memory_usd":factor*ingestion_cost+cycles*dream_cost,
        "projected_serial_days":(factor*ingest_seconds+cycles*dream_seconds)/86400,
        "reader_451_at_200k_input_20k_output_usd":451*(200000*.1+20000*.15)/1e6,
        "judge_451_at_4096_output_usd_excluding_input":451*4096*14/1e6,
        "cumulative_plumbing_usd":sum(r.get("cost_usd",r["reserved_usd"]) for r in rows),
        "limitations":["A complete 500-trajectory history has not been measured.",
            "Reindexing, consolidation and checkpoint copying may grow nonlinearly.",
            "Dream cost per cycle will vary with memory size.",
            "Excludes reader/judge latency, screenshot transfer, failed attempts and storage costs.",
            "Hosted reader price is a catalog tariff, not a binding quote."]}
    atomic(HERE/"projection.json",result)
    print(json.dumps(result,indent=2))
if __name__=="__main__":main()
