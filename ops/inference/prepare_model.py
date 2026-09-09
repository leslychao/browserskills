"""Download the pinned official model and convert once. Never substitutes third-party weights."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
from recipe_lock import recipe_digest


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def fetch(url, target, expected_bytes, expected_hash, deadline):
    if target.exists():
        if target.stat().st_size == expected_bytes and digest(target) == expected_hash:
            return
        raise RuntimeError(f'Existing file checksum mismatch: {target.name}; remove only that corrupt file and rerun.')
    partial = target.with_suffix(target.suffix + '.partial')
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as output:
                size = 0
                while block := response.read(4 * 1024 * 1024):
                    if time.monotonic() > deadline:
                        raise TimeoutError('Download budget exhausted; rerun explicitly to continue.')
                    size += len(block)
                    if size > expected_bytes:
                        raise ValueError('Upstream file exceeds pinned byte size.')
                    output.write(block)
            if size != expected_bytes or digest(partial) != expected_hash:
                raise ValueError('Downloaded file does not match its official checksum.')
            partial.replace(target)
            return
        except (OSError, TimeoutError):
            if attempt == 2 or time.monotonic() > deadline:
                raise
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='/models')
    parser.add_argument('--lock', default='/conversion/model.lock.json')
    parser.add_argument('--download-only', action='store_true')
    parser.add_argument('--budget-minutes', type=int, default=180)
    args = parser.parse_args()
    if not 1 <= args.budget_minutes <= 360:
        parser.error('budget-minutes must be 1..360')
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock = json.loads(Path(args.lock).read_text())
    provenance_path = root / 'provenance.json'
    if provenance_path.exists():
        saved = json.loads(provenance_path.read_text())
        if saved['recipeHashEncoding'] != 'canonical-json-v1' or saved['recipeLockSha256'] != recipe_digest(Path(args.lock)):
            raise RuntimeError('Models belong to another recipe. Use a new model volume for upgrades.')
        for name, checksum in saved['outputs'].items():
            if digest(root / name) != checksum:
                raise RuntimeError(f'Converted checksum mismatch: {name}')
        print('Pinned converted artifacts verified; conversion not repeated.')
        return
    if shutil.disk_usage(root).free < 60 * 1024**3:
        raise RuntimeError('At least 60 GiB free in the Docker model volume is required for conversion.')
    source = root / 'source'
    source.mkdir(exist_ok=True)
    deadline = time.monotonic() + args.budget_minutes * 60
    model = lock['model']
    for item in model['files']:
        name = item['path']
        if Path(name).name != name:
            raise ValueError('Nested model path not allowed.')
        fetch(f"https://huggingface.co/{model['repository']}/resolve/{model['revision']}/{name}", source / name,
              item['bytes'], item['sha256'], deadline)
        print(f'Verified {name}', flush=True)
    if args.download_only:
        return
    commands = [
        ['/venv/bin/python', '/conversion/convert_hf_to_gguf.py', str(source), '--outfile', str(root / 'language-f16.gguf'), '--outtype', 'f16'],
        ['/app/llama-quantize', str(root / 'language-f16.gguf'), str(root / 'language-Q4_K_M.gguf'), 'Q4_K_M', '4'],
        ['/venv/bin/python', '/conversion/convert_hf_to_gguf.py', str(source), '--mmproj', '--outfile', str(root / 'mmproj-Q8_0.gguf'), '--outtype', 'q8_0'],
    ]
    for command in commands:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Conversion budget exhausted. No serving manifest was created.')
        subprocess.run(command, check=True, timeout=remaining, cwd='/conversion')
    outputs = {name: digest(root / name) for name in ('language-Q4_K_M.gguf', 'mmproj-Q8_0.gguf')}
    result = {'schemaVersion': 1, 'recipeHashEncoding': 'canonical-json-v1', 'recipeLockSha256': recipe_digest(Path(args.lock)), 'source': lock['source'],
              'model': {k: v for k, v in model.items() if k != 'files'}, 'recipe': lock['recipe'], 'outputs': outputs,
              'pythonPackages': Path('/conversion/python-packages.lock').read_text(), 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    temporary = provenance_path.with_suffix('.partial')
    temporary.write_text(json.dumps(result, indent=2) + '\n')
    temporary.replace(provenance_path)
    for name in outputs:
        os.chmod(root / name, 0o644)
    os.chmod(provenance_path, 0o644)
    # These are recipe-owned intermediates only. Original weights remain for reproducibility.
    (root / 'language-f16.gguf').unlink()
    print('Conversion complete. Output SHA256 values recorded in provenance.json.')


if __name__ == '__main__':
    main()
