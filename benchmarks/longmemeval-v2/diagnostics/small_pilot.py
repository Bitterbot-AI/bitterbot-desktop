"""Ten-question Small-tier diagnostic, using the shared authorized pilot ledger."""
import sys
from pathlib import Path
BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
import argparse,fcntl,json,os,sqlite3,subprocess,threading,time,uuid
from core import *
from run import build_history,make_memory_class
from capacity_pilot import sample_resources,tree_bytes
import protocol

ROOT=BASE/".runtime/capacity-pilot"
OUT=ROOT/"small-accuracy"
DATA=BASE/".runtime/data"
UPSTREAM=Path("/tmp/bitterbot-lme-v2-upstream")
SMALL_SHA="9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593"
def select(histories,info,seed=1701):
    selected={}
    for domain in ("web","enterprise"):
        ids=[qid for qid,h in histories.items() if info[h[0]][0]==domain]
        ids.sort(key=lambda qid:(digest([seed,domain,qid]),qid))
        chosen=ids[:5]
        if len(chosen)!=5:raise RuntimeError("Need five questions per domain")
        unique={tuple(histories[qid]) for qid in chosen}
        if len(unique)!=1:raise RuntimeError("Small release no longer has one shared history per domain")
        history=list(next(iter(unique)))
        if len(history)!=100 or len(set(history))!=100:raise RuntimeError("Unexpected Small history")
        if any(info[t][0]!=domain for t in history):raise RuntimeError("Cross-domain history")
        selected[domain]={"question_ids":chosen,"history":history,"raw_bytes":sum(info[t][1] for t in history)}
    return selected

def write_status(state,**fields):atomic(OUT/"status.json",{"status":state,"timestamp":time.time(),**fields})
def publish(broker,selection):
    records=[]
    for case in OUT.glob("cases/*/record.json"):records.append(json.loads(case.read_text()))
    completed={r["question_id"] for r in records}
    expected=[q for s in selection.values() for q in s["question_ids"]]
    result={"tier":"small","diagnostic_only":True,"planned":10,"scored":len(records),
            "correct":sum(r["score_bool"] for r in records),"pending":[q for q in expected if q not in completed],
            "sample_accuracy":sum(r["score_bool"] for r in records)/len(records) if records else None,
            "cumulative_combined_usd":broker.charged,"budget_usd":broker.config["budget_usd"],
            "official_full_score":None,"reader_revision_verified":False,"results":records}
    atomic(OUT/"results.json",result)
    lines=["# Small-tier accuracy diagnostic","",
           "Five deterministic ID-sampled questions per domain; complete 100-trajectory histories.",
           "Official reader prompts and scoring functions; hosted Qwen weight revision remains unverified.",
           "This is a small diagnostic sample, not a full Small or Medium benchmark score.","",
           f"Scored: {len(records)}/10. Correct among scored: {result['correct']}. Pending questions remain pending.",
           f"Combined ledger: US$ {broker.charged:.6f} / {broker.config['budget_usd']}.",""]
    for r in records:
        lines.append(f"- {r['domain']} / {r['question_id']}: "+("correct" if r["score_bool"] else "incorrect"))
        lines.append("  Answer: "+str(r["response_parsed_boxed"]))
    (OUT/"report.md").write_text("\n".join(lines)+"\n")

