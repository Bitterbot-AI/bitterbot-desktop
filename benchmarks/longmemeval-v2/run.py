"""Checkpointed Medium evaluation with unchanged official reader/scoring functions."""
from __future__ import annotations
import argparse
import fcntl
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from core import *
import protocol

def snapshot_hashes(root):
    result={}
    for p in sorted(Path(root).rglob("*")):
        if p.is_symlink():raise RuntimeError("Symlink in memory checkpoint")
        if p.is_file():result[str(p.relative_to(root))]=sha(p)
    return result

def restore(checkpoint, destination):
    payload=json.loads((checkpoint/"checkpoint.json").read_text())
    source=checkpoint/"profile"
    if snapshot_hashes(source)!=payload["sha256"]:
        raise RuntimeError("Checkpoint integrity failure")
    shutil.copytree(source,destination)
    return payload

def build_history(root, history, db, cfg, broker, retry_errors, *, stop_count=None, on_checkpoint=None):
    directory=root/digest(history)
    directory.mkdir(parents=True,exist_ok=True)
    pointer=directory/"latest.json"
    failed=directory/"failed.json"
    if failed.exists() and not retry_errors:
        raise RuntimeError("History previously failed; inspect failed.json then pass --retry-errors")
    committed=0
    checkpoint=None
    if pointer.exists():
        pointer_data=json.loads(pointer.read_text())
        checkpoint=directory/pointer_data["generation"]
        manifest=json.loads((checkpoint/"checkpoint.json").read_text())
        if manifest["history"]!=history:raise RuntimeError("History checkpoint mismatch")
        if snapshot_hashes(checkpoint/"profile")!=manifest["sha256"]:raise RuntimeError("Corrupt memory checkpoint")
        committed=manifest["count"]
    target=len(history) if stop_count is None else min(stop_count,len(history))
    if target<len(history) and target % cfg["dream_every"]:
        raise RuntimeError("Partial pilot stop must be a normal dream boundary")
    while committed<target:
        generation=directory/("generation-"+uuid.uuid4().hex)
        profile=generation/"profile"
        end=min(committed+cfg["dream_every"],target)
        pending=directory/"ingested.json"
        worker=None
        try:
            ready=None
            if pending.exists():
                descriptor=json.loads(pending.read_text())
                if descriptor["start"]==committed and descriptor["end"]==end:
                    ready=directory/descriptor["generation"]
                    saved=json.loads((ready/"checkpoint.json").read_text())
                    if saved["history"]!=history or saved.get("phase")!="ingested":
                        raise RuntimeError("Pre-dream checkpoint identity mismatch")
            if ready is None:
                if checkpoint:restore(checkpoint,profile)
                else:profile.mkdir(parents=True)
                worker=Worker(profile,cfg,broker,ingestion_time(committed))
                for i in range(committed,end):
                    row=db.execute("SELECT payload FROM trajectories WHERE id=?",(history[i],)).fetchone()
                    if row is None:raise RuntimeError("Missing official trajectory")
                    broker.stage="ingestion"
                    worker.call("ingest",now=ingestion_time(i),trajectory=safe_trajectory(json.loads(row[0])))
                    broker.stage="consolidation"
                    worker.call("consolidate",now=ingestion_time(i)+30*60*1000)
                worker.close(ingestion_time(end-1)+30*60*1000)
                worker=None
                ready=directory/("ingested-"+uuid.uuid4().hex)
                ready.mkdir()
                shutil.copytree(profile,ready/"profile")
                atomic(ready/"checkpoint.json",{"history":history,"count":end,"phase":"ingested",
                                                "sha256":snapshot_hashes(ready/"profile")})
                atomic(pending,{"start":committed,"end":end,"generation":ready.name})
            else:
                restore(ready,profile)
            # The persisted pre-dream state is never mutated by a dream attempt.
            worker=Worker(profile,cfg,broker,ingestion_time(end-1)+30*60*1000)
            broker.stage="dreaming"
            dream=worker.call("dream",now=ingestion_time(end-1)+90*60*1000)
            worker.close(ingestion_time(end-1)+90*60*1000)
            worker=None
            atomic(generation/"checkpoint.json",{"history":history,"count":end,
                   "sha256":snapshot_hashes(profile),"dream":dream})
            atomic(pointer,{"generation":generation.name})
            checkpoint=generation
            committed=end
            if failed.exists():
                failed.rename(directory/("resolved-failure-"+uuid.uuid4().hex+".json"))
            for prior in directory.glob("ingested-*"):
                if prior!=ready and (prior/"profile").exists():
                    shutil.rmtree(prior/"profile")
            # Keep the newest two profiles; retain every checkpoint hash manifest.
            generations=sorted((g for g in directory.glob("generation-*") if (g/"checkpoint.json").exists()),
                key=lambda g:json.loads((g/"checkpoint.json").read_text())["count"])
            for old in generations[:-2]:
                old_profile=old/"profile"
                if old_profile.exists():
                    if not old_profile.resolve().is_relative_to(directory.resolve()):
                        raise RuntimeError("Unsafe checkpoint cleanup path")
                    shutil.rmtree(old_profile)
            if on_checkpoint:on_checkpoint(checkpoint)
        except BaseException as exc:
            if worker:worker.abort()
            atomic(failed,{"count_committed":committed,"attempt":generation.name,"error":str(exc)})
            raise
    return checkpoint

