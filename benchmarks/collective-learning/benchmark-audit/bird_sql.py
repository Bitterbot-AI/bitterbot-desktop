"""Host-only bounded SQL checker. Never place this file or gold SQL in the solver.

Primary calibration metric: exact result bags (column positions preserved, row
order ignored). BIRD's set execution score is retained separately. Neither is
a proof of semantic equivalence on other database contents.
"""
import collections
import hashlib
import json
import pathlib
import sqlite3
import sys
import time

MAX_ROWS = 100_000
MAX_BYTES = 2_000_000
MAX_STEPS = 3_000_000_000
TIMEOUT_SECONDS = 30


class QueryRejected(Exception):
    pass


def rows_hash(rows):
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
                         default=lambda x: {"blobHex": x.hex()}).encode()
    return hashlib.sha256(encoded).hexdigest()


def execute(database, sql):
    if not isinstance(sql, str) or not sql.strip() or len(sql.encode()) > 65536:
        raise QueryRejected("invalid-query")
    database = pathlib.Path(database).resolve(strict=True)
    conn = sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=1)
    try:
        # Some macOS Python builds omit the extension-loading API entirely.
        # Loading is disabled by default; the SQL authorizer below also denies it.
        disable_extensions = getattr(conn, "enable_load_extension", None)
        if disable_extensions is not None:
            disable_extensions(False)
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA trusted_schema=OFF")
        conn.execute("PRAGMA cache_size=-8192")
        conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_BYTES)
        conn.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 65536)
        conn.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 256)
        conn.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
        conn.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_RECURSIVE}
        denied_functions = {"load_extension", "writefile", "readfile", "random", "randomblob"}

        def authorize(action, arg1, arg2, _database, _trigger):
            if action == sqlite3.SQLITE_FUNCTION:
                return sqlite3.SQLITE_DENY if (arg2 or "").lower() in denied_functions else sqlite3.SQLITE_OK
            return sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY

        started = time.monotonic()
        steps = 0

        def progress():
            nonlocal steps
            steps += 1000
            return int(steps > MAX_STEPS or time.monotonic() - started > TIMEOUT_SECONDS)

        conn.set_authorizer(authorize)
        conn.set_progress_handler(progress, 1000)
        cursor = conn.execute(sql)  # execute, never executescript: one statement only.
        rows = []
        size = 0
        for row in cursor:
            rows.append(row)
            size += len(repr(row).encode())
            if len(rows) > MAX_ROWS or size > MAX_BYTES:
                raise QueryRejected("output-limit")
        return rows
    finally:
        conn.close()


def compare_rows(expected, actual):
    return {
        "bagMatch": collections.Counter(expected) == collections.Counter(actual),
        "setMatch": set(expected) == set(actual),
        "orderedMatch": expected == actual,
        "expectedRows": len(expected), "actualRows": len(actual),
    }


def grade(database, reference, predicted, expected_digest=None):
    try:
        expected = execute(database, reference)
    except Exception as e:
        return {"status": "checker-invalid", "reason": "reference-execution", "detail": str(e)[:500]}
    reference_digest = rows_hash(expected)
    if not expected or (expected_digest and reference_digest != expected_digest):
        return {"status": "checker-invalid", "reason": "reference-empty-or-drift"}
    try:
        actual = execute(database, predicted)
    except (sqlite3.Error, QueryRejected) as e:
        return {"status": "task-failure", "reason": "candidate-query", "detail": str(e)[:500],
                "bagMatch": False, "setMatch": False, "orderedMatch": False}
    comparison = compare_rows(expected, actual)
    return {"status": "pass" if comparison["bagMatch"] else "task-failure",
            **comparison, "referenceDigest": reference_digest, "actualDigest": rows_hash(actual)}


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(140_001)
    if len(raw) > 140_000:
        raise ValueError("Checker request too large")
    request = json.loads(raw)
    print(json.dumps(grade(request["database"], request["reference"], request["predicted"],
                           request.get("referenceDigest"))))
