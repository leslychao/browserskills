#!/bin/bash
set -euo pipefail
umask 077
export FIXTURE_HEADLESS=false
export FIXTURE_BIND_ADDRESS="${FIXTURE_BIND_ADDRESS:-0.0.0.0}"
export FIXTURE_DATA_DIR="${FIXTURE_DATA_DIR:-/tmp/browserskills-fixture}"
# The test runner mounts its bundle over dist/main.js; lifecycle stays production-owned.
exec /usr/local/bin/browser-start