def make_memory_class(h, checkpoint, query_root, cfg, broker, query_time, screenshots):
    from memory_modules.memory import Memory
    profile=query_root/uuid.uuid4().hex
    restore(checkpoint,profile)
    worker=Worker(profile,cfg,broker,query_time)
    class BitterbotMemory(Memory):
        memory_type="bitterbot"
        def __init__(self):super().__init__({})
        def insert(self,trajectory):raise RuntimeError("Memory already ingested")
        def query(self,query,query_image=None):
            try:
                evidence=worker.call("query",query=query,now=query_time)
            except BaseException:
                worker.abort();raise
            # Real production retrieval is text based. Screenshots linked by returned
            # evidence are supplied to the official multimodal reader unchanged.
            images=[]
            for item in evidence:
                for name in re.findall(r"screenshots/[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+\.png",item["value"]):
                    target=(screenshots.parent/name).resolve()
                    if not target.is_relative_to(screenshots.resolve()) or not target.is_file():
                        raise RuntimeError("Retrieved screenshot missing or outside dataset")
                    if str(target) not in images:images.append(str(target))
            return evidence+[{"type":"image","value":p} for p in images]
        def post_query_hook(self, **kwargs):
            worker.close(query_time)
            return {"query_image_used_for_retrieval":False,"retrieval":"production text hybrid search"}
    return BitterbotMemory()

