#!/usr/bin/env bash
# Build the sandboxed browser image (Dockerfile.sandbox-browser): Chromium with DevTools, optional Xvfb and noVNC.
# Usage: scripts/sandbox-browser-setup.sh [extra docker build args...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${BITTERBOT_SANDBOX_BROWSER_IMAGE:-bitterbot-sandbox-browser:bookworm-slim}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build ${IMAGE}" >&2
  exit 1
fi

echo "Building ${IMAGE} from Dockerfile.sandbox-browser"
docker build -t "${IMAGE}" -f "${ROOT}/Dockerfile.sandbox-browser" "$@" "${ROOT}"
echo "Built ${IMAGE}"
