"""JSON-lines host bridge to byte-exact tau2 telecom tools; no model calls here."""

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parent
DATASET = ROOT.parent / "datasets" / "tau-bench-v2-en"


def verify_sources():
    manifest = json.loads((ROOT / "native-sources.json").read_text())
    for entry in manifest["files"]:
        data = (ROOT / "vendor" / entry["path"]).read_bytes()
        actual = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        if actual != entry["gitBlobSha"]:
            raise ValueError(f"Changed native source: {entry['path']}")
    return manifest


SOURCES = verify_sources()
os.environ["TAU2_DATA_DIR"] = str(ROOT / "vendor" / "data")
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
# Import native leaf modules without tau2.__init__ eagerly loading every runner,
# voice provider and model client. No tool or state-transition code is patched.
package = types.ModuleType("tau2")
package.__path__ = [str(ROOT / "vendor" / "src" / "tau2")]
sys.modules["tau2"] = package

from loguru import logger
from tau2.data_model.message import AssistantMessage, ToolCall, UserMessage
from tau2.data_model.tasks import Task
from tau2.domains.telecom.environment import get_environment

logger.remove()
logger.add(sys.stderr, level="WARNING")
TASKS = [
    Task.model_validate(t)
    for t in json.loads(
        (DATASET / "upstream/data/tau2/multilingual/en/telecom_tasks_en.json")
        .read_text(encoding="utf8")
    )
]


def make_environment(task):
    env = get_environment()
    state = task.initial_state
    env.set_state(
        initialization_data=state.initialization_data if state else None,
        initialization_actions=state.initialization_actions if state else None,
        message_history=state.message_history or [] if state else [],
    )
    return env


def assertions(env, task):
    checks = [
        env.run_env_assertion(a, raise_assertion_error=False)
        for a in task.evaluation_criteria.env_assertions
    ]
    return {"passed": bool(checks) and all(checks), "checks": checks}


def protected_state(env):
    """Additional guard: all unrelated accounts, lines, bills and plan definitions."""
    phone = env.user_tools.db.surroundings.phone_number
    active_line = env.tools._get_line_by_phone(phone)
    if active_line is None:
        raise ValueError("Scenario has no active line")
    customer = env.tools.get_customer_by_phone(phone)
    data = env.tools.db.model_dump(mode="json")
    return {
        "customers": [c for c in data["customers"] if c["customer_id"] != customer.customer_id],
        "lines": [l for l in data["lines"] if l["line_id"] != active_line.line_id],
        "bills": [b for b in data["bills"] if b["customer_id"] != customer.customer_id],
        "plans": data["plans"],
        "devices": data["devices"],
    }


class Session:
    def __init__(self, index):
        self.task = TASKS[index]
        if [str(v.value) for v in self.task.evaluation_criteria.reward_basis] != ["ENV_ASSERTION"]:
            raise ValueError("Only environment-assertion tasks are supported")
        self.env = make_environment(self.task)
        self.before = protected_state(self.env)
        state = self.task.initial_state
        self.trajectory = list(state.message_history or []) if state else []
        self.calls = 0

    def context(self):
        return {
            "policy": self.env.get_policy(),
            "agentTools": [t.openai_schema for t in self.env.get_tools()],
            "userTools": [t.openai_schema for t in self.env.get_user_tools()],
            "userScenario": self.task.user_scenario.model_dump(mode="json"),
            "history": [m.model_dump(mode="json") for m in self.trajectory],
        }

    def call(self, role, name, arguments):
        if role not in ("assistant", "user"):
            raise ValueError("Invalid tool requestor")
        self.calls += 1
        tc = ToolCall(id=f"native-{self.calls}", name=name, arguments=arguments, requestor=role)
        message_type = AssistantMessage if role == "assistant" else UserMessage
        response = self.env.get_response(tc)
        self.trajectory.extend([message_type(role=role, tool_calls=[tc]), response])
        return {"content": response.content, "error": response.error}

    def judge(self):
        live = assertions(self.env, self.task)
        replay = get_environment()
        state = self.task.initial_state
        replay.set_state(
            initialization_data=state.initialization_data if state else None,
            initialization_actions=state.initialization_actions if state else None,
            message_history=self.trajectory,
        )
        reproduced = assertions(replay, self.task)
        replay_match = (
            live == reproduced
            and replay.get_db_hash() == self.env.get_db_hash()
            and replay.get_user_db_hash() == self.env.get_user_db_hash()
        )
        preserved = protected_state(self.env) == self.before
        return {
            "passed": live["passed"] and replay_match and preserved,
            "nativePassed": live["passed"],
            "checks": live["checks"],
            "replayMatch": replay_match,
            "unrelatedPreserved": preserved,
            "toolCalls": self.calls,
        }


def qualify():
    rows = []
    for i, task in enumerate(TASKS):
        if [v.value for v in task.evaluation_criteria.reward_basis] != ["ENV_ASSERTION"]:
            continue
        session = Session(i)
        noop = session.judge()
        errors = []
        for action in task.evaluation_criteria.actions:
            response = session.call(action.requestor, action.name, action.arguments)
            if response["error"]:
                errors.append(response)
        reference = session.judge()
        # Undo the first repair in another fresh instance. This is a deliberate
        # negative execution, never feedback for an actor or proposer.
        omitted = Session(i)
        for action in task.evaluation_criteria.actions[1:]:
            omitted.call(action.requestor, action.name, action.arguments)
        missing_first = omitted.judge()
        # Native end-state assertions alone need not protect unrelated accounts.
        # Exercise the supplementary guard after an otherwise successful repair.
        untouched = next(c for c in session.env.tools.db.customers if c.customer_id != session.env.tools.get_customer_by_phone(session.env.user_tools.db.surroundings.phone_number).customer_id)
        untouched.full_name = "CORRUPTED BY NEGATIVE CONTROL"
        tamper_rejected = protected_state(session.env) != session.before
        rows.append({"index": i, "id": task.id, "noop": noop, "reference": reference,
                     "referenceErrors": errors, "omitFirst": missing_first,
                     "unrelatedTamperRejected": tamper_rejected})
    return {"commit": SOURCES["commit"], "python": sys.version,
            "dependencies": {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()},
            "rows": rows}


def serve():
    session = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request["method"] == "reset":
                session = Session(request["index"])
                result = session.context()
            elif request["method"] == "call" and session:
                result = session.call(request["role"], request["name"], request["arguments"])
            elif request["method"] == "judge" and session:
                result = session.judge()
            else:
                raise ValueError("Unsupported request or missing session")
            print(json.dumps({"ok": True, "result": result}), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "qualify":
        result = qualify()
        destination = Path(sys.argv[2])
        with destination.open("x", encoding="utf8") as f:
            json.dump(result, f, indent=2)
        print(json.dumps({"cases": len(result["rows"]), "referencePasses": sum(r["reference"]["passed"] for r in result["rows"]), "noopPasses": sum(r["noop"]["passed"] for r in result["rows"]), "omitFirstPasses": sum(r["omitFirst"]["passed"] for r in result["rows"])}))
    else:
        serve()
