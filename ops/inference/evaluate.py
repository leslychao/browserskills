"""Evaluate a labelled local corpus against the actual llama.cpp endpoint; no simulated model scores."""
import argparse
import base64
import hashlib
import json
import math
import mimetypes
from pathlib import Path
import subprocess
import threading
import time
import urllib.request
import tempfile
import wave
import io
import secrets
import string

CATEGORIES = ('text', 'image', 'speech', 'sound-prosody')
PROMPT_PATH = (Path('/app/decision-system.txt') if Path('/app/decision-system.txt').is_file()
               else Path(__file__).resolve().parents[2] / 'apps/api/src/main/resources/decision-system.txt')


def system_prompt():
    # Same canonical resource consumed by InferenceClient; grammar does not teach ANSWER/ABSTAIN semantics.
    return PROMPT_PATH.read_text(encoding='utf-8').strip()


def normalized_audio(original, duration_ms):
    """Match API AudioNormalizer flags, timeout, byte and duration bounds; never modify corpus originals."""
    with tempfile.TemporaryDirectory(prefix='browserskills-audio-') as directory:
        source, output = Path(directory) / 'original', Path(directory) / 'inference.wav'
        source.write_bytes(original)
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'quiet',
                        '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,ogg,matroska,webm,flac,mov,aac',
                        '-i', str(source), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
                        '-fs', '4000001', str(output)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=True, timeout=20)
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


class Telemetry:
    def __init__(self):
        self.stop = threading.Event()
        self.samples = []
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.stop.is_set():
            measured = {}
            try:
                raw = subprocess.run(['nvidia-smi', '--query-gpu=index,name,memory.used,memory.total,utilization.gpu',
                                      '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3, check=True).stdout
                measured['gpu'] = [{'index': fields[0].strip(), 'name': fields[1].strip(), 'usedMiB': int(fields[2]),
                                    'totalMiB': int(fields[3]), 'utilizationPercent': int(fields[4])}
                                   for fields in (line.split(',') for line in raw.strip().splitlines())]
            except (OSError, ValueError, subprocess.SubprocessError):
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
        memory = [s['containerMemoryBytes'] for s in self.samples if s.get('containerMemoryBytes') is not None]
        gpu = [g for sample in self.samples for g in (sample.get('gpu') or [])]
        return {'sampleCount': len(self.samples), 'containerPeakMemoryBytes': max(memory, default=None),
                'gpuDevices': sorted({g['name'] for g in gpu}), 'peakWholeGpuMemoryMiB': max((g['usedMiB'] for g in gpu), default=None),
                'peakGpuUtilizationPercent': max((g['utilizationPercent'] for g in gpu), default=None),
                'scope': 'GPU readings cover the entire device, including other processes; container RAM is this inference container cgroup.'}


def load_cases(path):
    if path.stat().st_size > 10 * 1024**2:
        raise ValueError('Corpus JSON exceeds 10 MiB.')
    document = json.loads(path.read_text(encoding='utf-8'))
    cases = document['cases']
    if not 100 <= len(cases) <= 400:
        raise ValueError('A bounded acceptance corpus contains 100..400 cases.')
    if not document.get('provenance') or not document.get('labelMethod'):
        raise ValueError('Corpus must disclose provenance and label method.')
    ids = set()
    for case in cases:
        if case['id'] in ids or case['category'] not in CATEGORIES:
            raise ValueError('Duplicate id or invalid category.')
        ids.add(case['id'])
        options = case['options']
        option_ids = {option['id'] for option in options}
        if not 2 <= len(options) <= 10 or len(option_ids) != len(options) or case['expectedOptionId'] not in option_ids:
            raise ValueError('Invalid expected answer/options.')
        if case['category'] != 'text' and not case.get('media'):
            raise ValueError('Non-text cases require real media bytes.')
        kinds = {asset['kind'] for asset in case.get('media', [])}
        expected_kind = 'image' if case['category'] == 'image' else 'audio'
        if case['category'] != 'text' and expected_kind not in kinds:
            raise ValueError('Case category must match the actual input modality.')
    if any(sum(c['category'] == category for c in cases) < 25 for category in CATEGORIES):
        raise ValueError('Acceptance corpus requires at least 25 cases in every category.')
    return document


def request_body(case, root, *, normalize_audio=True):
    # Mirror the production InferenceClient material ordering and labels.
    content = [{'type': 'text', 'text': 'PROJECT INSTRUCTIONS (all blocks, in order):'},
               {'type': 'text', 'text': case['instruction']},
               {'type': 'text', 'text': 'CURRENT WHOLE TASK:\n' + case['question']}]
    for media in case.get('media', []):
        path = (root / media['path']).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError('Media path must remain within the corpus directory.')
        if path.stat().st_size > 20 * 1024**2:
            raise ValueError('Media exceeds 20 MiB.')
        data = path.read_bytes()
        if len(data) > 20 * 1024**2 or hashlib.sha256(data).hexdigest() != media['sha256']:
            raise ValueError('Media exceeds bounds or checksum differs from labelled corpus.')
        if media['kind'] == 'image':
            encoded = base64.b64encode(data).decode('ascii')
            content.append({'type': 'image_url', 'image_url': {'url': f'data:{media["mimeType"]};base64,{encoded}'}})
        elif media['kind'] == 'audio':
            if not 0 < media['durationMs'] <= 60000:
                raise ValueError('Task audio duration must be 0..60000ms.')
            if normalize_audio:
                data = normalized_audio(data, media['durationMs'])
            encoded = base64.b64encode(data).decode('ascii')
            content.append({'type': 'input_audio', 'input_audio': {'data': encoded, 'format': 'wav'}})
        else:
            raise ValueError('Unsupported media kind.')
    content.append({'type': 'text', 'text': 'AVAILABLE OPTIONS:\n' + json.dumps(case['options'], ensure_ascii=False)})
    schema = {'oneOf': [
        {'type': 'object', 'properties': {'decision': {'const': 'ANSWER'}, 'optionId': {'type': 'string', 'enum': [o['id'] for o in case['options']]}}, 'required': ['decision', 'optionId'], 'additionalProperties': False},
        {'type': 'object', 'properties': {'decision': {'const': 'ABSTAIN'}}, 'required': ['decision'], 'additionalProperties': False}]}
    return {'model': 'Qwen2.5-Omni-7B', 'stream': False, 'temperature': 0, 'max_tokens': 512, 'cache_prompt': False,
            'messages': [{'role': 'system', 'content': system_prompt()}, {'role': 'user', 'content': content}],
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'decision', 'strict': True, 'schema': schema}}}


