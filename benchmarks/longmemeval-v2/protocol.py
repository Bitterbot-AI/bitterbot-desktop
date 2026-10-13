"""Use the pinned upstream prompts, reader requests, tokenizer and scoring verbatim."""
import argparse
import importlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from core import PINS

def load(upstream):
    upstream=Path(upstream).resolve()
    if subprocess.check_output(["git","rev-parse","HEAD"],cwd=upstream,text=True).strip()!=PINS["upstream"]["commit"]:
        raise RuntimeError("Wrong official harness revision")
    if subprocess.check_output(["git","status","--porcelain","--untracked-files=no"],cwd=upstream,text=True).strip():
        raise RuntimeError("Modified official evaluator checkout")
    sys.path.insert(0,str(upstream))
    return importlib.import_module("evaluation.harness")

def reader_args(spec):
    return argparse.Namespace(model=spec["model"],base_url=spec["base_url"],
        timeout_seconds=43200.0,max_completion_tokens=20000,reasoning_effort=None,
        temperature=0.6,top_p=0.95,presence_penalty=None,top_k=20,repetition_penalty=None,
        reader_enable_thinking=True)

def wire_body(request):
    request=dict(request)
    request.pop("timeout",None) # transport-only SDK parameter
    request.update(request.pop("extra_body",{}))
    return request

def objectify(value):
    if isinstance(value,dict):return SimpleNamespace(**{k:objectify(v) for k,v in value.items()})
    if isinstance(value,list):return [objectify(v) for v in value]
    return value

def judge(h, row, broker):
    # Only transport is substituted: exact upstream judge prompt, parser, and rubric.
    import openai
    real=openai.OpenAI
    class AccountedClient:
        def __init__(self,**kwargs):
            self.chat=SimpleNamespace(completions=SimpleNamespace(create=self.create))
        def create(self,**kwargs):
            return objectify(broker.call("judge",wire_body(kwargs)))
    spec=broker.config["models"]["judge"]
    try:
        openai.OpenAI=AccountedClient
        return h.score_prediction(row,{"evaluator_model":spec["model"],
            "evaluator_base_url":spec["base_url"],"evaluator_api_key":"broker",
            "evaluator_reasoning_effort":"medium","evaluator_max_completion_tokens":4096,
            "evaluator_timeout_seconds":43200.0})
    finally:openai.OpenAI=real

def aggregate(h, records):
    result=h.aggregate_metrics(records)
    for key,field in [("memory_query","memory_query_duration_seconds"),
                      ("memory_post_query","memory_post_query_duration_seconds")]:
        values=sorted(float(r[field]) for r in records)
        result[key]={"avg_seconds":sum(values)/len(values),"total_seconds":sum(values),
                     "p50_seconds":values[len(values)//2],
                     "p95_seconds":values[min(len(values)-1,int(.95*len(values)))],
                     "max_seconds":values[-1]}
    prompt=sum(r["usage"]["prompt_tokens"] for r in records)
    completion=sum(r["usage"]["completion_tokens"] for r in records)
    result["tokens"]={"prompt_tokens":prompt,"completion_tokens":completion,
                      "total_tokens":prompt+completion,"avg_prompt_tokens":prompt/len(records),
                      "avg_completion_tokens":completion/len(records),"avg_total_tokens":(prompt+completion)/len(records)}
    result["memory_context"]={"avg_original_tokens":sum(r["memory_context_original_token_count"] for r in records)/len(records),
       "avg_final_tokens":sum(r["memory_context_token_count"] for r in records)/len(records),
       "num_truncated_sequences":sum(r["memory_context_was_truncated"] for r in records)}
    result.update(completed_at_utc=h.utc_now_iso(),shared_haystack=False)
    return result


def openrouter_body(body, spec):
    """Map vLLM thinking control to OpenRouter without changing sampling settings."""
    body = dict(body)
    template = body.pop("chat_template_kwargs", None)
    if template is not None and template != {"enable_thinking": True}:
        raise RuntimeError("Unexpected official thinking configuration")
    provider = spec.get("provider")
    if not provider or spec.get("quantization") != "bf16":
        raise RuntimeError("OpenRouter reader requires one pinned BF16 provider")
    body["reasoning"] = {"enabled": True}
    body["provider"] = {"only": [provider], "allow_fallbacks": False,
                        "require_parameters": True, "quantizations": ["bf16"]}
    return body
