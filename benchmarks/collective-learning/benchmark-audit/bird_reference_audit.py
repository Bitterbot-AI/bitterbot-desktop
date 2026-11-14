"""Independent, unpaid probes of suspected BIRD annotation edge cases."""
import json
import pathlib
import sqlite3
import sys

root = pathlib.Path(sys.argv[1])
rows = {r["question_id"]: r for r in map(json.loads, (root / "annotations.jsonl").read_text().splitlines())}
findings = []
for question_id in [254, 487]:
    item = rows[question_id]
    with sqlite3.connect((root / (item["db_id"] + ".sqlite")).as_uri() + "?mode=ro&immutable=1", uri=True) as conn:
        original = conn.execute(item["SQL"]).fetchall()
        if question_id == 254:
            alternative = item["SQL"].replace("CAST(substr(q.q1, instr(q.q1, ':') + 1) AS INTEGER)", "CAST(substr(q.q1, instr(q.q1, ':') + 1) AS REAL)")
            concern = "Reference truncates fractional seconds; compare exact fractional-second ranking on this snapshot."
            supporting = conn.execute("SELECT q.q1,d.nationality FROM qualifying q JOIN drivers d ON d.driverId=q.driverId JOIN races r ON r.raceId=q.raceId WHERE r.year=1995 AND r.name='Japanese Grand Prix' ORDER BY q.q1 DESC LIMIT 5").fetchall()
        else:
            alternative = item["SQL"].replace("b.bond_type <> '-'", "b.bond_type IN ('=', '#')")
            concern = "Question excludes double/triple nitrogen bonds; reference excludes all non-single nitrogen bonds, including aromatic bonds if present."
            supporting = conn.execute("SELECT bond_type,COUNT(*) FROM bond GROUP BY bond_type").fetchall()
        changed = conn.execute(alternative).fetchall()
        findings.append({"id": question_id, "concern": concern, "reference": original,
                         "alternative": changed, "sameOnThisSnapshot": original == changed,
                         "supportingRows": supporting, "alternativeSql": alternative})
result = json.dumps({"paidCalls": 0, "findings": findings}, indent=2) + "\n"
if len(sys.argv) > 2:
    with pathlib.Path(sys.argv[2]).open("x") as f:
        f.write(result)
print(result)
