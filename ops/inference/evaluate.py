"""Run bounded whole-set diagnostics directly against llama.cpp; never admission evidence."""
import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import urllib.request
import wave

CATEGORIES = ('text', 'image', 'speech', 'sound-prosody')
MAX_MEDIA = 20 * 1024**2
MAX_REQUEST_MEDIA = 64 * 1024**2
PROMPT_PATH = (Path('/app/decision-system.txt') if Path('/app/decision-system.txt').is_file()
               else Path(__file__).resolve().parents[2] / 'apps/api/src/main/resources/decision-system.txt')


def system_prompt():
    return PROMPT_PATH.read_text(encoding='utf-8').strip()


def bounded_text(value, maximum, empty=False):
    return isinstance(value, str) and (empty or bool(value.strip())) and len(value) <= maximum


def identity(value):
    return bounded_text(value, 256)


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_value(field, value):
    choices = {option['id'] for option in field['options']}
    kind = field['kind']
    if kind == 'SINGLE_CHOICE':
        valid = isinstance(value, str) and value in choices
    elif kind == 'MULTI_CHOICE':
        valid = (isinstance(value, list) and len(value) <= 100 and all(identity(v) for v in value)
                 and len(set(value)) == len(value) and all(v in choices for v in value)
                 and (not field['required'] or bool(value)))
    elif kind == 'NUMBER':
        valid = (numeric(value) and (field['min'] is None or value >= field['min'])
                 and (field['max'] is None or value <= field['max']))
    else:
        valid = bounded_text(value, field['maxLength'] or 16384, empty=not field['required'])
    if not valid:
        raise ValueError('Answer value is incompatible with its observed field.')


def validate_response(case, response):
    if not isinstance(response, dict) or set(response) != {'decision', 'answers', 'reason'}:
        raise ValueError('Expected the canonical AnswerSet response.')
    if response['reason'] is not None and not bounded_text(response['reason'], 4096, empty=True):
        raise ValueError('Invalid refusal reason.')
    answers = response['answers']
    if not isinstance(answers, list) or len(answers) > 10000:
        raise ValueError('Answers must be a bounded list of scoped field values.')
    if response['decision'] == 'ABSTAIN':
        if answers:
            raise ValueError('A refusal cannot contain answers.')
        return response
    if response['decision'] != 'ANSWER' or not answers:
        raise ValueError('Expected a nonempty ANSWER or an empty ABSTAIN.')
    fields = {(part['id'], field['id']): field for part in case['parts'] for field in part['fields']}
    seen = set()
    for answer in answers:
        if not isinstance(answer, dict) or set(answer) != {'partId', 'fieldId', 'value'}:
            raise ValueError('Malformed field answer.')
        if not identity(answer['partId']) or not identity(answer['fieldId']):
            raise ValueError('Invalid answer identity.')
        key = (answer['partId'], answer['fieldId'])
        if key in seen or key not in fields:
            raise ValueError('Duplicate or unknown scoped field identity.')
        seen.add(key)
        validate_value(fields[key], answer['value'])
    if any(field['required'] and key not in seen for key, field in fields.items()):
        raise ValueError('AnswerSet is missing a required field.')
    return response


def correct_set(case, response):
    validate_response(case, response)
    if response['decision'] != 'ANSWER':
        return False
    def canonical(answers):
        return {(answer['partId'], answer['fieldId']): sorted(answer['value']) if isinstance(answer['value'], list)
                else answer['value'] for answer in answers}
    return canonical(response['answers']) == canonical(case['expected'])


