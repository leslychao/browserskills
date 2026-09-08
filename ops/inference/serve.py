"""Refuse partial/corrupt model volumes; start only the pinned, bounded text-output server."""
import hashlib
import json
import os
from pathlib import Path
import sys


def verify(root, recipe_path=Path('/app/model.lock.json')):
    manifest = json.loads((root / 'provenance.json').read_text())
    if manifest['model']['revision'] != 'ae9e1690543ffd5c0221dc27f79834d0294cba00':
        raise ValueError('Unexpected model revision.')
    if manifest['source']['revision'] != '5266f24da75dc449bd56cbed7addb9c8e4a6a73e':
        raise ValueError('Unexpected converter revision.')
    if manifest['recipeLockSha256'] != hashlib.sha256(recipe_path.read_bytes()).hexdigest():
        raise ValueError('Model volume belongs to a different pinned recipe.')
    for name in ('language-Q4_K_M.gguf', 'mmproj-Q8_0.gguf'):
        h = hashlib.sha256()
        with (root / name).open('rb') as handle:
            for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
                h.update(block)
        if h.hexdigest() != manifest['outputs'][name]:
            raise ValueError('Model checksum mismatch.')


if __name__ == '__main__':
    try:
        verify(Path('/models'))
    except (OSError, KeyError, ValueError):
        print('MODEL_NOT_READY: prepare/verify the pinned model volume.', file=sys.stderr)
        sys.exit(1)
    os.execv('/app/llama-server', ['/app/llama-server', '--model', '/models/language-Q4_K_M.gguf',
        '--mmproj', '/models/mmproj-Q8_0.gguf', '--alias', 'Qwen2.5-Omni-7B', '--host', '0.0.0.0', '--port', '8080',
        '--ctx-size', '8192', '--parallel', '1', '--n-gpu-layers', '99', '--no-mmproj-offload',
        '--threads', '4', '--threads-batch', '4', '--batch-size', '512', '--ubatch-size', '128',
        '--no-context-shift', '--no-webui', '--no-slots', '--log-disable', '--jinja', '--timeout', '120'])
