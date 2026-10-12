import ctypes
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from core import atomic, Broker, digest, safe_trajectory
from run import restore, snapshot_hashes, validate_config, build_history

class HarnessTests(unittest.TestCase):
    def test_openrouter_preserves_sampling_and_disables_fallback(self):
        from protocol import openrouter_body
        source={"model":"qwen/qwen3.5-9b","temperature":.6,"top_p":.95,"top_k":20,
                "max_tokens":20000,"chat_template_kwargs":{"enable_thinking":True}}
        result=openrouter_body(source,{"provider":"deepinfra/bf16","quantization":"bf16"})
        self.assertEqual(result["top_k"],20)
        self.assertEqual(result["max_tokens"],20000)
        self.assertEqual(result["reasoning"],{"enabled":True})
        self.assertEqual(result["provider"]["only"],["deepinfra/bf16"])
        self.assertFalse(result["provider"]["allow_fallbacks"])
        self.assertTrue(result["provider"]["require_parameters"])
        self.assertIn("chat_template_kwargs",source)
        self.assertTrue(openrouter_body({},{"provider":"deepinfra/bf16","quantization":"bf16"})["reasoning"]["enabled"])
        with self.assertRaisesRegex(RuntimeError,"thinking"):
            openrouter_body({"chat_template_kwargs":{"enable_thinking":False}},{})

    def test_capacity_stop_preserves_dream_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError,"dream boundary"):
                build_history(Path(tmp),list("abcdefgh"),None,{"dream_every":4},None,False,stop_count=3)

    def test_budget_rejects_before_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg={"budget_usd":0,"models":{"embedding":{"model":"blocked","input_per_million":1,"output_per_million":0}}}
            broker=Broker(tmp,cfg,{})
            self.addCleanup(broker.close)
            with self.assertRaisesRegex(RuntimeError,"budget"):
                broker.call("embedding",{"model":"blocked","input":["budget safety probe"]})
            self.assertEqual(broker.entries,[])
    def test_unresolved_charge_survives_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            atomic(Path(tmp)/"api-ledger.json",[{"reserved_usd":1,"status":"inflight"}])
            cfg={"budget_usd":1,"models":{"embedding":{"model":"blocked","input_per_million":1,"output_per_million":0}}}
            broker=Broker(tmp,cfg,{})
            self.addCleanup(broker.close)
            with self.assertRaisesRegex(RuntimeError,"budget"):
                broker.call("embedding",{"model":"blocked","input":["budget safety probe"]})
    def test_checkpoint_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);profile=root/"checkpoint/profile";profile.mkdir(parents=True)
            (profile/"state").write_text("before")
            atomic(root/"checkpoint/checkpoint.json",{"sha256":snapshot_hashes(profile)})
            (profile/"state").write_text("after")
            with self.assertRaisesRegex(RuntimeError,"integrity"):
                restore(root/"checkpoint",root/"restored")
    def test_label_schema_denied(self):
        with self.assertRaisesRegex(RuntimeError,"schema"):
            safe_trajectory({"answer":"never forward evaluator records"})
    def test_order_affects_history_identity(self):
        self.assertNotEqual(digest(["first","second"]),digest(["second","first"]))
    def test_full_run_requires_explicit_authorization(self):
        with self.assertRaisesRegex(RuntimeError,"not authorized"):
            validate_config({"full_run_authorized":False})
    @unittest.skipUnless(sys.platform=="linux","Linux containment contract")
    def test_landlock_and_network_deny(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);allow=root/"allow";allow.mkdir()
            private=root/"evaluator-private";private.write_text("canary")
            script = """
import sys
from pathlib import Path
import socket
from sandbox import restrict
allow,private=sys.argv[1:]
restrict(['/usr','/lib','/lib64','/etc/ld.so.cache'],[allow,'/dev/null'])
try: Path(private).read_text()
except PermissionError: pass
else: raise AssertionError('Evaluator file readable')
try: socket.socket()
except PermissionError: pass
else: raise AssertionError('Network socket available')
(Path(allow)/'state').write_text('ok')
"""
            env={**os.environ,"PYTHONPATH":str(Path(__file__).parent)}
            result=subprocess.run([sys.executable,"-c",script,str(allow),str(private)],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((allow/"state").read_text(),"ok")
if __name__=="__main__":unittest.main()
