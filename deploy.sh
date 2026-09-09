#!/bin/sh
set -eu
umask 077

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export DOCKER_HOST=tcp://192.168.0.107:2375
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH BUILDX_BUILDER

# Optional argument: an existing standalone Compose file on this computer.
compose=${1:-$(docker inspect browserskills-api-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')}
dc() { docker compose --project-directory "$root" -p browserskills "$@"; }
dc -f "$compose" config --quiet

release=$(date -u +%Y%m%dT%H%M%SZ)-$$
docker build -f "$root/apps/api/Dockerfile" -t "browserskills-api:$release" "$root"
docker build -f "$root/apps/browser/Dockerfile" -t "browserskills-browser:$release" "$root"
docker build -f "$root/ops/inference/Dockerfile" --target runtime -t "browserskills-inference:$release" "$root"

mkdir -p "$root/runtime"
next="$root/runtime/compose-$release.json"
dc -f "$compose" -f - config --format json > "$next" <<EOF
services:
  api: {image: "browserskills-api:$release"}
  inference: {image: "browserskills-inference:$release"}
  browser-1: &browser {image: "browserskills-browser:$release"}
  browser-2: *browser
  browser-3: *browser
  browser-4: *browser
  browser-5: *browser
EOF

dc -f "$next" up -d --no-deps --no-build --pull never --wait --wait-timeout 180 \
  api inference browser-1 browser-2 browser-3 browser-4 browser-5
printf 'Deployed: http://192.168.0.107:8080\nCompose: %s\n' "$next"
