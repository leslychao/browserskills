import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'inference'))
from recipe_lock import recipe_digest


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'inference' / f'{name}.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


evaluation = module('evaluate')
preparation = module('prepare_model')
serving = module('serve')


class InferenceToolsTest(unittest.TestCase):
    def test_aliases_are_opaque_unique_and_exclude_original_ids(self):
        aliases = evaluation.option_aliases([{'id': 'abcdefghij'}, {'id': 'klmnopqrst'}])
        self.assertEqual(2, len(set(aliases)))
        self.assertTrue(all(len(a) == 10 and a.isascii() and a.isalpha() and a.islower() for a in aliases))
        self.assertFalse(set(aliases) & {'abcdefghij', 'klmnopqrst'})

    def test_alias_response_maps_back_to_original_id(self):
        case = {'instruction': 'Select blue.', 'question': 'blue', 'options': [{'id': 'original', 'label': 'blue'}]}
        with mock.patch.object(evaluation, 'query', return_value=({'decision': 'ANSWER', 'optionId': 'abcdefghij'}, .1)):
            answer, _ = evaluation.query_case('http://unused', case, Path('.'), ['abcdefghij'])
        self.assertEqual({'decision': 'ANSWER', 'optionId': 'original'}, answer)
        self.assertEqual('original', case['options'][0]['id'])

    def test_unknown_alias_is_rejected_and_abstain_is_preserved(self):
        case = {'instruction': 'i', 'question': 'q', 'options': [{'id': 'original', 'label': 'x'}]}
        with mock.patch.object(evaluation, 'query', return_value=({'decision': 'ANSWER', 'optionId': 'unknown'}, .1)):
            with self.assertRaises(ValueError):
                evaluation.query_case('http://unused', case, Path('.'), ['abcdefghij'])
        with mock.patch.object(evaluation, 'query', return_value=({'decision': 'ABSTAIN'}, .1)):
            self.assertEqual({'decision': 'ABSTAIN'}, evaluation.query_case('http://unused', case, Path('.'), ['abcdefghij'])[0])

    def test_recipe_identity_ignores_line_endings_but_not_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'recipe.json'
            path.write_bytes(b'{\r\n  "version": 1\r\n}\r\n')
            windows = recipe_digest(path)
            path.write_bytes(b'{"version":1}\n')
            self.assertEqual(windows, recipe_digest(path))
            path.write_bytes(b'{"version":2}\n')
            self.assertNotEqual(windows, recipe_digest(path))

    def test_checksum_of_actual_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file'
            path.write_bytes(b'abc')
            self.assertEqual(preparation.digest(path), hashlib.sha256(b'abc').hexdigest())

    def test_existing_corrupt_download_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file'
            path.write_bytes(b'wrong')
            with self.assertRaises(RuntimeError):
                preparation.fetch('https://invalid.invalid/file', path, 3, hashlib.sha256(b'abc').hexdigest(), 0)
            self.assertEqual(path.read_bytes(), b'wrong')

    def test_verified_existing_download_needs_no_network(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file'
            path.write_bytes(b'abc')
            preparation.fetch('https://invalid.invalid/file', path, 3, hashlib.sha256(b'abc').hexdigest(), 0)

    def test_partial_model_volume_cannot_start(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                serving.verify(Path(directory))

    def test_wrong_model_revision_cannot_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'provenance.json').write_text(json.dumps({'model': {'revision': 'other'}}))
            with self.assertRaises(ValueError):
                serving.verify(root)

    def test_media_path_traversal_rejected(self):
        case = {'instruction': 'i', 'question': 'q', 'options': [{'id': 'a'}], 'media': [{'path': '../outside', 'kind': 'image'}]}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                evaluation.request_body(case, Path(directory))

    def test_media_hash_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'audio.wav').write_bytes(b'RIFF')
            case = {'instruction': 'i', 'question': 'q', 'options': [{'id': 'a'}], 'media': [{'path': 'audio.wav', 'kind': 'audio', 'sha256': 'wrong'}]}
            with self.assertRaises(ValueError):
                evaluation.request_body(case, root)

    def test_accuracy_counts_unsolved_and_errors(self):
        rows = [{'category': category, 'correct': i < 22, 'seconds': 1} for category in evaluation.CATEGORIES for i in range(25)]
        result = evaluation.summarize(rows)
        self.assertEqual(result['speech']['accuracy'], .88)
        self.assertFalse(result['speech']['passed'])

    def test_latency_gate_is_category_specific(self):
        rows = [{'category': category, 'correct': True, 'seconds': 40} for category in evaluation.CATEGORIES for _ in range(25)]
        result = evaluation.summarize(rows)
        self.assertFalse(result['text']['passed'])
        self.assertTrue(result['speech']['passed'])

    def test_corpus_requires_all_four_categories(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'corpus.json'
            path.write_text(json.dumps({'provenance': 'test', 'labelMethod': 'test', 'cases': []}))
            with self.assertRaises(ValueError):
                evaluation.load_cases(path)


if __name__ == '__main__':
    unittest.main()
