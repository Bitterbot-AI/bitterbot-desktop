"""Freeze a deterministic development panel before observing any solver outcome.

Two challenging questions per database, SHA256-ranked with a fixed seed.
This is a headroom calibration, not a held-out collective-learning experiment.
No model-specific selection, replacement of failed tasks, or skill training.
"""
import argparse
import hashlib
import json
import pathlib
import sqlite3

from bird_sql import execute, grade, rows_hash

SEED = "bitterbot-bird-development-calibration-v1"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare(source, destination):
    provenance = json.loads((source / "provenance.json").read_text())
    annotations = (source / "annotations.jsonl").read_bytes()
    if sha(annotations) != "926af2a0d1b47e5d0d15a7aa8a34d4721007f4550a881555b6a89496b54a2606":
        raise ValueError("Annotation drift")
    data = [json.loads(line) for line in annotations.splitlines()]
    schemas = json.loads((source / "schemas.json").read_text())
    selected = []
    for db in sorted({row["db_id"] for row in data}):
        pool = [r for r in data if r["db_id"] == db and r["difficulty"] == "challenging"]
        pool.sort(key=lambda r: sha(f"{SEED}:{r['question_id']}".encode()))
        if len(pool) < 2:
            raise ValueError("Insufficient challenging tasks: " + db)
        selected.extend(pool[:2])
    destination.mkdir(mode=0o700)
    (destination / "selection.json").write_text(json.dumps({"seed": SEED,
        "rule": "Two challenging questions per database, smallest SHA256(seed:question_id)",
        "questionIds": [r["question_id"] for r in selected], "paidCallsBeforeSelection": 0}, indent=2) + "\n")
    cases = []
    probes = []
    for row in selected:
        db = row["db_id"]
        file = source / (db + ".sqlite")
        receipt = next(p for p in provenance["files"] if p["file"] == file.name)
        if sha(file.read_bytes()) != receipt["sha256"]:
            raise ValueError("Database drift: " + db)
        with sqlite3.connect(file.as_uri() + "?mode=ro&immutable=1", uri=True) as conn:
            schema = [x[0] for x in conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        expected = execute(file, row["SQL"])
        reference_digest = rows_hash(expected)
        controls = {
            "reference": grade(file, row["SQL"], row["SQL"], reference_digest),
            "empty": grade(file, row["SQL"], "SELECT 1 WHERE 0", reference_digest),
            "wrong_scalar": grade(file, row["SQL"], "SELECT 'deliberately incorrect benchmark control'", reference_digest),
            "write": grade(file, row["SQL"], "CREATE TABLE unauthorized(x)", reference_digest),
        }
        if controls["reference"]["status"] != "pass" or any(controls[k]["status"] != "task-failure" for k in ["empty", "wrong_scalar", "write"]):
            raise ValueError("Checker qualification failed: " + str(row["question_id"]))
        cases.append({"id": f"bird-{row['question_id']}", "family": db,
                      "difficulty": row["difficulty"], "input": {
                          "question": row["question"], "evidence": row["evidence"],
                          "databaseFile": "database.sqlite", "dialect": "SQLite",
                          "schema": schema, "schemaDocumentation": schemas[db]},
                      "databaseSha256": receipt["sha256"], "databaseBytes": receipt["bytes"],
                      "referenceSql": row["SQL"], "referenceDigest": reference_digest})
        probes.append({"id": cases[-1]["id"], "referenceRows": len(expected), "controls": controls})
        print(json.dumps({"id": cases[-1]["id"], "database": db, "rows": len(expected)}), flush=True)
    fixture = {"schemaVersion": 1, "upstreamRevision": "5b256b5a9c17478f06ed6912612e9a14d17065c8",
               "annotationSha256": sha(annotations), "selectionSeed": SEED, "cases": cases}
    (destination / "fixture.json").write_text(json.dumps(fixture, indent=2) + "\n")
    (destination / "qualification.json").write_text(json.dumps({"paidModelCalls": 0,
        "selectedTasks": len(cases), "domains": len({c["family"] for c in cases}), "probes": probes,
        "limitations": ["Reference self-agreement is an execution check, not independent proof of the annotation.",
                         "Only one database snapshot per domain; accidental SQL equivalence remains possible.",
                         "Result bags preserve duplicates and column positions but ignore row ordering.",
                         "Public benchmark contamination cannot be excluded."]}, indent=2) + "\n")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("source", type=pathlib.Path)
    p.add_argument("destination", type=pathlib.Path)
    args = p.parse_args()
    prepare(args.source.resolve(), args.destination.resolve())