def query(url, body, timeout=120):
    req = urllib.request.Request(url + '/v1/chat/completions', json.dumps(body).encode('utf-8'), {'Content-Type': 'application/json'})
    start = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        raise ValueError('Inference response too large.')
    payload = json.loads(raw)
    if payload['choices'][0]['finish_reason'] != 'stop':
        raise ValueError('Incomplete model response.')
    answer = json.loads(payload['choices'][0]['message']['content'])
    return answer, time.monotonic() - start


def option_aliases(options):
    excluded = {option['id'] for option in options}
    aliases = []
    for _ in options:
        while True:
            alias = ''.join(secrets.choice(string.ascii_lowercase) for _ in range(10))
            if alias not in excluded:
                excluded.add(alias)
                aliases.append(alias)
                break
    return aliases


def query_case(url, case, root, aliases):
    started = time.monotonic()
    options = case['options']
    if (len(aliases) != len(options) or len(set(aliases)) != len(aliases)
            or any(len(a) != 10 or any(c not in string.ascii_lowercase for c in a) for a in aliases)
            or set(aliases) & {option['id'] for option in options}):
        raise ValueError('Invalid request-local option aliases.')
    inverse = {alias: option['id'] for alias, option in zip(aliases, options)}
    aliased_case = dict(case, options=[dict(option, id=alias) for alias, option in zip(aliases, options)])
    body = request_body(aliased_case, root)
    remaining = 120 - (time.monotonic() - started)
    if remaining <= 0:
        raise TimeoutError('Audio/material preparation exhausted the request deadline.')
    answer, elapsed = query(url, body, timeout=remaining)
    if answer == {'decision': 'ABSTAIN'}:
        return answer, elapsed
    if (set(answer) != {'decision', 'optionId'} or answer.get('decision') != 'ANSWER'
            or answer.get('optionId') not in inverse):
        raise ValueError('Model response contains an unknown alias or malformed decision.')
    return {'decision': 'ANSWER', 'optionId': inverse[answer['optionId']]}, elapsed


