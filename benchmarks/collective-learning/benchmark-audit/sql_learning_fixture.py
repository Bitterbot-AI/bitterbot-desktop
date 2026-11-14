"""Prospective, authored development panel. Private variants/answers never enter a solver.

Six vocabulary domains share one relational mechanism; they are NOT six independent
training replicas or six unrelated task families. Python computes every expected
answer independently of the reference SQL, including duplicate-valued entities.
"""
import argparse
from contextlib import closing
import decimal
import hashlib
import json
import pathlib
import random
import sqlite3
from bird_sql import execute, rows_hash, compare_rows

DOMAINS = [
    ("hospital", "patients", "visits", "visit_tags", "patient", "visit", "mass"),
    ("library", "titles", "loans", "loan_tags", "title", "loan", "pages"),
    ("factory", "machines", "inspections", "inspection_tags", "machine", "inspection", "capacity"),
    ("ecology", "animals", "sightings", "sighting_tags", "animal", "sighting", "length"),
    ("logistics", "vehicles", "journeys", "journey_tags", "vehicle", "journey", "range"),
    ("education", "students", "submissions", "submission_tags", "student", "submission", "credits"),
]
KINDS = ("entity-mean", "observation-mean", "name-count", "observation-count")


def rounded_mean(values):
    return float((sum(map(decimal.Decimal, values)) / len(values)).quantize(
        decimal.Decimal("0.01"), rounding=decimal.ROUND_HALF_UP))


