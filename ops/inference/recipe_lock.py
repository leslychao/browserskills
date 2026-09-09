"""Stable recipe identity across Windows/Linux JSON whitespace and line endings."""
import hashlib
import json


def recipe_digest(path):
    value = json.loads(path.read_text(encoding='utf-8'))
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()
