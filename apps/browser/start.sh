#!/bin/bash
set -euo pipefail
umask 077
# Chrome's crash database and XDG caches must be writable on the read-only image.
export XDG_CONFIG_HOME=/run/browser/config
export XDG_CACHE_HOME=/run/browser/cache
mkdir -p /data/profile /run/browser/media "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
# TigerVNC owns the virtual X display and negotiates UTF-8 ExtendedClipboard.
# The RFB socket is reachable only through the authenticated manual-control bridge.
Xtigervnc "$DISPLAY" -geometry 1366x768 -depth 24 -localhost -interface 127.0.0.1 -rfbport "$RFB_PORT" -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize=0 -SetPrimary=0 -SendPrimary=0 -MaxCutText=131072 -nolisten tcp -Log '*:stderr:0' &
display_pid=$!
for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
node /app/apps/browser/dist/main.js &
app_pid=$!
# Keep X alive until Playwright closes Chromium and flushes/unlocks its profile.
cleanup() {
  trap - EXIT
  trap '' TERM INT
  kill "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  kill "$display_pid" 2>/dev/null || true
  wait "$display_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
wait -n "$app_pid" "$display_pid"
