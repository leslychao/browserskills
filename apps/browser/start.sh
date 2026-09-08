#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /data/profile /run/browser/media
Xvfb "$DISPLAY" -screen 0 1366x768x24 -nolisten tcp &
xvfb_pid=$!
for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
x11vnc -display "$DISPLAY" -localhost -rfbport "$RFB_PORT" -forever -shared -nopw -noclipboard -quiet &
vnc_pid=$!
node /app/apps/browser/dist/main.js &
app_pid=$!
trap 'kill "$app_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true; wait || true' EXIT TERM INT
wait -n "$app_pid" "$vnc_pid" "$xvfb_pid"
