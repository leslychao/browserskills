import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import sys
import copy
import wave
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
generator = module('generate_diagnostic_corpus')


def field(identifier='choice', kind='SINGLE_CHOICE', **changes):
    value = {'id': identifier, 'label': 'Choose blue.', 'kind': kind, 'required': True,
             'options': [{'id': 'blue-id', 'label': 'blue'}, {'id': 'red-id', 'label': 'red'}] if kind.endswith('CHOICE') else [],
             'value': None, 'stage': 0, 'maxLength': None, 'min': None, 'max': None}
    return dict(value, **changes)


def case():
    return {'id': 'text-1', 'category': 'text', 'instruction': 'Select blue in each part.',
            'parts': [{'id': 'left', 'title': 'First', 'text': 'blue', 'media': [], 'fields': [field()], 'unmappedControls': []},
                      {'id': 'right', 'title': 'Second', 'text': 'blue', 'media': [], 'fields': [field()], 'unmappedControls': []}],
            'expected': [{'partId': 'left', 'fieldId': 'choice', 'value': 'blue-id'},
                         {'partId': 'right', 'fieldId': 'choice', 'value': 'blue-id'}]}


def answer(value=None):
    return {'decision': 'ANSWER', 'answers': case()['expected'] if value is None else value, 'reason': None}


