"""Build labelled synthetic diagnostics, never presented as natural-data/live-site acceptance."""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import struct
import wave
import zlib


def png(path, count):
    width, height = 400, 180
    data = bytearray()
    for y in range(height):
        data.append(0)
        for x in range(width):
            red = any((x - (45 + index * 75)) ** 2 + (y - 90) ** 2 <= 25 ** 2 for index in range(count))
            data.extend((220, 25, 35) if red else (255, 255, 255))
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    with path.open('xb') as output:
        output.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b''))


def sound(path, kind, number, duration=4):
    rate = 16000
    samples = bytearray()
    phase = 0
    for i in range(rate * duration):
        t = i / rate
        if kind == 'pulses':
            active = any(abs(t - (.4 + n * .6)) < .12 for n in range(number))
            frequency = 600
        elif kind == 'pitch':
            active = True
            frequency = 200 + 600 * (t / duration if number else 1 - t / duration)
        elif kind == 'silence':
            active, frequency = bool(number), 440
        else:
            frequency = 500
            active = (t % (.25 if number else .8)) < .1
        phase += 2 * math.pi * frequency / rate
        envelope = min(1, t * 30, (duration - t) * 30)
        value = int(9000 * envelope * math.sin(phase)) if active else 0
        samples.extend(struct.pack('<h', value))
    with path.open('xb') as output:
        with wave.open(output, 'wb') as handle:
            handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(rate); handle.writeframes(samples)


def media(path, root, kind):
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or not path.is_file() or not 0 < path.stat().st_size <= 20 * 1024**2:
        raise ValueError('Original media must be a bounded regular file inside the corpus.')
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    entry = {'id': 'm' + checksum[:16], 'path': path.relative_to(root).as_posix(), 'kind': kind,
             'mimeType': 'image/png' if kind == 'image' else 'audio/wav', 'sha256': checksum}
    if kind == 'audio':
        with wave.open(str(path), 'rb') as stream:
            entry['durationMs'] = round(stream.getnframes() * 1000 / stream.getframerate())
        if not 0 < entry['durationMs'] <= 60000:
            raise ValueError('Working audio must be at most 60 seconds.')
    return entry