def validate_case(case):
    if not isinstance(case, dict) or set(case) != {'id', 'category', 'instruction', 'parts', 'expected'}:
        raise ValueError('A v2 case requires instruction, parts and expected scoped field answers.')
    if not identity(case['id']) or case['category'] not in CATEGORIES or not bounded_text(case['instruction'], 262144):
        raise ValueError('Invalid case identity, category or instruction.')
    parts = case['parts']
    if not isinstance(parts, list) or not 1 <= len(parts) <= 50:
        raise ValueError('A whole set requires 1..50 ordered parts.')
    part_ids, kinds = set(), set()
    for part in parts:
        if not isinstance(part, dict) or set(part) != {'id', 'title', 'text', 'media', 'fields', 'unmappedControls'}:
            raise ValueError('Invalid diagnostic part shape.')
        if not identity(part['id']) or part['id'] in part_ids:
            raise ValueError('Duplicate or invalid part identity.')
        part_ids.add(part['id'])
        if not bounded_text(part['title'], 8192, empty=True) or not bounded_text(part['text'], 262144, empty=True):
            raise ValueError('Part text exceeds bounds.')
        if part['unmappedControls'] != []:
            raise ValueError('Direct diagnostics require already mapped fields; they do not test browser grouping.')
        fields = part['fields']
        if not isinstance(fields, list) or not 1 <= len(fields) <= 200:
            raise ValueError('Expected 1..200 observed fields in each diagnostic part.')
        field_ids = set()
        for field in fields:
            if not isinstance(field, dict) or set(field) != {'id', 'label', 'kind', 'required', 'options', 'value', 'stage', 'maxLength', 'min', 'max'}:
                raise ValueError('Invalid observed field shape.')
            if not identity(field['id']) or field['id'] in field_ids or not bounded_text(field['label'], 8192):
                raise ValueError('Duplicate or invalid field identity/label.')
            field_ids.add(field['id'])
            if field['kind'] not in ('SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT', 'NUMBER') or type(field['required']) is not bool:
                raise ValueError('Unsupported field kind or requirement.')
            if field['value'] is not None or type(field['stage']) is not int or not 0 <= field['stage'] <= 20:
                raise ValueError('Diagnostic input fields must be unfilled, with a bounded stage.')
            if field['maxLength'] is not None and (type(field['maxLength']) is not int or not 1 <= field['maxLength'] <= 16384):
                raise ValueError('Invalid text length limit.')
            if any(field[key] is not None and not numeric(field[key]) for key in ('min', 'max')):
                raise ValueError('Numeric bounds must be finite.')
            if field['min'] is not None and field['max'] is not None and field['min'] > field['max']:
                raise ValueError('Inverted numeric bounds.')
            options = field['options']
            if not isinstance(options, list) or len(options) > 100:
                raise ValueError('Invalid choices.')
            if any(not isinstance(option, dict) or set(option) != {'id', 'label'} or not identity(option['id'])
                   or not bounded_text(option['label'], 2048) for option in options):
                raise ValueError('Invalid option label or identifier.')
            if len({option['id'] for option in options}) != len(options):
                raise ValueError('Duplicate choice identity.')
            if (field['kind'].endswith('CHOICE') and len(options) < 2) or (not field['kind'].endswith('CHOICE') and options):
                raise ValueError('Choices must match the field kind.')
        media = part['media']
        if not isinstance(media, list) or len(media) > 100:
            raise ValueError('Too many media assets.')
        media_ids = set()
        for asset in media:
            if not isinstance(asset, dict) or set(asset) not in ({'id', 'path', 'kind', 'mimeType', 'sha256'}, {'id', 'path', 'kind', 'mimeType', 'sha256', 'durationMs'}):
                raise ValueError('Invalid original media reference.')
            if not identity(asset['id']) or asset['id'] in media_ids:
                raise ValueError('Duplicate media identity within a part.')
            media_ids.add(asset['id'])
            if (not bounded_text(asset['path'], 4096) or not isinstance(asset['sha256'], str)
                    or not re.fullmatch('[a-f0-9]{64}', asset['sha256'])):
                raise ValueError('Media requires a bounded path and authored checksum.')
            if asset['kind'] == 'image':
                if asset['mimeType'] not in ('image/png', 'image/jpeg', 'image/webp') or 'durationMs' in asset:
                    raise ValueError('Unsupported image metadata.')
            elif asset['kind'] == 'audio':
                if (asset['mimeType'] not in ('audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/mp4')
                        or type(asset.get('durationMs')) is not int or not 0 < asset['durationMs'] <= 60000):
                    raise ValueError('Working audio must be at most 60 seconds.')
            else:
                raise ValueError('Unsupported media kind.')
            kinds.add(asset['kind'])
    expected_kind = {'text': None, 'image': 'image', 'speech': 'audio', 'sound-prosody': 'audio'}[case['category']]
    if (expected_kind is None and kinds) or (expected_kind is not None and kinds != {expected_kind}):
        raise ValueError('Case category must match its actual materials.')
    validate_response(case, {'decision': 'ANSWER', 'answers': case['expected'], 'reason': None})