def summarize(rows):
    output = {}
    for category in CATEGORIES:
        subset = [row for row in rows if row['category'] == category]
        times = sorted(row['seconds'] for row in subset)
        accuracy = sum(row['correct'] for row in subset) / len(subset)
        p95 = times[math.ceil(len(times) * .95) - 1]
        limit = 30 if category in ('text', 'image') else 90
        output[category] = {'count': len(subset), 'accuracy': accuracy, 'p95Seconds': round(p95, 3), 'passed': accuracy >= .9 and p95 <= limit}
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--budget-minutes', type=int, default=180)
    parser.add_argument('--replay-aliases', type=Path, help='Reuse optionAliases from a prior measured report for exact diagnostic replay.')
    args = parser.parse_args()
    if not 1 <= args.budget_minutes <= 360:
        parser.error('budget-minutes must be 1..360')
    corpus = load_cases(args.corpus)
    replay = {}
    if args.replay_aliases:
        if args.replay_aliases.stat().st_size > 10 * 1024**2:
            raise ValueError('Alias replay report exceeds 10 MiB.')
        replay_report = json.loads(args.replay_aliases.read_text())
        if replay_report['corpusSha256'] != hashlib.sha256(args.corpus.read_bytes()).hexdigest():
            raise ValueError('Alias replay requires the identical corpus bytes and option order.')
        replay = {row['id']: row['optionAliases'] for row in replay_report['cases']}
        if set(replay) != {case['id'] for case in corpus['cases']}:
            raise ValueError('Alias replay report must contain exactly this corpus case set.')
    # Validate all media before any inference. No partial acceptance set.
    for case in corpus['cases']:
        request_body(case, args.corpus.parent, normalize_audio=False)
    if args.validate_only:
        print('Corpus shape, case count and original media hashes verified; decoder/model not evaluated.')
        return
    start = time.time()
    deadline = time.monotonic() + args.budget_minutes * 60
    rows = []
    # Warm each modality independently and exclude warmup from latency and accuracy.
    for category in CATEGORIES:
        sample = next(c for c in corpus['cases'] if c['category'] == category)
        query_case(args.url, sample, args.corpus.parent, option_aliases(sample['options']))
    telemetry = Telemetry()
    telemetry.thread.start()
    for case in corpus['cases']:
        started = time.monotonic()
        aliases = replay[case['id']] if replay else option_aliases(case['options'])
        if started > deadline:
            rows.append({'id': case['id'], 'category': case['category'], 'seconds': 120, 'correct': False,
                         'code': 'BUDGET_EXHAUSTED', 'optionAliases': aliases})
            continue
        try:
            decision, elapsed = query_case(args.url, case, args.corpus.parent, aliases)
            elapsed = time.monotonic() - started
            valid = (set(decision) == {'decision', 'optionId'} and decision.get('decision') == 'ANSWER'
                     and decision.get('optionId') in {o['id'] for o in case['options']})
            correct = valid and decision['optionId'] == case['expectedOptionId']
            code = 'CORRECT' if correct else 'UNSOLVED'
        except Exception:
            elapsed = time.monotonic() - started
            correct, code = False, 'INFERENCE_ERROR'
        rows.append({'id': case['id'], 'category': case['category'], 'seconds': elapsed, 'correct': correct, 'code': code,
                     'optionAliases': aliases})
        print(f'{case["id"]}: {code} {elapsed:.2f}s', flush=True)
    categories = summarize(rows)
    measured_resources = telemetry.finish()
    result = {'measuredAtUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(start)),
              'systemPromptSha256': hashlib.sha256(system_prompt().encode('utf-8')).hexdigest(),
              'evaluationScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'requestSettings': {'cache_prompt': False, 'temperature': 0, 'max_tokens': 512,
                                  'optionIds': 'Request-local random10 lowercase ASCII aliases; original IDs unchanged; aliases recorded in option order for replay',
                                  'audio': 'FFmpeg mono16kPCM16WAV;20s/4MB/duration+/-200ms API bounds'},
              'corpusSha256': hashlib.sha256(args.corpus.read_bytes()).hexdigest(), 'provenance': corpus['provenance'],
              'labelMethod': corpus['labelMethod'], 'categories': categories, 'cases': rows, 'resources': measured_resources,
              'passed': all(v['passed'] for v in categories.values()),
              'limitations': 'Only this labelled corpus. Synthetic fixtures do not prove live Yandex accuracy. Attach server preflight and model provenance; unavailable resource fields are not zero usage.'}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