def score_case(h,q,domain,history,checkpoint,cfg,broker,retry):
    qid=q["id"];case=OUT/"cases"/qid;case.mkdir(parents=True,exist_ok=True)
    failure=case/"failed.json"
    if failure.exists():
        if not retry:raise RuntimeError("Recorded question failure requires --retry-errors")
        failure.rename(case/("prior-failure-"+uuid.uuid4().hex+".json"))
    if (case/"record.json").exists():return
    broker.case="small-question-"+qid;broker.failed=False
    write_status("scoring",domain=domain,question_id=qid,cumulative_combined_usd=broker.charged)
    try:
        if not (case/"prompt.json").exists():
            text,image=h.get_question_components(q["question"])
            item={"index":0,"stream_index":0,"question_item":q,"question_id":qid,
                  "query_invocation_id":uuid.uuid4().hex,"question_type":q["question_type"],
                  "category":h.category_from_question_type(q["question_type"]),
                  "eval_function":q["eval_function"],"eval_name":h.eval_name(q["eval_function"]),
                  "question_text":text,"question_image":image,"answer_gold":q["answer"]}
            broker.stage="small-retrieval"
            memory=make_memory_class(h,checkpoint,OUT/"query-profiles",cfg,broker,
                                     ingestion_time(len(history)),DATA/"screenshots")
            row=h.build_prompt_row(item,haystack_ids=history,memory=memory,
                                  system_prompt=h.get_system_prompt(domain),memory_context_max_tokens=200000)
            atomic(case/"prompt.json",row)
        row=json.loads((case/"prompt.json").read_text())
        if not (case/"reader.json").exists():
            broker.stage="small-reader"
            response=broker.call("reader",protocol.wire_body(h.build_reader_request(
                protocol.reader_args(cfg["models"]["reader"]),row["messages"])))
            provider=response.get("provider")
            if provider and "deepinfra" not in provider.lower():raise RuntimeError("Unexpected reader provider")
            obj=protocol.objectify(response)
            raw=h.extract_text_from_response_message(obj.choices[0].message)
            if not raw:raise RuntimeError("Empty reader response")
            answer=h.extract_boxed_answer(raw)
            atomic(case/"reader.json",{"response_raw":raw,"response_parsed_boxed":answer,
                  "is_unknown":h.is_unknown(answer),"usage":h.extract_usage_dict(obj),"served_provider":provider})
        row.update(json.loads((case/"reader.json").read_text()))
        broker.stage="small-evaluation";started=time.perf_counter()
        score,_,_=protocol.judge(h,row,broker)
        event(ROOT/"stages.jsonl",stage="small-evaluation",case=qid,status="success",seconds=time.perf_counter()-started)
        row.update(domain=domain,tier="small",score_bool=bool(score),score=1.0 if score else 0.0,
                   diagnostic_only=True,reader_revision_verified=False,timestamp_utc=h.utc_now_iso())
        row.pop("messages",None);atomic(case/"record.json",row)
    except BaseException as exc:
        atomic(failure,{"error":str(exc),"stage":broker.stage});raise

