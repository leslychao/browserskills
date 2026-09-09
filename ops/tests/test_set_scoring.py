import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('score_sets', Path(__file__).parents[1] / 'inference' / 'score_sets.py')
scoring = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scoring)


def corpus():
    return {'provenance': 'unit test, not measured model quality', 'labelMethod': 'fixed independent answers',
            'cases': [{'id': str(i), 'category': 'TEXT', 'expected': [
                {'partId': '1', 'fieldId': 'a', 'value': 'yes'},
                {'partId': '2', 'fieldId': 'b', 'value': ['left', 'right']},
            ]} for i in range(25)]}


class SetScoringTest(unittest.TestCase):
    def test_whole_set_not_individual_field_accuracy(self):
        source = corpus()
        rows = [{'id': c['id'], 'decision': 'ANSWER', 'answers': c['expected'], 'seconds': 1} for c in source['cases']]
        rows[0] = dict(rows[0], answers=rows[0]['answers'][:1])
        rows[1] = dict(rows[1], decision='ABSTAIN', answers=[])
        summary = scoring.score(source, rows)
        self.assertEqual(23, summary['categories'][0]['correct'])
        self.assertTrue(summary['categories'][0]['passed'])
        self.assertEqual(25, summary['categories'][0]['total'])

    def test_missing_results_count_as_unsolved_and_cannot_shrink_denominator(self):
        self.assertEqual(0, scoring.score(corpus(), [])['categories'][0]['correct'])
        self.assertFalse(scoring.score(corpus(), [])['passed'])

    def test_rejects_duplicate_case_and_answer_ids(self):
        with self.assertRaises(ValueError):
            scoring.score(corpus(), [{'id': '1'}, {'id': '1'}])
        with self.assertRaises(ValueError):
            scoring.canonical_answers([{'partId': '1', 'fieldId': 'a', 'value': 'yes'}] * 2)

    def test_choice_sets_are_unordered_but_side_ids_and_types_are_preserved(self):
        source = corpus()
        expected = source['cases'][0]['expected']
        reverse = [expected[0], dict(expected[1], value=['right', 'left'])]
        self.assertEqual(scoring.canonical_answers(expected), scoring.canonical_answers(reverse))
        with self.assertRaises(ValueError):
            scoring.canonical_answers([{'partId': '1', 'fieldId': 'a', 'value': True}])

    def test_insufficient_category_cannot_be_admitted(self):
        source = corpus()
        source['cases'] = source['cases'][:24]
        rows = [{'id': c['id'], 'decision': 'ANSWER', 'answers': c['expected'], 'seconds': 1} for c in source['cases']]
        self.assertFalse(scoring.score(source, rows)['passed'])


if __name__ == '__main__':
    unittest.main()