def load_cases(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 10 * 1024**2:
        raise ValueError('Corpus must be a regular JSON file of at most 10 MiB.')
    document = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(document, dict) or document.get('schemaVersion') != 2:
        raise ValueError('Unsupported corpus schemaVersion. Generate a new v2 whole-set corpus; preserve historical v1 corpora.')
    cases = document.get('cases')
    if not isinstance(cases, list) or not 100 <= len(cases) <= 400:
        raise ValueError('A bounded diagnostic corpus contains 100..400 whole sets.')
    if not bounded_text(document.get('provenance'), 8192) or not bounded_text(document.get('labelMethod'), 8192):
        raise ValueError('Corpus must disclose provenance and label method.')
    ids = set()
    for case in cases:
        validate_case(case)
        if case['id'] in ids:
            raise ValueError('Duplicate case identity.')
        ids.add(case['id'])
    if any(sum(case['category'] == category for case in cases) < 25 for category in CATEGORIES):
        raise ValueError('Diagnostics require at least 25 whole sets in each of the four categories.')
    return document


def normalized_audio(original, duration_ms, timeout=20):
    """Match AudioNormalizer bounds; corpus original files are never modified."""
    with tempfile.TemporaryDirectory(prefix='browserskills-audio-') as directory:
        source, output = Path(directory) / 'original', Path(directory) / 'inference.wav'
        source.write_bytes(original)
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'quiet',
                        '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,ogg,matroska,webm,flac,mov,aac',
                        '-i', str(source), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
                        '-fs', '4000001', str(output)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=True, timeout=timeout)
        size = output.stat().st_size
        if not 44 <= size <= 4_000_000 or size > duration_ms * 34 + 4096:
            raise ValueError('Normalized audio exceeds API bounds.')
        data = output.read_bytes()
        with wave.open(io.BytesIO(data), 'rb') as stream:
            actual_ms = stream.getnframes() * 1000 / stream.getframerate()
            if stream.getnchannels() != 1 or stream.getsampwidth() != 2 or stream.getframerate() != 16000:
                raise ValueError('Expected mono 16 kHz PCM16 WAV.')
            if abs(actual_ms - duration_ms) > 200:
                raise ValueError('Audio duration differs by more than 200 ms.')
        return data


def original_media(root, media):
    root = root.resolve()
    path = (root / media['path']).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('Media path must remain within the corpus directory.')
    if not 0 < path.stat().st_size <= MAX_MEDIA:
        raise ValueError('Media exceeds 20 MiB or is empty.')
    with path.open('rb') as source:
        data = source.read(MAX_MEDIA + 1)
    if len(data) > MAX_MEDIA or hashlib.sha256(data).hexdigest() != media['sha256']:
        raise ValueError('Media exceeds bounds or checksum differs from the labelled corpus.')
    return data


def request_body(case, root, *, normalize_audio=True, deadline=None):
    validate_case(case)
    content = [{'type': 'text', 'text': 'PROJECT INSTRUCTIONS (complete synthetic instruction):\n' + case['instruction']}]
    raw_bytes, audio_ms = 0, 0
    for part in case['parts']:
        content.append({'type': 'text', 'text': f'CURRENT PART {part["id"]}\n{part["title"]}\n{part["text"]}'})
        for asset in part['media']:
            data = original_media(root, asset)
            raw_bytes += len(data)
            audio_ms += asset.get('durationMs', 0)
            if raw_bytes > MAX_REQUEST_MEDIA or audio_ms > 120000:
                raise ValueError('One request is limited to 64 MiB of original media and 120 seconds of audio.')
            content.append({'type': 'text', 'text': f'TASK MEDIA {asset["id"]} IN PART {part["id"]}'})
            if asset['kind'] == 'image':
                content.append({'type': 'image_url', 'image_url': {'url': f'data:{asset["mimeType"]};base64,{base64.b64encode(data).decode("ascii")}'}})
            else:
                if normalize_audio:
                    remaining = 20 if deadline is None else min(20, deadline - time.monotonic())
                    if remaining <= 0:
                        raise TimeoutError('Material preparation exhausted the request deadline.')
                    data = normalized_audio(data, asset['durationMs'], timeout=remaining)
                content.append({'type': 'input_audio', 'input_audio': {'data': base64.b64encode(data).decode('ascii'), 'format': 'wav'}})
        content.append({'type': 'text', 'text': 'ANSWER EXACTLY THESE FIELDS IN PART ' + part['id'] + ':\n' + json.dumps(part['fields'], ensure_ascii=False)})
    value_schema = {'anyOf': [{'type': 'string', 'maxLength': 16384}, {'type': 'number'},
                              {'type': 'array', 'maxItems': 100, 'items': {'type': 'string', 'maxLength': 256}}]}
    schema = {'type': 'object', 'properties': {'decision': {'type': 'string', 'enum': ['ANSWER', 'ABSTAIN']},
              'answers': {'type': 'array', 'maxItems': sum(len(part['fields']) for part in case['parts']), 'items': {
                  'type': 'object', 'properties': {'partId': {'type': 'string'}, 'fieldId': {'type': 'string'}, 'value': value_schema},
                  'required': ['partId', 'fieldId', 'value'], 'additionalProperties': False}},
              'reason': {'anyOf': [{'type': 'string', 'maxLength': 4096}, {'type': 'null'}]}},
              'required': ['decision', 'answers', 'reason'], 'additionalProperties': False}
    return {'model': 'Qwen2.5-Omni-7B', 'stream': False, 'temperature': 0, 'max_tokens': 2048, 'cache_prompt': False,
            'messages': [{'role': 'system', 'content': system_prompt()}, {'role': 'user', 'content': content}],
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'answer_set', 'strict': True, 'schema': schema}}}


