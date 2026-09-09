"""Score recorded pipeline answers against independent whole-set labels. Does not run a model."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re

CATEGORIES = {'TEXT', 'IMAGE', 'SPEECH', 'SOUND_PROSODY'}


def canonical_answers(answers):
    if not isinstance(answers, list) or len(answers) > 10000:
        raise ValueError('Expected bounded field answers.')
    result = {}
    for answer in answers:
        if set(answer) != {'partId', 'fieldId', 'value'}:
            raise ValueError('Unexpected answer structure.')
        if any(not isinstance(answer[k], str) or not 1 <= len(answer[k]) <= 256 for k in ('partId', 'fieldId')):
            raise ValueError('Invalid field identity.')
        key = (answer['partId'], answer['fieldId'])
        if key in result:
            raise ValueError('Duplicate answer identity.')
        value = answer['value']
        if isinstance(value, list):
            if len(value) > 100 or any(not isinstance(v, str) or not 1 <= len(v) <= 256 for v in value) or len(set(value)) != len(value):
                raise ValueError('Invalid multiple-choice value.')
            value = ('choices', tuple(sorted(value)))
        elif isinstance(value, str):
            if len(value) > 16384:
                raise ValueError('Text answer is too long.')
            value = ('text', value)
        elif type(value) in (int, float) and math.isfinite(value):
            value = ('number', value)
        else:
            raise ValueError('Unsupported field value.')
        result[key] = value
    return result


def score(corpus, predictions):
    if not corpus.get('provenance') or not corpus.get('labelMethod'):
        raise ValueError('Independent label provenance is required.')
    cases = corpus.get('cases')
    if not isinstance(cases, list) or not 1 <= len(cases) <= 400:
        raise ValueError('Expected 1..400 independently labelled whole sets.')
    labelled = {}
    for case in cases:
        if case['id'] in labelled or case['category'] not in CATEGORIES:
            raise ValueError('Duplicate case or unsupported category.')
        expected = canonical_answers(case['expected'])
        if not expected:
            raise ValueError('Empty whole-set labels are not acceptance data.')
        labelled[case['id']] = (case['category'], expected)
    if not isinstance(predictions, list) or len(predictions) > len(cases):
        raise ValueError('Prediction set exceeds the labelled corpus.')
    actual = {}
    for prediction in predictions:
        key = prediction['id']
        if key not in labelled or key in actual:
            raise ValueError('Unknown or duplicate prediction identity.')
        actual[key] = prediction
    rows = []
    for key, (category, expected) in labelled.items():
        prediction = actual.get(key)
        correct = False
        if prediction and prediction.get('decision') == 'ANSWER':
            try:
                correct = canonical_answers(prediction.get('answers')) == expected
            except (ValueError, TypeError, KeyError):
                pass
        seconds = prediction.get('seconds') if prediction else None
        if seconds is not None and (type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds < 0):
            raise ValueError('Invalid measured latency.')
        rows.append({'id': key, 'category': category, 'correct': correct, 'seconds': seconds,
                     'code': 'CORRECT' if correct else 'MISSING_RESULT' if prediction is None else 'UNSOLVED'})
    summaries = []
    for category in sorted({row['category'] for row in rows}):
        subset = [row for row in rows if row['category'] == category]
        total, correct = len(subset), sum(row['correct'] for row in subset)
        times = sorted(row['seconds'] for row in subset if row['seconds'] is not None)
        summaries.append({'category': category, 'total': total, 'correct': correct, 'wholeSets': True,
                          'accuracy': correct / total, 'passed': total >= 25 and correct * 10 >= total * 9,
                          'p95Seconds': times[math.ceil(len(times) * .95) - 1] if len(times) == total else None})
    return {'categories': summaries, 'cases': rows, 'passed': all(row['passed'] for row in summaries)}


def read_document(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError('Expected a regular JSON file of at most 10 MiB.')
    return json.loads(path.read_text(encoding='utf-8'))


def write_new(path, document):
    with path.open('x', encoding='utf-8', newline='\n') as target:
        json.dump(document, target, indent=2, ensure_ascii=False)
        target.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--predictions', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--evidence-output', type=Path)
    args = parser.parse_args()
    corpus, predictions = read_document(args.corpus), read_document(args.predictions)
    if not re.fullmatch('[a-f0-9]{64}', predictions.get('modelSha256', '')):
        raise ValueError('Predictions must identify the actual model checksum.')
    if predictions.get('source') != 'production-pipeline-evaluation':
        raise ValueError('Only recorded production pipeline evaluation results can produce admission evidence.')
    if predictions.get('corpusSha256') != hashlib.sha256(args.corpus.read_bytes()).hexdigest():
        raise ValueError('Predictions are not bound to these exact labelled corpus bytes.')
    for destination in (args.output, args.evidence_output):
        if destination is not None and destination.exists():
            raise ValueError('Existing measured reports must not be overwritten.')
    result = score(corpus, predictions['cases'])
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    result.update(modelSha256=predictions['modelSha256'], corpusSha256=predictions['corpusSha256'],
                  predictionsSha256=hashlib.sha256(args.predictions.read_bytes()).hexdigest(), evaluatedAt=now,
                  provenance=corpus['provenance'], labelMethod=corpus['labelMethod'])
    write_new(args.output, result)
    if args.evidence_output:
        categories = [{key: row[key] for key in ('category', 'total', 'correct', 'wholeSets')}
                      | {'corpusSha256': result['corpusSha256'], 'evaluatedAt': now}
                      for row in result['categories']]
        write_new(args.evidence_output, {'modelSha256': result['modelSha256'], 'categories': categories})
    print(f"Scored {len(result['cases'])} whole sets. Admission gate: {'passed' if result['passed'] else 'failed'}.")
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
