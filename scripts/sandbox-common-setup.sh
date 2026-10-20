#!/usr/bin/env bash
# Build the sandbox image with common toolchains (Dockerfile.sandbox-common: node, python, go, rust, ...).
# Usage: scripts/sandbox-common-setup.sh [extra docker build args...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${BITTERBOT_SANDBOX_COMMON_IMAGE:-bitterbot-sandbox-common:bookworm-slim}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build ${IMAGE}" >&2
  exit 1
fi

# The common image builds on the base image.
if ! docker image inspect "${BITTERBOT_SANDBOX_IMAGE:-bitterbot-sandbox:bookworm-slim}" >/dev/null 2>&1; then
  "${ROOT}/scripts/sandbox-setup.sh"
fi

echo "Building ${IMAGE} from Dockerfile.sandbox-common"
docker build -t "${IMAGE}" -f "${ROOT}/Dockerfile.sandbox-common" \
  --build-arg "BASE_IMAGE=${BITTERBOT_SANDBOX_IMAGE:-bitterbot-sandbox:bookworm-slim}" "$@" "${ROOT}"
echo "Built ${IMAGE}"
