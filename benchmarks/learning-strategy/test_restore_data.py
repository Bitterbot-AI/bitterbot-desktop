import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("restore_data", Path(__file__).with_name("restore-data.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreTests(unittest.TestCase):
    def fixture(self, base, member="run/evidence.json"):
        data = b'{"failed": true}\n'
        (base / "data").mkdir()
        archive = base / "data/run.zip"
        with zipfile.ZipFile(archive, "w") as z:
            info = zipfile.ZipInfo(member)
            info.external_attr = 0o100644 << 16
            z.writestr(info, data)
        entry = {"file": "run.zip", "bytes": archive.stat().st_size,
                 "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                 "files": [{"path": member, "bytes": len(data),
                            "sha256": hashlib.sha256(data).hexdigest()}]}
        (base / "data/manifest.json").write_text(json.dumps({"archives": [entry]}))
        return data

    def test_roundtrip_and_no_clobber(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            data = self.fixture(base)
            self.assertFalse(module.restore(base, verify_only=True)["restored"])
            self.assertFalse((base / "results").exists())
            self.assertEqual(module.restore(base)["verifiedFiles"], 1)
            target = base / "results/run/evidence.json"
            self.assertEqual(target.read_bytes(), data)
            module.restore(base)
            target.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
                module.restore(base)
            self.assertEqual(target.read_bytes(), b"changed")

    def test_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            self.fixture(base, "run/../../outside")
            with self.assertRaisesRegex(ValueError, "Unsafe archive member"):
                module.restore(base)
            self.assertFalse((base / "results").exists())

    def test_corruption_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            self.fixture(base)
            archive = base / "data/run.zip"
            archive.write_bytes(archive.read_bytes() + b"corrupt")
            with self.assertRaisesRegex(ValueError, "Archive hash mismatch"):
                module.restore(base)
            self.assertFalse((base / "results").exists())


if __name__ == "__main__":
    unittest.main()