def validate_config(cfg):
    if not cfg.get("full_run_authorized"):
        raise RuntimeError("Full evaluation is not authorized in this reviewed configuration")
    if not 0 < cfg["budget_usd"]:
        raise RuntimeError("An explicit positive budget is required")
    if cfg["models"]["reader"]["model"].lower()!="qwen/qwen3.5-9b":
        raise RuntimeError("Comparable protocol requires Qwen/Qwen3.5-9B")
    if not cfg["models"]["judge"]["model"].startswith("gpt-5.2"):
        raise RuntimeError("Comparable protocol requires GPT-5.2 judge")
    for spec in cfg["models"].values():
        for key in ["model","revision","base_url","key_env","input_per_million","output_per_million"]:
            if spec.get(key) is None or spec.get(key)=="":
                raise RuntimeError("Missing model configuration: "+key)
    reader=cfg["models"]["reader"]
    if reader.get("transport")=="openrouter":
        if not reader.get("revision_verified") or not reader.get("revision_evidence"):
            raise RuntimeError("Hosted weight revision must be verified before a comparable run")
        protocol.openrouter_body({"chat_template_kwargs":{"enable_thinking":True}},reader)
    if cfg["dream_every"]!=4:
        raise RuntimeError("This protocol schedules a dream after each four 2-hour slots")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--config",type=Path,required=True)
    p.add_argument("--upstream",type=Path,required=True)
    p.add_argument("--data-root",type=Path,required=True)
    p.add_argument("--output",type=Path,required=True)
    p.add_argument("--env-file",type=Path,default=REPO/".env")
    p.add_argument("--credential-file",type=Path,action="append",default=[])
    p.add_argument("--retry-errors",action="store_true")
    p.add_argument("--stage",choices=["prepare-prompts","evaluate","all"],default="all")
    a=p.parse_args()
    cfg=json.loads(a.config.read_text());validate_config(cfg)
    h=protocol.load(a.upstream)
    data=a.data_root.resolve();out=a.output.resolve();out.mkdir(parents=True,exist_ok=True)
    lock=(out/"run.lock").open("w");fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    prepared=json.loads((data/"prepared.json").read_text())
    if prepared["revision"]!=PINS["dataset"]["revision"]:raise RuntimeError("Dataset revision drift")
    if prepared["sha256"]!=PINS["dataset"]["sha256"]:raise RuntimeError("Dataset hashes do not match pinned official release")
    if sha(data/"trajectories.sqlite")!=prepared["index_sha256"]:raise RuntimeError("Trajectory index hash drift")
    for name,expected in prepared["sha256"].items():
        if sha(data/name)!=expected:raise RuntimeError("Dataset hash drift: "+name)
    # No missing screenshots or patched data may silently become a text-only run.
    from data.public_data import validate_public_data,materialize_runtime_questions,materialize_runtime_haystack
    validate_public_data(data,tier="medium",check_screenshots=True)
    from transformers import AutoProcessor
    # Pin the tokenizer/processor revision without modifying upstream token-count logic.
    h.MEMORY_CONTEXT_PROCESSOR_LOCAL.processor=AutoProcessor.from_pretrained(
        "Qwen/Qwen3.5-9B",revision=cfg["models"]["reader"]["revision"])
    manifest={"pins":PINS,"config":cfg,"code":code_manifest(),"data":prepared["sha256"],
        "python":sys.version,"node":subprocess.check_output([cfg["node"],"--version"],text=True).strip(),
        "python_packages":subprocess.check_output([sys.executable,"-m","pip","freeze"],text=True).splitlines(),
        "git_head":subprocess.check_output(["git","rev-parse","HEAD"],cwd=REPO,text=True).strip(),
        "seed":cfg["seed"],"time_policy":"2025-01-01 UTC + 2h * ordered trajectory index; consolidate +30m; dream every4 +90m; final partial group also dreams"}
    manifest_path=out/"manifest.json"
    if manifest_path.exists() and json.loads(manifest_path.read_text())!=manifest:
        raise RuntimeError("Resume refused: code, configuration, data or environment changed")
    atomic(manifest_path,manifest)
    keys=credentials(a.env_file)
    for credential_file in a.credential_file:
        keys.update(credentials(credential_file))
    broker=Broker(out,cfg,keys)
    db=sqlite3.connect("file:"+str(data/"trajectories.sqlite")+"?mode=ro",uri=True)
    for domain in ["web","enterprise"]:
        domain_dir=out/domain;inputs=domain_dir/"runtime_inputs";inputs.mkdir(parents=True,exist_ok=True)
        questions=materialize_runtime_questions(data_root=data,domain=domain,question_ids=None,limit=None,output_path=inputs/"questions.json")
        histories=materialize_runtime_haystack(data_root=data,tier="medium",selected_questions=questions,output_path=inputs/"haystack.json")
        args=protocol.reader_args(cfg["models"]["reader"])
        atomic(domain_dir/"run_args.json",{**vars(args),"domain":domain,"tier":"medium","method":"bitterbot",
               "reader_model":args.model,"evaluator_model":cfg["models"]["judge"]["model"],
               "memory_context_max_tokens":200000,"evaluator_reasoning_effort":"medium"})
        records=[]
        for index,q in enumerate(questions):
            qid=q["id"]
            if not re.fullmatch(r"[a-zA-Z0-9_-]+",qid):raise RuntimeError("Unsafe question ID")
            case=domain_dir/"cases"/qid;case.mkdir(parents=True,exist_ok=True)
            broker.case=qid;broker.failed=False
            if (case/"failed.json").exists() and not a.retry_errors:
                raise RuntimeError("Previously failed question; explicit --retry-errors required")
            try:
                if not (case/"record.json").exists():
                    if not (case/"prompt.json").exists():
                        if a.stage=="evaluate":raise RuntimeError("Prepare all memory prompts before evaluation")
                        checkpoint=build_history(out/"histories",histories[qid],db,cfg,broker,a.retry_errors)
                        question_text,image=h.get_question_components(q["question"])
                        item={"index":index,"stream_index":index,"question_item":q,"question_id":qid,
                              "query_invocation_id":uuid.uuid4().hex,"question_type":q["question_type"],
                              "category":h.category_from_question_type(q["question_type"]),
                              "eval_function":q["eval_function"],"eval_name":h.eval_name(q["eval_function"]),
                              "question_text":question_text,"question_image":image,"answer_gold":q["answer"]}
                        memory=make_memory_class(h,checkpoint,out/"queries",cfg,broker,
                               ingestion_time(len(histories[qid])),data/"screenshots")
                        broker.stage="retrieval"
                        row=h.build_prompt_row(item,haystack_ids=histories[qid],memory=memory,
                              system_prompt=h.get_system_prompt(domain),memory_context_max_tokens=200000)
                        atomic(case/"prompt.json",row)
                    if a.stage=="prepare-prompts":continue
                    row=json.loads((case/"prompt.json").read_text())
                    if not (case/"reader.json").exists():
                        broker.stage="reader"
                        response=broker.call("reader",protocol.wire_body(h.build_reader_request(args,row["messages"])))
                        parsed_object=protocol.objectify(response)
                        raw=h.extract_text_from_response_message(parsed_object.choices[0].message)
                        if not raw:raise RuntimeError("Reader returned empty response")
                        parsed=h.extract_boxed_answer(raw)
                        atomic(case/"reader.json",{"response_raw":raw,"response_parsed_boxed":parsed,
                              "is_unknown":h.is_unknown(parsed),"usage":h.extract_usage_dict(parsed_object)})
                    row.update(json.loads((case/"reader.json").read_text()))
                    broker.stage="evaluation"
                    started=time.perf_counter()
                    score,_,_=protocol.judge(h,row,broker)
                    event(out/"stages.jsonl",case=qid,stage="evaluation",seconds=time.perf_counter()-started,status="success")
                    row.update(score=1.0 if score else 0.0,score_bool=score,timestamp_utc=h.utc_now_iso())
                    row.pop("messages",None)
                    atomic(case/"record.json",row)
                records.append(json.loads((case/"record.json").read_text()))
                if (case/"failed.json").exists():(case/"failed.json").unlink()
            except BaseException as exc:
                atomic(case/"failed.json",{"error":str(exc),"stage":broker.stage,"question_id":qid})
                raise
        if a.stage=="prepare-prompts":continue
        if {r["question_id"] for r in records}!=set(histories) or len(records)!=len(histories):
            raise RuntimeError("Incomplete/duplicate question coverage")
        (domain_dir/"per_question.jsonl").write_text("".join(json.dumps(r)+"\n" for r in records))
        atomic(domain_dir/"aggregated_metrics.json",protocol.aggregate(h,records))
    if a.stage=="prepare-prompts":
        atomic(out/"prompts-complete.json",{"questions":451,"status":"prepared; unscored"})
        return
    subprocess.run([sys.executable,str(a.upstream/"leaderboard/combine_aggregated_metrics.py"),
                    str(out/"enterprise/aggregated_metrics.json"),str(out/"web/aggregated_metrics.json"),
                    "-o",str(out/"combined_metrics.json")],check=True)
    subprocess.run([sys.executable,str(a.upstream/"leaderboard/build_submission_step_1_single_operating_point.py"),
                    str(out/"web"),str(out/"enterprise"),"bitterbot","default","medium","--method","bitterbot",
                    "--output-root",str(out/"submission"),"--force"],check=True)
    import tarfile
    source_archive=out/"harness-source.tar.gz"
    with tarfile.open(source_archive,"w:gz") as archive:
        for source in sorted(HERE.iterdir()):
            if source.is_file() and source.suffix in {".py",".ts",".json",".txt",".md"}:
                archive.add(source,arcname=source.name)
    subprocess.run([sys.executable,str(a.upstream/"leaderboard/build_submission_step_2_build_package.py"),
                    "bitterbot",str(HERE/"README.md"),str(source_archive),
                    str(out/"submission/bitterbot/operating_points/default"),
                    "--output-root",str(out/"submission"),"--force"],check=True)
    atomic(out/"completion.json",{"status":"complete","questions":451,"official_protocol":True})
    subprocess.run([sys.executable,str(HERE/"report.py"),"--run",str(out)],check=True)
    db.close()
if __name__=="__main__":main()
