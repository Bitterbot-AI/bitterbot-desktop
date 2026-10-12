import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from core import Broker, HERE
from run import build_history

class RecoveryTests(unittest.TestCase):
    def broker(self, root, budget=10):
        cfg={"budget_usd":budget,"retry_policy":{"max_attempts":3,"backoff_seconds":0},
             "models":{"embedding":{"model":"test-transport","key_env":"TEST_KEY",
             "base_url":"https://invalid.example","input_per_million":1,"output_per_million":0}}}
        return Broker(root,cfg,{"TEST_KEY":"unit-test-only"})

    def test_timeout_retry_retains_both_charges(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=self.broker(tmp)
            reply=io.BytesIO(json.dumps({"usage":{"prompt_tokens":2},"data":[]}).encode())
            reply.headers={}
            with patch("core.urllib.request.urlopen",side_effect=[TimeoutError(),reply]) as request:
                b.call("embedding",{"model":"test-transport","input":["transport test"]})
            self.assertEqual(request.call_count,2)
            self.assertEqual([r["status"] for r in b.entries],["error","success"])
            self.assertAlmostEqual(b.charged,b.entries[0]["reserved_usd"]+b.entries[1]["cost_usd"])
            self.assertFalse(b.failed)
            b.close()

    def test_http_520_retries_and_retains_failed_reservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=self.broker(tmp)
            reply=io.BytesIO(json.dumps({"usage":{"prompt_tokens":2},"data":[]}).encode())
            reply.headers={}
            failure=urllib.error.HTTPError("redacted",520,"upstream error",{},None)
            with patch("core.urllib.request.urlopen",side_effect=[failure,reply]) as request:
                b.call("embedding",{"model":"test-transport","input":["transport test"]})
            self.assertEqual(request.call_count,2)
            self.assertEqual(b.entries[0]["http_status"],520)
            self.assertTrue(b.entries[0]["retryable"])
            self.assertEqual([r["attempt"] for r in b.entries],[1,2])
            self.assertAlmostEqual(b.charged,b.entries[0]["reserved_usd"]+b.entries[1]["cost_usd"])
            self.assertFalse(b.failed)
            b.close()

    def test_repeated_http_520_stops_at_limit_and_opens_circuit(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=self.broker(tmp)
            failure=urllib.error.HTTPError("redacted",520,"upstream error",{},None)
            with patch("core.urllib.request.urlopen",side_effect=failure) as request:
                with self.assertRaises(RuntimeError):
                    b.call("embedding",{"model":"test-transport","input":["transport test"]})
                charged=b.charged
                with self.assertRaisesRegex(RuntimeError,"circuit is open"):
                    b.call("embedding",{"model":"test-transport","input":["later request"]})
            self.assertEqual(request.call_count,3)
            self.assertEqual(len(b.entries),3)
            self.assertAlmostEqual(charged,sum(r["reserved_usd"] for r in b.entries))
            self.assertEqual(b.charged,charged)
            b.close()

    def test_exhausted_failure_blocks_later_requests_without_charging(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=self.broker(tmp)
            with patch("core.urllib.request.urlopen",side_effect=TimeoutError()) as request:
                with self.assertRaises(RuntimeError):
                    b.call("embedding",{"model":"test-transport","input":["transport test"]})
                charged=b.charged
                with self.assertRaisesRegex(RuntimeError,"circuit is open"):
                    b.call("embedding",{"model":"test-transport","input":["subsequent call"]})
            self.assertEqual(request.call_count,3)
            self.assertEqual(b.charged,charged)
            b.close()

    def test_budget_checked_again_before_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=self.broker(tmp,.005)
            with patch("core.urllib.request.urlopen",side_effect=TimeoutError()) as request:
                with self.assertRaisesRegex(RuntimeError,"budget"):
                    b.call("embedding",{"model":"test-transport","input":["transport test"]})
            self.assertEqual(request.call_count,1)
            self.assertTrue(b.failed)
            b.close()

    def test_permanent_http_error_is_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=self.broker(tmp)
            with patch("core.urllib.request.urlopen",side_effect=urllib.error.HTTPError("redacted",400,"bad",{},None)) as request:
                with self.assertRaises(RuntimeError):
                    b.call("embedding",{"model":"test-transport","input":["transport test"]})
            self.assertEqual(request.call_count,1)
            self.assertEqual(b.entries[0]["http_status"],400)
            b.close()

    def test_transient_failures_stop_after_three_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=self.broker(tmp)
            with patch("core.urllib.request.urlopen",side_effect=TimeoutError()) as request:
                with self.assertRaises(RuntimeError):
                    b.call("embedding",{"model":"test-transport","input":["transport test"]})
            self.assertEqual(request.call_count,3)
            self.assertEqual(len(b.entries),3)
            self.assertTrue(b.failed)
            b.close()

    @unittest.skipUnless((HERE/".runtime/plumbing-trajectory.json").exists(),"Requires downloaded real trajectory")
    def test_failed_dream_resumes_without_reingestion(self):
        # Fault injection tests checkpoint orchestration, not answer quality.
        trajectory=json.loads((HERE/".runtime/plumbing-trajectory.json").read_text())
        calls=[]
        class StubWorker:
            failures=1
            def __init__(self,profile,*args):
                self.profile=Path(profile);self.profile.mkdir(parents=True,exist_ok=True)
            def call(self,op,**kwargs):
                calls.append(op)
                (self.profile/"state").write_text(op)
                if op=="dream" and self.failures:
                    StubWorker.failures-=1
                    raise RuntimeError("injected dream failure")
                return {"chunks":1}
            def close(self,*args):pass
            def abort(self):pass
        db=SimpleNamespace(execute=lambda *args:SimpleNamespace(fetchone=lambda:(json.dumps(trajectory),)))
        with tempfile.TemporaryDirectory() as tmp,patch("run.Worker",StubWorker):
            root=Path(tmp);cfg={"dream_every":4}
            with self.assertRaisesRegex(RuntimeError,"injected"):
                build_history(root,[trajectory["id"]],db,cfg,SimpleNamespace(),False)
            checkpoint=build_history(root,[trajectory["id"]],db,cfg,SimpleNamespace(),True)
            self.assertEqual(calls.count("ingest"),1)
            self.assertEqual(calls.count("dream"),2)
            self.assertEqual(json.loads((checkpoint/"checkpoint.json").read_text())["count"],1)
            self.assertEqual(len(list(root.glob("*/resolved-failure-*.json"))),1)
if __name__=="__main__":unittest.main()
