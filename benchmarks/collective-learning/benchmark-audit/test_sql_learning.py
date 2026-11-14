import json
import pathlib
import tempfile
import unittest
from sql_learning_fixture import build, python_answer, queries, DOMAINS
from sql_learning_check import check


class SqlLearningChecks(unittest.TestCase):
    def test_units_have_intentionally_opposite_weighting(self):
        data = ([(1, 'same', 10), (2, 'same', 20), (3, 'different', 20)],
                [(1, 1, '2025-01-01', 'accepted'), (2, 1, '2025-01-01', 'accepted'),
                 (3, 2, '2025-01-01', 'accepted'), (4, 3, '2025-01-01', 'accepted')],
                [(1, 'priority'), (1, 'priority'), (2, 'priority'), (3, 'priority'), (4, 'priority')])
        self.assertEqual(python_answer(data, 'entity-mean'), [(16.67,)])
        self.assertEqual(python_answer(data, 'observation-mean'), [(15.0,)])
        self.assertEqual(python_answer(data, 'name-count'), [(2,)])
        self.assertEqual(python_answer(data, 'observation-count'), [(4,)])

    def test_all_references_and_wrong_units_and_constants(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / 'fixtures'
            build(root)
            fixture = json.loads((root / 'fixture.json').read_text())
            self.assertEqual(len(fixture['cases']), 24)
            for case in fixture['cases']:
                request = dict(root=str(root), snapshots=case['snapshots'], referenceSql=case['referenceSql'])
                self.assertEqual(check(dict(request, sql=case['referenceSql']))['status'], 'pass')
                domain = next(d for d in DOMAINS if d[0] == case['family'])
                mutant = queries(domain, case['kind'])[1]['wrong-unit']
                self.assertEqual(check(dict(request, sql=mutant))['status'], 'task-failure')
                constant = 'SELECT ' + str(case['snapshots'][0]['expected'][0][0])
                result = check(dict(request, sql=constant))
                self.assertEqual(result['snapshots'][0]['status'], 'pass')
                self.assertEqual(result['status'], 'task-failure')
                self.assertEqual(check(dict(request, sql='DELETE FROM ' + domain[1]))['status'], 'task-failure')
            case = fixture['cases'][0]
            file = root / case['snapshots'][0]['file']
            file.write_bytes(file.read_bytes() + b'drift')
            with self.assertRaisesRegex(ValueError, 'drift'):
                check(dict(root=str(root), snapshots=case['snapshots'], referenceSql=case['referenceSql'], sql='SELECT 1'))


if __name__ == '__main__':
    unittest.main()
