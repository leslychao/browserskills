#!/bin/bash
set -euo pipefail
umask 077
export DISPLAY="${DISPLAY:-:99}"
export FIXTURE_HEADLESS=false
export FIXTURE_BIND_ADDRESS="${FIXTURE_BIND_ADDRESS:-0.0.0.0}"
export FIXTURE_DATA_DIR="${FIXTURE_DATA_DIR:-/tmp/browserskills-fixture}"
Xvfb "$DISPLAY" -screen 0 1366x768x24 -nolisten tcp &
xvfb_pid=$!
for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -nopw -noclipboard -quiet &
vnc_pid=$!
node "${FIXTURE_ENTRYPOINT:-/app/tests/fixture-worker.mjs}" &
app_pid=$!
trap 'kill "$app_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true; wait || true' EXIT TERM INT
wait -n "$app_pid" "$vnc_pid" "$xvfb_pid"