class InferenceToolsTest(unittest.TestCase):
    def test_whole_set_request_scopes_fields_and_does_not_include_gold(self):
        value = case()
        original = copy.deepcopy(value)
        body = evaluation.request_body(value, Path('.'))
        self.assertTrue(body['messages'][0]['content'].startswith(evaluation.system_prompt()))
        encoded = json.dumps(body)
        self.assertIn('left', encoded)
        self.assertIn('right', encoded)
        self.assertNotIn('expected', encoded)
        self.assertNotIn('optionId', json.dumps(body['response_format']))
        self.assertEqual(original, value)
        with mock.patch.object(evaluation, 'query', return_value=(answer(), .1)):
            self.assertEqual(answer(), evaluation.query_case('http://unused', value, Path('.'))[0])

    def test_diagnostic_answer_purpose_explains_wire_values_and_refusal_semantics(self):
        prompt = evaluation.request_body(case(), Path('.'))['messages'][0]['content']
        self.assertTrue(prompt.startswith(evaluation.system_prompt() + '\n'))
        for instruction in ('every required field exactly once', 'option.id', 'JSON array',
                            'JSON number', 'JSON string', 'ABSTAIN', 'empty answers array'):
            self.assertIn(instruction, prompt)

    def test_answer_schema_rejects_refusal_answers_and_scopes_each_field_value_type(self):
        value = case()
        value['parts'][0]['fields'] += [field('multiple', 'MULTI_CHOICE'),
                                       field('number', 'NUMBER', min=0, max=9),
                                       field('text', 'TEXT', maxLength=20)]
        value['expected'] += [{'partId': 'left', 'fieldId': 'multiple', 'value': ['blue-id']},
                              {'partId': 'left', 'fieldId': 'number', 'value': 7},
                              {'partId': 'left', 'fieldId': 'text', 'value': 'blue'}]
        schema = evaluation.request_body(value, Path('.'))['response_format']['json_schema']['schema']
        branches = {branch['properties']['decision']['const']: branch for branch in schema['anyOf']}
        self.assertEqual({'ANSWER', 'ABSTAIN'}, set(branches))
        refused = branches['ABSTAIN']['properties']['answers']
        self.assertEqual('array', refused['type'])
        self.assertEqual(0, refused['maxItems'])
        responses = branches['ANSWER']['properties']['answers']
        self.assertEqual(5, responses['minItems'])
        self.assertEqual(5, responses['maxItems'])
        alternatives = responses['items']['anyOf']
        scoped = {(item['properties']['partId']['const'], item['properties']['fieldId']['const']): item
                  for item in alternatives}
        self.assertEqual({('left', 'choice'), ('right', 'choice'), ('left', 'multiple'),
                          ('left', 'number'), ('left', 'text')}, set(scoped))
        single = scoped['left', 'choice']['properties']['value']
        self.assertEqual({'type': 'string', 'enum': ['blue-id', 'red-id']}, single)
        multiple = scoped['left', 'multiple']['properties']['value']
        self.assertEqual('array', multiple['type'])
        self.assertEqual(single, multiple['items'])
        number = scoped['left', 'number']['properties']['value']
        self.assertEqual({'type': 'number', 'minimum': 0, 'maximum': 9}, number)
        self.assertEqual({'type': 'string', 'minLength': 1, 'maxLength': 20},
                         scoped['left', 'text']['properties']['value'])

    def test_one_wrong_or_missing_field_fails_the_whole_set(self):
        value = case()
        self.assertTrue(evaluation.correct_set(value, answer()))
        wrong = copy.deepcopy(answer())
        wrong['answers'][1]['value'] = 'red-id'
        self.assertFalse(evaluation.correct_set(value, wrong))
        with self.assertRaises(ValueError):
            evaluation.validate_response(value, answer(value['expected'][:1]))
        with self.assertRaises(ValueError):
            evaluation.validate_response(value, answer([value['expected'][0], value['expected'][0]]))

    def test_refusal_is_unsolved_and_legacy_or_foreign_fields_are_rejected(self):
        abstain = {'decision': 'ABSTAIN', 'answers': [], 'reason': 'Missing material'}
        self.assertEqual(abstain, evaluation.validate_response(case(), abstain))
        self.assertFalse(evaluation.correct_set(case(), abstain))
        for invalid in ({'decision': 'ANSWER', 'optionId': 'blue-id'},
                        {'decision': 'ABSTAIN', 'answers': case()['expected'], 'reason': None},
                        answer([{'partId': 'other', 'fieldId': 'choice', 'value': 'blue-id'}]),
                        answer([{'partId': 'left', 'fieldId': 'choice', 'value': 'made-up'}])):
            with self.assertRaises(ValueError):
                evaluation.validate_response(case(), invalid)

    def test_text_number_and_multichoice_values_are_strict_and_order_independent(self):
        value = case()
        value['parts'] = [value['parts'][0]]
        value['parts'][0]['fields'] = [field('choices', 'MULTI_CHOICE'), field('number', 'NUMBER', min=0, max=2), field('text', 'TEXT', maxLength=5)]
        value['expected'] = [{'partId': 'left', 'fieldId': 'choices', 'value': ['blue-id', 'red-id']},
                             {'partId': 'left', 'fieldId': 'number', 'value': 0},
                             {'partId': 'left', 'fieldId': 'text', 'value': 'blue'}]
        actual = copy.deepcopy(value['expected'])
        actual[0]['value'].reverse()
        self.assertTrue(evaluation.correct_set(value, answer(list(reversed(actual)))))
        for field_index, invalid_value in ((0, ['blue-id', 'blue-id']), (0, 'blue-id'), (1, True), (1, 3), (1, float('nan')), (2, 'too long')):
            invalid = copy.deepcopy(actual)
            invalid[field_index]['value'] = invalid_value
            with self.assertRaises(ValueError):
                evaluation.validate_response(value, answer(invalid))

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
        value = case()
        value['category'] = 'image'
        value['parts'][0]['media'] = [{'id': 'image', 'path': '../outside', 'kind': 'image', 'mimeType': 'image/png', 'sha256': 'a' * 64}]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'within the corpus'):
                evaluation.request_body(value, Path(directory))

    def test_media_hash_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'audio.wav').write_bytes(b'RIFF')
            value = case()
            value['category'] = 'speech'
            value['parts'][0]['media'] = [{'id': 'audio', 'path': 'audio.wav', 'kind': 'audio', 'mimeType': 'audio/wav', 'sha256': 'a' * 64, 'durationMs': 1000}]
            with self.assertRaisesRegex(ValueError, 'checksum'):
                evaluation.request_body(value, root)

    def test_accuracy_counts_unsolved_and_errors(self):
        rows = [{'category': category, 'correct': i < 22, 'seconds': 1} for category in evaluation.CATEGORIES for i in range(25)]
        result = evaluation.summarize(rows)
        self.assertEqual(result['speech']['accuracy'], .88)
        self.assertFalse(result['speech']['diagnosticPassed'])

    def test_latency_gate_is_category_specific(self):
        rows = [{'category': category, 'correct': True, 'seconds': 40} for category in evaluation.CATEGORIES for _ in range(25)]
        result = evaluation.summarize(rows)
        self.assertFalse(result['text']['diagnosticPassed'])
        self.assertTrue(result['speech']['diagnosticPassed'])

    def test_corpus_requires_all_four_categories(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'corpus.json'
            path.write_text(json.dumps({'schemaVersion': 2, 'provenance': 'test', 'labelMethod': 'test', 'cases': []}))
            with self.assertRaises(ValueError):
                evaluation.load_cases(path)

    def test_old_corpus_is_rejected_with_migration_message(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'corpus.json'
            path.write_text(json.dumps({'schemaVersion': 1, 'cases': []}))
            with self.assertRaisesRegex(ValueError, 'new v2 whole-set corpus'):
                evaluation.load_cases(path)

    def test_diagnostics_refuse_existing_reports_before_model_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'result.json'
            output.write_text('existing measured result')
            with mock.patch.object(sys, 'argv', ['evaluate.py', '--corpus', 'unused', '--output', str(output)]), mock.patch.object(evaluation, 'query') as query:
                with self.assertRaisesRegex(ValueError, 'must not be overwritten'):
                    evaluation.main()
                query.assert_not_called()
            self.assertEqual('existing measured result', output.read_text())

    def test_no_attempt_is_not_a_fabricated_latency(self):
        rows = [{'category': category, 'correct': index < 24, 'seconds': 1 if index < 24 else None}
                for category in evaluation.CATEGORIES for index in range(25)]
        result = evaluation.summarize(rows)['speech']
        self.assertEqual(result['accuracy'], .96)
        self.assertEqual(result['measuredCount'], 24)
        self.assertIsNone(result['p95Seconds'])
        self.assertFalse(result['diagnosticPassed'])

    def test_audio_total_is_bounded_even_across_parts(self):
        value = case()
        value['category'] = 'speech'
        value['parts'] = [dict(copy.deepcopy(value['parts'][0]), id=f'p{index}') for index in range(3)]
        value['expected'] = [{'partId': part['id'], 'fieldId': 'choice', 'value': 'blue-id'} for part in value['parts']]
        for part in value['parts']:
            part['media'] = [{'id': 'audio', 'path': 'audio.wav', 'kind': 'audio', 'mimeType': 'audio/wav', 'sha256': 'a' * 64, 'durationMs': 60000}]
        with mock.patch.object(evaluation, 'original_media', return_value=b'a'):
            with self.assertRaisesRegex(ValueError, '120 seconds'):
                evaluation.request_body(value, Path('.'), normalize_audio=False)

    def test_media_total_is_bounded_without_truncation(self):
        value = case()
        value['category'] = 'image'
        value['parts'][0]['media'] = [{'id': f'image-{index}', 'path': 'image.png', 'kind': 'image', 'mimeType': 'image/png', 'sha256': 'a' * 64} for index in range(4)]
        with mock.patch.object(evaluation, 'original_media', return_value=b'12345'), mock.patch.object(evaluation, 'MAX_REQUEST_MEDIA', 15):
            with self.assertRaisesRegex(ValueError, '64 MiB'):
                evaluation.request_body(value, Path('.'))

    def test_output_is_explicitly_diagnostic_and_cannot_be_admission_evidence(self):
        value = case()
        corpus = {'provenance': 'unit fixture', 'labelMethod': 'authored before inference',
                  'cases': [dict(copy.deepcopy(value), id=f'{category}-{index}', category=category)
                            for category in evaluation.CATEGORIES for index in range(25)]}
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'corpus.json', Path(directory) / 'result.json'
            source.write_text('fixture corpus bytes')
            with (mock.patch.object(sys, 'argv', ['evaluate.py', '--corpus', str(source), '--output', str(output)]),
                  mock.patch.object(evaluation, 'load_cases', return_value=corpus),
                  mock.patch.object(evaluation, 'request_body'),
                  mock.patch.object(evaluation, 'query_case', return_value=(answer(), .1)),
                  mock.patch.object(evaluation, 'Telemetry') as telemetry,
                  mock.patch('builtins.print')):
                telemetry.return_value.finish.return_value = {'sampleCount': 0, 'containerPeakMemoryBytes': None}
                evaluation.main()
            report = json.loads(output.read_text())
            self.assertEqual('direct-model-diagnostic', report['source'])
            self.assertFalse(report['admissionEvidence'])
            self.assertFalse(report['productionPipeline'])
            self.assertTrue(report['diagnosticPassed'])
            self.assertNotIn('modelSha256', report)
            self.assertEqual(100, len(report['cases']))
            self.assertEqual('fixture corpus bytes', source.read_text())

    def test_generator_preserves_all_single_cases_and_adds_scoped_multifield_sets(self):
        def write_wav(path):
            with wave.open(str(path), 'wb') as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
                output.writeframes(b'\0' * 32000)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / 'media'
            media.mkdir()
            for name in [f'speech-{index:02}.wav' for index in range(1, 26)] + [f'prosody-{index:02}.wav' for index in range(21, 26)]:
                write_wav(media / name)
            # Structural generator check: media synthesis algorithms are not scored by this test.
            with mock.patch.object(generator, 'png', side_effect=lambda path, count: path.write_bytes(b'png')), mock.patch.object(generator, 'sound', side_effect=lambda path, *args, **kwargs: write_wav(path)):
                generator.generate(root)
            document = evaluation.load_cases(root / 'corpus.json')
            self.assertEqual(120, len(document['cases']))
            self.assertEqual(100, sum(len(value['parts']) == 1 for value in document['cases']))
            for category in evaluation.CATEGORIES:
                self.assertEqual(30, sum(value['category'] == category for value in document['cases']))
            for value in document['cases']:
                self.assertTrue(evaluation.correct_set(value, {'decision': 'ANSWER', 'answers': value['expected'], 'reason': None}))
                if '-multi-' in value['id']:
                    self.assertEqual(5, len(value['expected']))
            labelled = (root / 'corpus.json').read_bytes()
            with self.assertRaisesRegex(ValueError, 'existing labelled bytes'):
                generator.generate(root)
            self.assertEqual(labelled, (root / 'corpus.json').read_bytes())


if __name__ == '__main__':
    unittest.main()
