"""UNTRUSTED container entry point. Receives code/inputs only, never answers.

Nothing this process prints is a verdict. The host compares strict JSON outputs
against independently qualified answers after this container exits.
"""
import contextlib
import io
import json
import sys

payload=json.load(sys.stdin)
namespace={'__name__':'submission'}
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        exec(compile(payload['code'],'submission.py','exec'),namespace)
        results=[namespace['solve'](x) for x in payload['inputs']]
    print(json.dumps(results,allow_nan=False,ensure_ascii=False))
except BaseException as exc:
    print(type(exc).__name__,file=sys.stderr)
    sys.exit(2)