def records(seed):
    rng = random.Random(seed)
    # Repeated names and repeated numeric attributes are deliberately different identities.
    entities = [(i, "N" + str((i - 1) // 2), 10 + 5 * (i % 4)) for i in range(1, 10)]
    entities += [(10, "below", 9), (11, "missing", None), (12, "unused", 80)]
    events, tags = [], []
    for i, _name, _value in entities[:-1]:
        for j in range(1 + rng.randrange(6)):
            eid = len(events) + 1
            events.append((eid, i, "2025-06-12", "accepted"))
            tags.extend([(eid, "priority")] * (1 + rng.randrange(3)))
            tags.append((eid, "other"))
        for date, status, tag in [
            ("2024-12-31", "accepted", "priority"),
            ("2026-01-01", "accepted", "priority"),
            ("2025-01-01", "cancelled", "priority"),
            ("2025-12-31", "accepted", "nonpriority"),
        ]:
            eid = len(events) + 1
            events.append((eid, i, date, status))
            tags.append((eid, tag))
    # Filter omissions must change entity populations, not just event weights.
    for obj, name, value, day, status, tag in [
        (13, "late-only", 91, "2026-01-01", "accepted", "priority"),
        (14, "cancelled-only", 86, "2025-03-01", "cancelled", "priority"),
        (15, "substring-only", 93, "2025-03-01", "accepted", "nonpriority"),
        (16, "early-only", 104, "2024-12-31", "accepted", "priority"),
    ]:
        entities.append((obj, name, value))
        eid = len(events) + 1
        events.append((eid, obj, day, status))
        tags.append((eid, tag))
    # Data changes vary entities, values, event multiplicity, names and qualified eligibility.
    if seed:
        entities = [(i, name + ("x" if i % (seed % 3 + 2) == 0 else ""),
                     None if value is None else value + rng.randrange(5))
                    for i, name, value in entities]
        events = [(eid, obj, date, "cancelled" if eid % (seed % 5 + 7) == 0 else status)
                  for eid, obj, date, status in events]
    return entities, events, tags


def python_answer(data, kind):
    entities, events, tags = data
    by_id = {r[0]: r for r in entities}
    priority = {event for event, tag in tags if tag == "priority"}
    eligible = [by_id[obj] for eid, obj, date, status in events
                if status == "accepted" and "2025-01-01" <= date < "2026-01-01"
                and eid in priority and obj in by_id
                and by_id[obj][2] is not None and by_id[obj][2] >= 10]
    unique = {r[0]: r for r in eligible}
    if kind == "entity-mean":
        result = rounded_mean([r[2] for r in unique.values()])
    elif kind == "observation-mean":
        result = rounded_mean([r[2] for r in eligible])
    elif kind == "name-count":
        result = len({r[1] for r in unique.values()})
    elif kind == "observation-count":
        result = len(eligible)
    else:
        raise ValueError(kind)
    return [(result,)]


def queries(domain, kind):
    _, entities, events, tags, *_ = domain
    base = f"FROM {events} o JOIN {entities} e ON e.id=o.entity_id"
    where = (f"WHERE e.value>=10 AND o.status='accepted' "
             "AND o.day>='2025-01-01' AND o.day<'2026-01-01' "
             f"AND EXISTS(SELECT 1 FROM {tags} t WHERE t.event_id=o.id AND t.tag='priority')")
    rows = f"SELECT e.id,e.name,e.value,o.id AS event_id {base} {where}"
    if kind == "entity-mean":
        ref = f"SELECT ROUND(AVG(value),2) FROM (SELECT DISTINCT id,value FROM ({rows}))"
        mutant = f"SELECT ROUND(AVG(e.value),2) {base} {where}"
    elif kind == "observation-mean":
        ref = f"SELECT ROUND(AVG(e.value),2) {base} {where}"
        mutant = f"SELECT ROUND(AVG(value),2) FROM (SELECT DISTINCT id,value FROM ({rows}))"
    elif kind == "name-count":
        ref = f"SELECT COUNT(DISTINCT e.name) {base} {where}"
        mutant = f"SELECT COUNT(DISTINCT e.id) {base} {where}"
    else:
        ref = f"SELECT COUNT(*) {base} {where}"
        mutant = f"SELECT COUNT(DISTINCT e.id) {base} {where}"
    mutants = {
        "wrong-unit": mutant,
        "missing-date": ref.replace("AND o.day>='2025-01-01' AND o.day<'2026-01-01' ", ""),
        "substring-tag": ref.replace("t.tag='priority'", "t.tag LIKE '%priority%'"),
        "missing-status": ref.replace("AND o.status='accepted' ", ""),
    }
    mutants.update({
        "wrong-arithmetic": f"SELECT ({ref}) + 1",
        "extra-column": f"SELECT ({ref}), 1",
        "empty-result": f"SELECT ({ref}) WHERE 0",
    })
    if kind.endswith("mean"):
        mutants["distinct-value"] = ref.replace("AVG(e.value)", "AVG(DISTINCT e.value)").replace(
            "AVG(value)", "AVG(DISTINCT value)")
    return ref, mutants


def question(domain, kind):
    name, entities, events, tags, singular, event, metric = domain
    common = (f"In the {name} dataset, a qualifying {event} has status exactly 'accepted', "
              "day from 2025-01-01 inclusive to 2026-01-01 exclusive, at least one tag "
              f"exactly 'priority', and a linked {singular} with nonmissing value at least 10. "
              f"The value column is the {singular}'s {metric}. "
              f"{entities}.id identifies a {singular}; {events}.id identifies a {event}. "
              f"The {tags} table can repeat identical tag rows; tags describe eligibility. ")
    task = {
        "entity-mean": f"What is the mean {metric} of {entities} with qualifying {events}? The statistical population is {entities} identified by id, with equal weight for each. Return one numeric column rounded to two decimal places.",
        "observation-mean": f"What is the mean {metric} recorded across qualifying {events}? The statistical population is {events} identified by id, with equal weight for each, even when the same {singular} occurs in several. Return one numeric column rounded to two decimal places.",
        "name-count": f"How many distinct names occur among {entities} with a qualifying {event}? Different ids with exactly the same name represent one name for this question. Return one integer column.",
        "observation-count": f"How many qualifying {events} are there? The counted unit is a {event} identified by id, including separate {events} involving the same {singular}. Return one integer column.",
    }[kind]
    return common + task


def build(root):
    # Public fixture bytes are mounted into a non-root, read-only checker. The
    # enclosing study directory remains private (0700) on the host.
    root.mkdir(mode=0o755, parents=False, exist_ok=False)
    cases, qualification = [], []
    for d, domain in enumerate(DOMAINS):
        name, entities, events, tags, *_ = domain
        schema = [
            f"CREATE TABLE {entities}(id INTEGER PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
            f"CREATE TABLE {events}(id INTEGER PRIMARY KEY, entity_id INTEGER, day TEXT, status TEXT)",
            f"CREATE TABLE {tags}(event_id INTEGER, tag TEXT)",
        ]
        snapshots = []
        for variant in range(9):
            data = records(0 if variant == 0 else 1000 * (d + 1) + variant)
            file = root / f"{name}-{variant}.sqlite"
            with closing(sqlite3.connect(file)) as conn, conn:
                for sql in schema:
                    conn.execute(sql)
                for table, values, marks in [(entities, data[0], "?,?,?"), (events, data[1], "?,?,?,?"), (tags, data[2], "?,?")]:
                    conn.executemany(f"INSERT INTO {table} VALUES({marks})", values)
            snapshots.append((file, data))
        for kind in KINDS:
            ref, mutants = queries(domain, kind)
            private = []
            for file, data in snapshots:
                expected = python_answer(data, kind)
                actual = execute(file, ref)
                if not compare_rows(expected, actual)["bagMatch"]:
                    raise ValueError(f"Independent oracle disagreement: {name}/{kind}/{file.name}")
                private.append({"file": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                                "bytes": file.stat().st_size, "expected": expected,
                                "digest": rows_hash(expected)})
            mutants["constant-visible-answer"] = "SELECT " + str(private[0]["expected"][0][0])
            checks = {key: [not compare_rows(p["expected"], execute(file, sql))["bagMatch"]
                            for p, (file, _) in zip(private, snapshots)]
                      for key, sql in mutants.items()}
            if any(not any(rejected) for rejected in checks.values()):
                raise ValueError(f"Missing distinguishing snapshot: {name}/{kind}/{checks}")
            case_id = f"{name}-{kind}"
            cases.append({"id": case_id, "family": name, "kind": kind,
                          "input": {"question": question(domain, kind), "schema": schema,
                                    "dialect": "SQLite", "databaseFile": "database.sqlite"},
                          "referenceSql": ref, "snapshots": private})
            qualification.append({"id": case_id, "independentReferences": len(private),
                                  "mutationRejections": checks})
    fixture = {"schemaVersion": 1, "purpose": "Authored SQL unit-of-analysis development diagnostic",
               "independentMechanisms": 1, "vocabularyDomains": 6, "cases": cases}
    (root / "fixture.json").write_text(json.dumps(fixture, indent=2) + "\n")
    (root / "qualification.json").write_text(json.dumps({"cases": qualification, "paidCalls": 0}, indent=2) + "\n")
    return fixture


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=pathlib.Path)
    args = parser.parse_args()
    result = build(args.destination)
    print(json.dumps({"cases": len(result["cases"]), "snapshotsPerCase": 9, "paidCalls": 0}))