def main():
    parser=argparse.ArgumentParser();parser.add_argument("--retry-errors",action="store_true")
    args=parser.parse_args();OUT.mkdir(parents=True,exist_ok=True)
    # This controller and Medium cannot mutate profiles or spend concurrently.
    lock=(ROOT/"run.lock").open("a");fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    cfg=json.loads((BASE/"capacity-pilot.json").read_text())
    authorization=json.loads((ROOT/"budget-authorization.json").read_text())
    if cfg["budget_usd"]!=authorization["budget_usd"]:raise RuntimeError("Budget authorization mismatch")
    extra=json.loads((BASE/"openrouter-run.example.json").read_text())
    for role in ("reader","judge"):cfg["models"][role]=extra["models"][role]
    write_status("validating inputs",budget_usd=cfg["budget_usd"],pid=os.getpid())
    if sha(DATA/"haystacks/lme_v2_small.json")!=SMALL_SHA:raise RuntimeError("Small release hash mismatch")
    for name,value in PINS["dataset"]["sha256"].items():
        if sha(DATA/name)!=value:raise RuntimeError("Pinned dataset mismatch")
    prepared=json.loads((DATA/"prepared.json").read_text())
    if sha(DATA/"trajectories.sqlite")!=prepared["index_sha256"]:raise RuntimeError("Trajectory index drift")
    db=sqlite3.connect("file:"+str(DATA/"trajectories.sqlite")+"?mode=ro",uri=True)
    info={r[0]:(r[1],r[2]) for r in db.execute("select id,domain,bytes from trajectories")}
    histories=json.loads((DATA/"haystacks/lme_v2_small.json").read_text())
    selection=select(histories,info)
    identity={"tier":"small","selection":selection,"sampling":"lowest SHA256([1701,domain,question_id]), five per domain",
              "config":cfg,"pins":PINS,"small_sha256":SMALL_SHA,"code":code_manifest(),"runner_sha256":sha(__file__),
              "python":sys.version,"packages":subprocess.check_output([sys.executable,"-m","pip","freeze"],text=True).splitlines(),
              "node":subprocess.check_output([cfg["node"],"--version"],text=True).strip(),
              "reader_revision_verified":False,"budget_ledger":str(ROOT/"accounting.sqlite")}
    if (OUT/"manifest.json").exists() and json.loads((OUT/"manifest.json").read_text())!=identity:
        raise RuntimeError("Small diagnostic resume identity drift")
    atomic(OUT/"manifest.json",identity)
    # Stream validation of selected public histories, avoiding a 1.2 GB JSON load.
    for domain,s in selection.items():
        for tid in s["history"]:
            trajectory=safe_trajectory(json.loads(db.execute("select payload from trajectories where id=?",(tid,)).fetchone()[0]))
            for state in trajectory["states"]:
                image=state.get("screenshot")
                if image and not (DATA/image).is_file():raise RuntimeError("Missing official trajectory screenshot")
    h=protocol.load(UPSTREAM)
    from data.public_data import materialize_runtime_questions
    from transformers import AutoProcessor
    h.MEMORY_CONTEXT_PROCESSOR_LOCAL.processor=AutoProcessor.from_pretrained(
        "Qwen/Qwen3.5-9B",revision=PINS["reader_processor_revision"])
    questions={domain:materialize_runtime_questions(data_root=DATA,domain=domain,
               question_ids=s["question_ids"],limit=None,output_path=OUT/(domain+"-evaluator-questions.json"))
               for domain,s in selection.items()}
    keys=credentials(REPO/".env");keys.update(credentials(Path("/mnt/d/Bitterbot/bitterbot-desktop/.env")))
    broker=Broker(ROOT,cfg,keys);stop=threading.Event();peak=[0]
    def monitor():
        while not stop.is_set():
            resource=sample_resources();peak[0]=max(peak[0],resource["rss_bytes"])
            event(OUT/"resources.jsonl",**resource);stop.wait(5)
    thread=threading.Thread(target=monitor,daemon=True);thread.start()
    started=time.time()
    def checkpointed(checkpoint):
        saved=json.loads((checkpoint/"checkpoint.json").read_text());resource=sample_resources()
        fields={"case":broker.case,"count":saved["count"],"chunks":saved["dream"]["chunks"],
                "profile_bytes":tree_bytes(checkpoint/"profile"),"elapsed_seconds":time.time()-started,
                "cumulative_combined_usd":broker.charged,"peak_rss_bytes":peak[0]}
        event(OUT/"capacity.jsonl",**fields);write_status("ingesting",**fields,budget_usd=cfg["budget_usd"],pid=os.getpid())
        if tree_bytes(ROOT)>50*1024**3 or resource["available_bytes"]<384*1024**2:
            raise RuntimeError("Pilot resource guard reached")
    try:
        publish(broker,selection)
        for domain,s in selection.items():
            broker.case="small-history-"+domain;broker.failed=False
            write_status("ingesting",domain=domain,required=100,budget_usd=cfg["budget_usd"],pid=os.getpid())
            checkpoint=build_history(OUT/"histories",s["history"],db,cfg,broker,args.retry_errors,on_checkpoint=checkpointed)
            for q in questions[domain]:
                score_case(h,q,domain,s["history"],checkpoint,cfg,broker,args.retry_errors)
                publish(broker,selection)
        write_status("completed",scored=10,cumulative_combined_usd=broker.charged,budget_usd=cfg["budget_usd"])
    except BaseException as exc:
        write_status("stopped",error=str(exc),error_type=type(exc).__name__,cumulative_combined_usd=broker.charged)
        raise
    finally:
        publish(broker,selection);stop.set();thread.join(timeout=6)
        broker.close();db.close()

if __name__=="__main__":
    try:main()
    except BaseException as exc:
        if not (OUT/"status.json").exists() or json.loads((OUT/"status.json").read_text()).get("status")!="stopped":
            write_status("stopped",error=str(exc),error_type=type(exc).__name__)
        raise