def generate(root):
    target = root / 'media'
    new_files = [root / 'corpus.json'] + [target / f'image-{n:02}.png' for n in range(1, 26)] + [target / f'sound-{n:02}.wav' for n in range(1, 21)]
    if any(path.exists() or path.is_symlink() for path in new_files):
        raise ValueError('Preserve existing labelled bytes: choose a new corpus directory.')
    # Validate fixed SAPI inputs before generating any new images or tones.
    for filename in [f'speech-{n:02}.wav' for n in range(1, 26)] + [f'prosody-{n:02}.wav' for n in range(21, 26)]:
        if not (target / filename).is_file():
            raise ValueError('First run New-DiagnosticCorpus.ps1 to synthesize the fixed speech recordings.')
        media(target / filename, root, 'audio')
    cases = []
    def field(identifier, label, kind, options=None):
        return {'id': identifier, 'label': label, 'kind': kind, 'required': True, 'options': options or [],
                'value': None, 'stage': 0, 'maxLength': None, 'min': None, 'max': None}
    def add(category, index, question, labels, expected, attachment=None):
        choices = [{'id': 'c' + hashlib.sha256(f'{category}/{index}/{n}/{label}'.encode()).hexdigest()[:16], 'label': label} for n, label in enumerate(labels)]
        # Rotate display order; expected labels are assigned independently of model output.
        shift = index % len(choices)
        cases.append({'id': f'{category}-{index:02}', 'category': category,
                      'instruction': 'Answer every required field in every part using only its supplied text or media. For a single choice, select exactly one listed option.',
                      'parts': [{'id': 'part-1', 'title': 'Question', 'text': question, 'media': [] if attachment is None else [attachment],
                                 'fields': [field('choice', question, 'SINGLE_CHOICE', choices[shift:] + choices[:shift])], 'unmappedControls': []}],
                      'expected': [{'partId': 'part-1', 'fieldId': 'choice', 'value': choices[expected]['id']}]})
    number_words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
                    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
                    'twenty one', 'twenty two', 'twenty three', 'twenty four', 'twenty five']
    for i in range(25):
        n = i + 1
        add('text', n, f'Box A has {n} red balls. Box B has {n + 2} blue balls. How many BLUE balls are mentioned?',
            [str(n), str(n + 2), str(2 * n + 2)], 1)
        image = target / f'image-{n:02}.png'
        png(image, i % 5 + 1)
        add('image', n, 'How many red circles are visible?', ['1', '2', '3', '4', '5'], i % 5, media(image, root, 'image'))
        speech = target / f'speech-{n:02}.wav'
        if not speech.exists():
            raise ValueError('First run New-DiagnosticCorpus.ps1 to synthesize the fixed speech recordings.')
        add('speech', n, 'Which number did the voice say?', [number_words[i], number_words[(i + 7) % 25], number_words[(i + 13) % 25]], 0, media(speech, root, 'audio'))
    for i in range(25):
        n = i + 1
        audio = target / f'sound-{n:02}.wav'
        if i < 5:
            sound(audio, 'pulses', i + 1)
            question, labels, answer = 'How many separate beeps occur?', ['1', '2', '3', '4', '5'], i
        elif i < 10:
            sound(audio, 'pitch', i % 2)
            question, labels, answer = 'Does the tone pitch rise or fall?', ['falls', 'rises'], i % 2
        elif i < 15:
            sound(audio, 'silence', i % 2)
            question, labels, answer = 'Is this clip silent or does it contain a tone?', ['silence', 'tone'], i % 2
        elif i < 20:
            sound(audio, 'tempo', i % 2, duration=60)
            question, labels, answer = 'Is the beep rhythm about four beats per second or slower than two beats per second?', ['slower than two', 'about four'], i % 2
        else:
            audio = target / f'prosody-{n:02}.wav'
            if not audio.exists():
                raise ValueError('Missing fixed SAPI prosody recording.')
            question, labels, answer = 'Is the second spoken phrase faster or slower than the first?', ['slower', 'faster'], i % 2
        add('sound-prosody', n, question, labels, answer, media(audio, root, 'audio'))
    # Preserve the 100 original authored questions, then combine fixed pairs into 20 whole sets.
    # Extra representations exercise field scoping and value types, not independent semantic samples.
    for category in ('text', 'image', 'speech', 'sound-prosody'):
        originals = [case for case in cases if case['category'] == category]
        for index in range(5):
            first, second = copy.deepcopy(originals[index]), copy.deepcopy(originals[(index + 1) % 5])
            first_part, second_part = first['parts'][0], second['parts'][0]
            second_part['id'] = 'part-2'
            choice = first_part['fields'][0]
            gold = first['expected'][0]['value']
            label = next(option['label'] for option in choice['options'] if option['id'] == gold)
            first_part['fields'] += [field('multiple', 'Select every listed option that answers the question above.', 'MULTI_CHOICE', copy.deepcopy(choice['options'])),
                                     field('number', 'Write the answer to the question above as a number.', 'NUMBER'),
                                     field('label', 'Copy the correct option label exactly, without added punctuation.', 'TEXT')]
            expected = first['expected'] + [dict(answer, partId='part-2') for answer in second['expected']]
            expected += [{'partId': 'part-1', 'fieldId': 'multiple', 'value': [gold]},
                         {'partId': 'part-1', 'fieldId': 'number', 'value': index + 1 if category == 'speech' else int(label)},
                         {'partId': 'part-1', 'fieldId': 'label', 'value': label}]
            cases.append({'id': f'{category}-multi-{index + 1:02}', 'category': category,
                          'instruction': first['instruction'] + ' Answer the parts independently. Do not copy an answer from one recording or image to another.',
                          'parts': [first_part, second_part], 'expected': expected})
    corpus = {'schemaVersion': 2,
              'provenance': 'Synthetic direct-model diagnostics v2: 100 authored programmatic PNG circles/tones and Windows SAPI speech cases, plus 20 multi-part combinations reusing their materials. Not natural-data or production Yang acceptance.',
              'labelMethod': 'Expected scoped field answers fixed from authored questions and generation parameters before inference. Multiple representations and reused inputs test the whole-set contract; they are not independent semantic gold samples. No model-generated labels.', 'cases': cases}
    with (root / 'corpus.json').open('x', encoding='utf-8', newline='\n') as output:
        json.dump(corpus, output, indent=2)
        output.write('\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    generate(parser.parse_args().output.resolve())
