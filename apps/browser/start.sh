#!/bin/bash
set -euo pipefail
umask 077
# Chrome's crash database and XDG caches must be writable on the read-only image.
export XDG_CONFIG_HOME=/run/browser/config
export XDG_CACHE_HOME=/run/browser/cache
mkdir -p /data/profile /run/browser/media "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
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
# Keep X alive until Playwright closes Chromium and flushes/unlocks its profile.
cleanup() {
  trap - EXIT
  trap '' TERM INT
  kill "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  kill "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
  wait "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
wait -n "$app_pid" "$vnc_pid" "$xvfb_pid"
