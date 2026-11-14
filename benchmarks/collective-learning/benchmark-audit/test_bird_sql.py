import pathlib
from contextlib import closing
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from bird_sql import execute, grade, rows_hash


class SqlCheckerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = pathlib.Path(self.tmp.name) / "data.sqlite"
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.executescript("CREATE TABLE t(id INTEGER, x REAL); INSERT INTO t VALUES (1,10),(2,10),(3,NULL),(4,20);")
        self.reference = "SELECT x FROM t WHERE x IS NOT NULL"
        self.before = self.db.read_bytes()

    def tearDown(self):
        self.assertEqual(self.db.read_bytes(), self.before)
        self.tmp.cleanup()

    def test_equivalent_reordered_and_aliased_queries(self):
        result = grade(self.db, self.reference, "SELECT x AS value FROM t WHERE x>=0 ORDER BY x DESC")
        self.assertEqual(result["status"], "pass")
        self.assertFalse(result["orderedMatch"])

    def test_duplicates_are_not_discarded(self):
        result = grade(self.db, self.reference, "SELECT DISTINCT x FROM t WHERE x IS NOT NULL")
        self.assertEqual(result["status"], "task-failure")
        self.assertTrue(result["setMatch"])

    def test_empty_and_wrong_answers_fail(self):
        for query in ["SELECT 1 WHERE 0", "SELECT 10", "SELECT 30", "SELECT NULL", ""]:
            with self.subTest(query=query):
                self.assertEqual(grade(self.db, self.reference, query)["status"], "task-failure")

    def test_column_order_and_nulls(self):
        ref = "SELECT id,x FROM t"
        self.assertEqual(grade(self.db, ref, "SELECT x,id FROM t")["status"], "task-failure")
        self.assertEqual(grade(self.db, ref, "SELECT id,coalesce(x,0) FROM t")["status"], "task-failure")
        self.assertEqual(grade(self.db, ref, ref)["status"], "pass")

    def test_unsafe_queries_fail_without_changes(self):
        for query in ["DELETE FROM t", "UPDATE t SET x=1", "DROP TABLE t", "CREATE TABLE evil(x)",
                      "ATTACH DATABASE ':memory:' AS other", "PRAGMA writable_schema=ON",
                      "SELECT load_extension('/tmp/evil')", "SELECT randomblob(1000000000)",
                      "SELECT 10; DELETE FROM t", "VACUUM INTO '/tmp/evil.sqlite'"]:
            with self.subTest(query=query):
                self.assertEqual(grade(self.db, self.reference, query)["status"], "task-failure")

    def test_reference_error_is_not_candidate_failure(self):
        self.assertEqual(grade(self.db, "SELECT nonexistent FROM t", self.reference)["status"], "checker-invalid")
        self.assertEqual(grade(self.db, "SELECT 1 WHERE 0", "SELECT 1 WHERE 0")["status"], "checker-invalid")
        self.assertEqual(grade(self.db, self.reference, self.reference, "0"*64)["status"], "checker-invalid")

    def test_nontermination_is_bounded(self):
        query = "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT SUM(x) FROM r"
        with patch("bird_sql.MAX_STEPS", 1000):
            self.assertEqual(grade(self.db, self.reference, query)["status"], "task-failure")

    def test_hash_pin_and_numeric_equivalence(self):
        pin = rows_hash(execute(self.db, self.reference))
        self.assertEqual(grade(self.db, self.reference, self.reference, pin)["status"], "pass")
        self.assertEqual(grade(self.db, "SELECT 1", "SELECT 1.0")["status"], "pass")


if __name__ == "__main__":
    unittest.main()
