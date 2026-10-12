"""Reproducible state, credential-free worker IPC and bounded API accounting."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import urllib.error
import uuid
import selectors
import sqlite3
import fcntl

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
PINS = json.loads((HERE / "pins.json").read_text())
def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",",":")).encode()).hexdigest()
def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()
def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(value, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
def event(path, **value):
    with Path(path).open("a") as f:
        f.write(json.dumps({"wall_time":time.time(), **value}) + "\n")
        f.flush()
        os.fsync(f.fileno())
def credentials(path):
    # Never source repository shell code or log values; only approved model keys.
    result = {}
    for line in Path(path).read_text().splitlines():
        key, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and key in {"OPENAI_API_KEY","ANTHROPIC_API_KEY","OPENROUTER_API_KEY","OPENROUTER_KEY"}:
            result[key] = value.strip().strip("'").strip('"')
    return result

class TransientAPIError(RuntimeError):
    pass

class Broker:
    def __init__(self, root, config, keys):
        self.root, self.config, self.keys = Path(root), config, keys
        self.root.mkdir(parents=True, exist_ok=True)
        self.budget_lock = (self.root/"budget.lock").open("a")
        fcntl.flock(self.budget_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.ledger = self.root / "api-ledger.json"
        self.database = sqlite3.connect(self.root/"accounting.sqlite")
        self.database.execute("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, charged REAL NOT NULL, payload TEXT NOT NULL)")
        if self.database.execute("SELECT count(*) FROM requests").fetchone()[0] == 0 and self.ledger.exists():
            for index, row in enumerate(json.loads(self.ledger.read_text())):
                row.setdefault("id","legacy-"+str(index))
                self.database.execute("INSERT INTO requests VALUES (?,?,?)",(row["id"],row.get("cost_usd",row["reserved_usd"]),json.dumps(row)))
            self.database.commit()
        self.charged = self.database.execute("SELECT COALESCE(sum(charged),0) FROM requests").fetchone()[0]
        self.stage = "initialization"
        self.case = None
        self.failed = False
    def close(self):
        self.database.close()
        self.budget_lock.close()
    @property
    def entries(self):
        return [json.loads(row[0]) for row in self.database.execute("SELECT payload FROM requests ORDER BY rowid")]
    def save_request(self, row):
        self.database.execute("INSERT INTO requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET charged=excluded.charged,payload=excluded.payload",
            (row["id"],row.get("cost_usd",row["reserved_usd"]),json.dumps(row)))
        self.database.commit()
    def call(self, kind, body):
        if self.failed:
            raise RuntimeError("API circuit is open after an unrecovered failure; no call dispatched")
        policy=self.config.get("retry_policy",{})
        attempts=policy.get("max_attempts",1)
        if not isinstance(attempts,int) or not 1<=attempts<=3:
            raise RuntimeError("Retry attempts must be between one and three")
        for attempt in range(1,attempts+1):
            try:
                return self._call_once(kind,body,attempt=attempt)
            except TransientAPIError:
                if attempt==attempts:
                    self.failed=True
                    raise
                time.sleep(min(30,policy.get("backoff_seconds",2)*2**(attempt-1)))
            except Exception:
                self.failed=True
                raise
    def _call_once(self, kind, body, *, attempt):
        spec = self.config["models"][kind]
        body = dict(body)
        if kind == "embedding":
            if set(body) != {"model","input"} or body["model"] != spec["model"]:
                raise RuntimeError("Unexpected embedding request")
        elif kind == "dream":
            if set(body) != {"messages"}:
                raise RuntimeError("Unexpected dream request")
            body.update(model=spec["model"], max_tokens=6144, temperature=0)
        else:
            if body.get("model") != spec["model"]:
                raise RuntimeError("Unexpected evaluator model")
        if kind == "reader" and spec.get("transport") == "openrouter":
            from protocol import openrouter_body
            body = openrouter_body(body, spec)
        raw = json.dumps(body).encode()
        output_limit = body.get("max_completion_tokens", body.get("max_tokens", 0))
        # UTF-8 bytes + message overhead is a conservative upper bound for text BPE.
        # Vision reader reservations use the endpoint context maximum instead.
        input_bound = max(len(raw) + 4096, spec.get("input_reservation_tokens", 0))
        reserve = (input_bound * spec["input_per_million"] + output_limit * spec["output_per_million"]) / 1e6
        used = self.charged
        if used + reserve > self.config["budget_usd"]:
            self.failed = True
            raise RuntimeError("API budget exhausted before request; no call dispatched")
        row = {"id":uuid.uuid4().hex,"kind":kind,"stage":self.stage,"case":self.case,
               "model":spec["model"],"request_sha256":hashlib.sha256(raw).hexdigest(),
               "reserved_usd":reserve,"status":"inflight","started_at":time.time(),"attempt":attempt}
        self.charged += reserve
        self.save_request(row)
        start = time.perf_counter()
        try:
            key = self.keys.get(spec["key_env"], os.environ.get(spec["key_env"],""))
            if not key:
                raise RuntimeError("Missing credential variable " + spec["key_env"])
            suffix = "/embeddings" if kind == "embedding" else "/chat/completions"
            req = urllib.request.Request(spec["base_url"].rstrip("/") + suffix, data=raw,
                    headers={"Content-Type":"application/json","Authorization":"Bearer "+key})
            with urllib.request.urlopen(req, timeout=spec.get("timeout",600)) as response:
                payload = json.load(response)
                row["request_id"] = response.headers.get("x-request-id")
            usage = payload.get("usage")
            if not isinstance(usage,dict) or "prompt_tokens" not in usage:
                raise RuntimeError("Endpoint omitted usage; reserved charge retained")
            if kind != "embedding" and "completion_tokens" not in usage:
                raise RuntimeError("Endpoint omitted completion usage")
            row["usage"] = usage
            row["served_model"] = payload.get("model")
            row["served_provider"] = payload.get("provider")
            row["response_id"] = payload.get("id")
            row["cost_usd"] = (usage["prompt_tokens"] * spec["input_per_million"] +
                              usage.get("completion_tokens",0) * spec["output_per_million"]) / 1e6
            if row["cost_usd"] > reserve:
                raise RuntimeError("Endpoint exceeded conservative reservation; stop run")
            row["status"] = "success"
            return payload
        except Exception as exc:
            row["status"] = "error"
            row["error"] = type(exc).__name__ # no response body or credential-bearing URL
            transient=isinstance(exc,(TimeoutError,ConnectionResetError))
            if isinstance(exc,urllib.error.HTTPError):
                row["http_status"]=exc.code
                transient=exc.code in {429,500,502,503,504,520}
            elif isinstance(exc,urllib.error.URLError):
                transient=isinstance(exc.reason,(TimeoutError,ConnectionResetError))
            row["retryable"]=transient
            error_type=TransientAPIError if transient else RuntimeError
            raise error_type("API request failed: " + type(exc).__name__) from None
        finally:
            row["seconds"] = time.perf_counter()-start
            self.charged += row.get("cost_usd",reserve)-reserve
            self.save_request(row)

class Worker:
    def __init__(self, profile, cfg, broker, now):
        self.profile, self.broker = Path(profile).resolve(), broker
        self.profile.mkdir(parents=True,exist_ok=True)
        for name in ["home","state","tmp","workspace","agent"]:
            (self.profile/name).mkdir(exist_ok=True)
        atomic(self.profile/"empty-config.json",{})
        node = Path(cfg["node"]).resolve(strict=True)
        env = {"PATH":str(node.parent)+":/usr/bin:/bin","HOME":str(self.profile/"home"),
               "BITTERBOT_HOME":str(self.profile/"home"),"BITTERBOT_STATE_DIR":str(self.profile/"state"),
               "BITTERBOT_CONFIG_PATH":str(self.profile/"empty-config.json"),
               "BITTERBOT_OAUTH_DIR":str(self.profile/"oauth"),"TMPDIR":str(self.profile/"tmp"),
               "XDG_CONFIG_HOME":str(self.profile/"home"),"XDG_CACHE_HOME":str(self.profile/"home"),
               "TZ":"UTC","NODE_ENV":"production","BITTERBOT_LOG_LEVEL":"debug"}
        allowed = ["/usr","/lib","/lib64","/etc/ld.so.cache","/etc/ssl","/dev/urandom",
                   str(node.parent.parent),str(REPO/"node_modules"),str(REPO/"src"),
                   str(REPO/"package.json"),str(HERE/"worker.ts")]
        spec = {"read":[p for p in allowed if Path(p).exists()],
                "write":[str(self.profile),"/dev/null"],"cwd":str(self.profile),"env":env,
                "command":[str(node),"--import",str(REPO/"node_modules/tsx/dist/loader.mjs"),str(HERE/"worker.ts")]}
        self.log = (self.profile/"worker.log").open("a")
        self.process = subprocess.Popen(["/usr/bin/python3",str(HERE/"sandbox.py"),json.dumps(spec)],
                        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,bufsize=1)
        self.sequence = 0
        self.receive_buffer = b""
        try:
            self.call("init",now=now,profile=str(self.profile),config={
                "embeddingModel":cfg["models"]["embedding"]["model"],
                "dreamModel":cfg["models"]["dream"]["model"],"seed":cfg["seed"],
                "dreamCalls":cfg["dream_calls"],"maxResults":cfg["max_results"]})
        except BaseException:
            self.abort()
            raise
    def call(self, op, **params):
        self.sequence += 1
        request = {"id":self.sequence,"op":op,**params}
        self.process.stdin.write(json.dumps(request)+"\n");self.process.stdin.flush()
        started = time.perf_counter()
        while True:
            # Timeout includes inference retries. A failure can never become empty evidence.
            while b"\n" not in self.receive_buffer:
                ready = selectors.DefaultSelector()
                ready.register(self.process.stdout,selectors.EVENT_READ)
                readable = ready.select(900)
                ready.close()
                if not readable:
                    self.abort()
                    raise RuntimeError("Worker operation timed out")
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError("Memory worker exited; inspect isolated worker.log")
                self.receive_buffer += chunk
            raw_line, self.receive_buffer = self.receive_buffer.split(b"\n",1)
            line = raw_line.decode()
            try:
                response = json.loads(line)
            except json.JSONDecodeError:
                # Subsystem human logs may be written to stdout; retain without interpreting.
                self.log.write(line);self.log.flush()
                continue
            if response.get("type") == "api":
                try:
                    if response["kind"] not in {"embedding","dream"}:
                        raise RuntimeError("Worker cannot access evaluator model roles")
                    body = self.broker.call(response["kind"],response["body"])
                    reply = {"type":"api_result","id":response["id"],"body":body}
                except Exception as exc:
                    self.broker.failed = True
                    event(self.broker.root/"stages.jsonl",stage=op,case=self.broker.case,
                          seconds=time.perf_counter()-started,historical_ms=params.get("now"),
                          status="error",error="unrecovered_api_failure")
                    self.abort()
                    raise RuntimeError("Memory API call failed; retry policy stopped the request: "+str(exc)) from None
                self.process.stdin.write(json.dumps(reply)+"\n");self.process.stdin.flush()
                continue
            if response.get("type") != "result" or response.get("id") != self.sequence:
                raise RuntimeError("Invalid worker protocol frame")
            event(self.broker.root/"stages.jsonl",stage=op,case=self.broker.case,
                  seconds=time.perf_counter()-started,historical_ms=params.get("now"),
                  status="error" if response.get("error") else "success")
            if response.get("error") or self.broker.failed:
                raise RuntimeError(response.get("error","A model call failed inside production memory"))
            return response["result"]
    def close(self, now):
        try:
            self.call("close",now=now)
        finally:
            self.abort()
    def abort(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
        self.log.close()

def code_manifest():
    paths = subprocess.check_output(["git","ls-files","src","package.json","pnpm-lock.yaml"],cwd=REPO,text=True).splitlines()
    paths += [str(p.relative_to(REPO)) for p in HERE.glob("*.py")]
    paths += [str(p.relative_to(REPO)) for p in HERE.glob("*.ts")]
    paths += [str(p.relative_to(REPO)) for p in HERE.glob("*.json")]
    paths += [str(p.relative_to(REPO)) for p in HERE.glob("*.txt")]
    return {p:sha(REPO/p) for p in sorted(set(paths)) if (REPO/p).is_file()}

def safe_trajectory(t):
    # Explicit public trajectory schema; never pass arbitrary question/evaluation fields.
    fields = ["id","domain","environment","goal","outcome","start_url"]
    state_fields = ["state_index","step","url","action","thought","accessibility_tree","screenshot"]
    if set(t) != set(fields+["states"]):
        raise RuntimeError("Trajectory schema drift; review before continuing")
    for s in t["states"]:
        if set(s) != set(state_fields):
            raise RuntimeError("State schema drift; review before continuing")
    return {**{k:t[k] for k in fields},"states":[{k:s[k] for k in state_fields} for s in t["states"]]}

# Dataset contains no acquisition timestamps. This is declared synthetic historical time.
EPOCH_MS = 1735689600000 # 2025-01-01T00:00:00Z
SLOT_MS = 2*60*60*1000
def ingestion_time(index):return EPOCH_MS+index*SLOT_MS
