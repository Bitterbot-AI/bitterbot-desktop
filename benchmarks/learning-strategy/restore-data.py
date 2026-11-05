"""Verify and restore synthetic study archives. No network or provider calls.

Run from any directory: python restore-data.py [--verify-only] [RUN ...]
Omit RUN to restore all recorded runs. Existing identical files are left intact;
different files and paths outside results are rejected rather than overwritten.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def restore(base, names=(), verify_only=False):
    manifest = json.loads((base / "data/manifest.json").read_text(encoding="utf8"))
    archives = {a["file"].removesuffix(".zip"): a for a in manifest["archives"]}
    unknown = set(names) - archives.keys()
    if unknown:
        raise ValueError(f"Unknown runs: {sorted(unknown)}")
    count = 0
    for name in names or archives:
        entry = archives[name]
        archive = base / "data" / entry["file"]
        raw = archive.read_bytes()
        if len(raw) != entry["bytes"] or digest(raw) != entry["sha256"]:
            raise ValueError(f"Archive hash mismatch: {name}")
        with zipfile.ZipFile(archive) as z:
            rows = {f["path"]: f for f in entry["files"]}
            if len(rows) != len(entry["files"]) or sorted(z.namelist()) != sorted(rows):
                raise ValueError(f"Archive inventory mismatch: {name}")
            # Validate the complete archive before writing any of its files.
            for member in z.infolist():
                parts = PurePosixPath(member.filename)
                if (parts.is_absolute() or ".." in parts.parts or "\\" in member.filename
                        or ":" in member.filename or parts.parts[0] != name
                        or (member.external_attr >> 16) & 0o170000 != 0o100000):
                    raise ValueError(f"Unsafe archive member: {member.filename}")
                data = z.read(member)
                row = rows[member.filename]
                if len(data) != row["bytes"] or digest(data) != row["sha256"]:
                    raise ValueError(f"File hash mismatch: {member.filename}")
                target = (base / "results" / member.filename).resolve()
                if not target.is_relative_to((base / "results").resolve()):
                    raise ValueError("Restore target escapes results")
                if target.exists() and digest(target.read_bytes()) != row["sha256"]:
                    raise ValueError(f"Refusing to overwrite changed result: {target}")
            if not verify_only:
                for member in z.infolist():
                    target = base / "results" / member.filename
                    if not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open("xb") as f:
                            f.write(z.read(member))
            count += len(rows)
    return {"archives": len(names or archives), "verifiedFiles": count,
            "restored": not verify_only}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("runs", nargs="*")
    args = parser.parse_args()
    print(json.dumps(restore(Path(__file__).resolve().parent, args.runs, args.verify_only)))
