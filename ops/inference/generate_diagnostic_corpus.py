"""Build labelled synthetic diagnostics, never presented as natural-data/live-site acceptance."""
import argparse
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
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
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
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(rate); handle.writeframes(samples)


def media(path, root, kind):
    entry = {'path': path.relative_to(root).as_posix(), 'kind': kind,
             'mimeType': 'image/png' if kind == 'image' else 'audio/wav', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    if kind == 'audio':
        with wave.open(str(path), 'rb') as stream:
            entry['durationMs'] = round(stream.getnframes() * 1000 / stream.getframerate())
    return entry


def generate(root):
    target = root / 'media'
    target.mkdir(parents=True, exist_ok=True)
    cases = []
    def add(category, index, question, labels, expected, attachment=None):
        choices = [{'id': f'o{n}', 'label': label} for n, label in enumerate(labels)]
        # Rotate display order; expected labels are assigned independently of model output.
        shift = index % len(choices)
        cases.append({'id': f'{category}-{index:02}', 'category': category,
                      'instruction': 'Answer the question using only the supplied text or media. Select exactly one listed option.',
                      'question': question, 'options': choices[shift:] + choices[:shift], 'expectedOptionId': f'o{expected}',
                      'media': [] if attachment is None else [attachment]})
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
    corpus = {'schemaVersion': 1,
              'provenance': 'Synthetic diagnostic set v1: programmatic PNG circles/tones and local Windows SAPI speech. Not a natural-sound, music or real Yandex acceptance corpus.',
              'labelMethod': 'Expected labels fixed from authored questions and generation parameters before inference; no model-generated gold labels.', 'cases': cases}
    (root / 'corpus.json').write_text(json.dumps(corpus, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    generate(parser.parse_args().output.resolve())
