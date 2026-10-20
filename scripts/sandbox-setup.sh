#!/usr/bin/env bash
# Build the base sandbox image (Dockerfile.sandbox) that runs agent tools in a container.
# Usage: scripts/sandbox-setup.sh [extra docker build args...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${BITTERBOT_SANDBOX_IMAGE:-bitterbot-sandbox:bookworm-slim}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build ${IMAGE}" >&2
  exit 1
fi

echo "Building ${IMAGE} from Dockerfile.sandbox"
docker build -t "${IMAGE}" -f "${ROOT}/Dockerfile.sandbox" "$@" "${ROOT}"
echo "Built ${IMAGE}"
