"""Host-owned multi-snapshot checker. Mounted only in the checker container."""
import hashlib
import json
import pathlib
import sys
from bird_sql import grade


def check(request):
    root = pathlib.Path(request["root"]).resolve(strict=True)
    results = []
    for item in request["snapshots"]:
        name = item["file"]
        if pathlib.Path(name).name != name or not name.endswith(".sqlite"):
            raise ValueError("Invalid snapshot name")
        file = root / name
        if file.is_symlink() or not file.is_file():
            raise ValueError("Invalid snapshot file")
        digest = hashlib.sha256()
        with file.open('rb') as handle:
            for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != item["sha256"]:
            raise ValueError("Snapshot drift")
        results.append(grade(file, request["referenceSql"], request["sql"], item["digest"]))
    status = ("checker-invalid" if any(r["status"] == "checker-invalid" for r in results)
              else "pass" if all(r["status"] == "pass" for r in results) else "task-failure")
    return {"status": status, "snapshots": results}


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(200001)
    if len(raw) > 200000:
        raise ValueError("Request too large")
    print(json.dumps(check(json.loads(raw))))