def query(url, body, timeout=120):
    request = urllib.request.Request(url.rstrip('/') + '/v1/chat/completions', json.dumps(body).encode('utf-8'), {'Content-Type': 'application/json'})
    start = time.monotonic()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        raise ValueError('Inference response too large.')
    payload = json.loads(raw)
    if payload['choices'][0]['finish_reason'] != 'stop':
        raise ValueError('Incomplete model response.')
    answer = json.loads(payload['choices'][0]['message']['content'])
    return answer, time.monotonic() - start


def query_case(url, case, root, timeout=120):
    start = time.monotonic()
    deadline = start + min(120, timeout)
    body = request_body(case, root, deadline=deadline)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Material preparation exhausted the request deadline.')
    response, _ = query(url, body, timeout=remaining)
    return validate_response(case, response), time.monotonic() - start


class Telemetry:
    def __init__(self):
        self.stop = threading.Event()
        self.samples = []
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.stop.is_set() and len(self.samples) < 21600:
            measured = {}
            try:
                raw = subprocess.run(['nvidia-smi', '--query-gpu=index,name,memory.used,memory.total,utilization.gpu',
                                      '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3, check=True).stdout
                measured['gpu'] = [{'index': fields[0].strip(), 'name': fields[1].strip(), 'usedMiB': int(fields[2]),
                                    'totalMiB': int(fields[3]), 'utilizationPercent': int(fields[4])}
                                   for fields in (line.split(',') for line in raw.strip().splitlines())]
            except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                measured['gpu'] = None
            try:
                measured['containerMemoryBytes'] = int(Path('/sys/fs/cgroup/memory.current').read_text())
            except (OSError, ValueError):
                measured['containerMemoryBytes'] = None
            self.samples.append(measured)
            self.stop.wait(1)

    def finish(self):
        self.stop.set()
        self.thread.join(timeout=5)
        memory = [sample['containerMemoryBytes'] for sample in self.samples if sample.get('containerMemoryBytes') is not None]
        gpu = [device for sample in self.samples for device in (sample.get('gpu') or [])]
        return {'sampleCount': len(self.samples), 'containerPeakMemoryBytes': max(memory, default=None),
                'gpuDevices': sorted({device['name'] for device in gpu}), 'peakWholeGpuMemoryMiB': max((device['usedMiB'] for device in gpu), default=None),
                'peakGpuUtilizationPercent': max((device['utilizationPercent'] for device in gpu), default=None),
                'scope': 'Whole GPU includes other processes; container RAM is this inference container cgroup. Samples include warmup.'}


def summarize(rows):
    output = {}
    for category in CATEGORIES:
        subset = [row for row in rows if row['category'] == category]
        times = sorted(row['seconds'] for row in subset if row['seconds'] is not None)
        correct = sum(row['correct'] for row in subset)
        accuracy = correct / len(subset) if subset else 0
        p95 = times[math.ceil(len(times) * .95) - 1] if len(times) == len(subset) and times else None
        limit = 30 if category in ('text', 'image') else 90
        output[category] = {'count': len(subset), 'correct': correct, 'wholeSets': True, 'accuracy': accuracy,
                            'measuredCount': len(times), 'p95Seconds': round(p95, 3) if p95 is not None else None,
                            'diagnosticPassed': len(subset) >= 25 and accuracy >= .9 and p95 is not None and p95 <= limit}
    return output


def write_new(path, document):
    with path.open('x', encoding='utf-8', newline='\n') as output:
        json.dump(document, output, indent=2, ensure_ascii=False)
        output.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--budget-minutes', type=int, default=180)
    args = parser.parse_args()
    if not 1 <= args.budget_minutes <= 360:
        parser.error('budget-minutes must be 1..360')
    if os.path.lexists(args.output):
        raise ValueError('Existing measured reports must not be overwritten. Choose a new output path.')
    corpus = load_cases(args.corpus)
    corpus_hash = hashlib.sha256(args.corpus.read_bytes()).hexdigest()
    for case in corpus['cases']:
        request_body(case, args.corpus.parent, normalize_audio=False)
    if args.validate_only:
        print('V2 whole-set shape, independent labels and original media hashes verified. Decoder, model and production pipeline not evaluated.')
        return
    start = time.time()
    deadline = time.monotonic() + args.budget_minutes * 60
    rows, warmup = [], []
    telemetry = Telemetry()
    telemetry.thread.start()
    try:
        for category in CATEGORIES:
            sample = next(case for case in corpus['cases'] if case['category'] == category)
            if time.monotonic() >= deadline:
                warmup.append({'category': category, 'code': 'BUDGET_EXHAUSTED'})
                continue
            try:
                query_case(args.url, sample, args.corpus.parent, timeout=deadline-time.monotonic())
                code = 'COMPLETE'
            except Exception:
                code = 'INFERENCE_ERROR'
            warmup.append({'category': category, 'code': code})
        for case in corpus['cases']:
            started = time.monotonic()
            decision = None
            if started >= deadline:
                elapsed, correct, code = None, False, 'BUDGET_EXHAUSTED'
            else:
                try:
                    decision, elapsed = query_case(args.url, case, args.corpus.parent, timeout=deadline-started)
                    correct = correct_set(case, decision)
                    code = 'CORRECT' if correct else 'UNSOLVED'
                except Exception:
                    elapsed, correct, code = time.monotonic()-started, False, 'INFERENCE_ERROR'
            rows.append({'id': case['id'], 'category': case['category'], 'seconds': elapsed, 'correct': correct, 'code': code,
                         'decision': decision['decision'] if decision else None, 'answers': decision['answers'] if decision else None})
            duration = f'{elapsed:.2f}s' if elapsed is not None else 'not attempted'
            print(f'{case["id"]}: {code} {duration}', flush=True)
    finally:
        resources = telemetry.finish()
    categories = summarize(rows)
    result = {'schemaVersion': 2, 'source': 'direct-model-diagnostic', 'productionPipeline': False, 'admissionEvidence': False,
              'measuredAtUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(start)),
              'systemPromptSha256': hashlib.sha256(system_prompt().encode('utf-8')).hexdigest(),
              'evaluationScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'requestSettings': {'cache_prompt': False, 'temperature': 0, 'max_tokens': 2048,
                                  'answerContract': 'AnswerSet with scoped partId/fieldId; all fields must match gold for a correct whole set',
                                  'audio': 'FFmpeg mono16kPCM16WAV;20s/4MB/duration+/-200ms bounds; at most120s/request'},
              'corpusSha256': corpus_hash, 'provenance': corpus['provenance'], 'labelMethod': corpus['labelMethod'],
              'categories': categories, 'cases': rows, 'warmup': warmup, 'resources': resources,
              'diagnosticPassed': all(category['diagnosticPassed'] for category in categories.values()),
              'limitations': 'Direct model diagnostics only. These requests do not execute browser extraction, instruction preparation, stage handling, form filling or submit verification. Synthetic labels and reused materials do not prove live Yang accuracy. This report cannot admit a model category; use independently labelled production pipeline evaluation. Missing telemetry is unknown, not zero.'}
    write_new(args.output, result)
    if not result['diagnosticPassed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
