#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
EXTRA_COMPOSE_FILE="$ROOT_DIR/docker-compose.extra.yml"
IMAGE_NAME="${BITTERBOT_IMAGE:-bitterbot:local}"
EXTRA_MOUNTS="${BITTERBOT_EXTRA_MOUNTS:-}"
HOME_VOLUME_NAME="${BITTERBOT_HOME_VOLUME:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose not available (try: docker compose version)" >&2
  exit 1
fi

BITTERBOT_CONFIG_DIR="${BITTERBOT_CONFIG_DIR:-$HOME/.bitterbot}"
BITTERBOT_WORKSPACE_DIR="${BITTERBOT_WORKSPACE_DIR:-$HOME/.bitterbot/workspace}"

mkdir -p "$BITTERBOT_CONFIG_DIR"
mkdir -p "$BITTERBOT_WORKSPACE_DIR"

export BITTERBOT_CONFIG_DIR
export BITTERBOT_WORKSPACE_DIR
export BITTERBOT_GATEWAY_PORT="${BITTERBOT_GATEWAY_PORT:-18789}"
export BITTERBOT_BRIDGE_PORT="${BITTERBOT_BRIDGE_PORT:-18790}"
export BITTERBOT_GATEWAY_BIND="${BITTERBOT_GATEWAY_BIND:-lan}"
export BITTERBOT_IMAGE="$IMAGE_NAME"
export BITTERBOT_DOCKER_APT_PACKAGES="${BITTERBOT_DOCKER_APT_PACKAGES:-}"
export BITTERBOT_EXTRA_MOUNTS="$EXTRA_MOUNTS"
export BITTERBOT_HOME_VOLUME="$HOME_VOLUME_NAME"

if [[ -z "${BITTERBOT_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    BITTERBOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    BITTERBOT_GATEWAY_TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
fi
export BITTERBOT_GATEWAY_TOKEN

COMPOSE_FILES=("$COMPOSE_FILE")
COMPOSE_ARGS=()

write_extra_compose() {
  local home_volume="$1"
  shift
  local mount

  cat >"$EXTRA_COMPOSE_FILE" <<'YAML'
services:
  bitterbot-gateway:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s:/home/node\n' "$home_volume" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.bitterbot\n' "$BITTERBOT_CONFIG_DIR" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.bitterbot/workspace\n' "$BITTERBOT_WORKSPACE_DIR" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  cat >>"$EXTRA_COMPOSE_FILE" <<'YAML'
  bitterbot-cli:
    volumes:
YAML

  if [[ -n "$home_volume" ]]; then
    printf '      - %s:/home/node\n' "$home_volume" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.bitterbot\n' "$BITTERBOT_CONFIG_DIR" >>"$EXTRA_COMPOSE_FILE"
    printf '      - %s:/home/node/.bitterbot/workspace\n' "$BITTERBOT_WORKSPACE_DIR" >>"$EXTRA_COMPOSE_FILE"
  fi

  for mount in "$@"; do
    printf '      - %s\n' "$mount" >>"$EXTRA_COMPOSE_FILE"
  done

  if [[ -n "$home_volume" && "$home_volume" != *"/"* ]]; then
    cat >>"$EXTRA_COMPOSE_FILE" <<YAML
volumes:
  ${home_volume}:
YAML
  fi
}

VALID_MOUNTS=()
if [[ -n "$EXTRA_MOUNTS" ]]; then
  IFS=',' read -r -a mounts <<<"$EXTRA_MOUNTS"
  for mount in "${mounts[@]}"; do
    mount="${mount#"${mount%%[![:space:]]*}"}"
    mount="${mount%"${mount##*[![:space:]]}"}"
    if [[ -n "$mount" ]]; then
      VALID_MOUNTS+=("$mount")
    fi
  done
fi

if [[ -n "$HOME_VOLUME_NAME" || ${#VALID_MOUNTS[@]} -gt 0 ]]; then
  # Bash 3.2 + nounset treats "${array[@]}" on an empty array as unbound.
  if [[ ${#VALID_MOUNTS[@]} -gt 0 ]]; then
    write_extra_compose "$HOME_VOLUME_NAME" "${VALID_MOUNTS[@]}"
  else
    write_extra_compose "$HOME_VOLUME_NAME"
  fi
  COMPOSE_FILES+=("$EXTRA_COMPOSE_FILE")
fi
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=("-f" "$compose_file")
done
COMPOSE_HINT="docker compose"
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_HINT+=" -f ${compose_file}"
done

ENV_FILE="$ROOT_DIR/.env"
upsert_env() {
  local file="$1"
  shift
  local -a keys=("$@")
  local tmp
  tmp="$(mktemp)"
  # Use a delimited string instead of an associative array so the script
  # works with Bash 3.2 (macOS default) which lacks `declare -A`.
  local seen=" "

  if [[ -f "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      local key="${line%%=*}"
      local replaced=false
      for k in "${keys[@]}"; do
        if [[ "$key" == "$k" ]]; then
          printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
          seen="$seen$k "
          replaced=true
          break
        fi
      done
      if [[ "$replaced" == false ]]; then
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$file"
  fi

  for k in "${keys[@]}"; do
    if [[ "$seen" != *" $k "* ]]; then
      printf '%s=%s\n' "$k" "${!k-}" >>"$tmp"
    fi
  done

  mv "$tmp" "$file"
}

upsert_env "$ENV_FILE" \
  BITTERBOT_CONFIG_DIR \
  BITTERBOT_WORKSPACE_DIR \
  BITTERBOT_GATEWAY_PORT \
  BITTERBOT_BRIDGE_PORT \
  BITTERBOT_GATEWAY_BIND \
  BITTERBOT_GATEWAY_TOKEN \
  BITTERBOT_IMAGE \
  BITTERBOT_EXTRA_MOUNTS \
  BITTERBOT_HOME_VOLUME \
  BITTERBOT_DOCKER_APT_PACKAGES

echo "==> Building Docker image: $IMAGE_NAME"
docker build \
  --build-arg "BITTERBOT_DOCKER_APT_PACKAGES=${BITTERBOT_DOCKER_APT_PACKAGES}" \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/Dockerfile" \
  "$ROOT_DIR"

echo ""
echo "==> Onboarding (interactive)"
echo "When prompted:"
echo "  - Gateway bind: lan"
echo "  - Gateway auth: token"
echo "  - Gateway token: $BITTERBOT_GATEWAY_TOKEN"
echo "  - Tailscale exposure: Off"
echo "  - Install Gateway daemon: No"
echo ""
docker compose "${COMPOSE_ARGS[@]}" run --rm bitterbot-cli onboard --no-install-daemon

echo ""
echo "==> Provider setup (optional)"
echo "WhatsApp (QR):"
echo "  ${COMPOSE_HINT} run --rm bitterbot-cli channels login"
echo "Telegram (bot token):"
echo "  ${COMPOSE_HINT} run --rm bitterbot-cli channels add --channel telegram --token <token>"
echo "Discord (bot token):"
echo "  ${COMPOSE_HINT} run --rm bitterbot-cli channels add --channel discord --token <token>"
echo "Docs: https://docs.bitterbot.ai/channels"

echo ""
echo "==> Starting gateway"
docker compose "${COMPOSE_ARGS[@]}" up -d bitterbot-gateway

echo ""
echo "Gateway running with host port mapping."
echo "Access from tailnet devices via the host's tailnet IP."
echo "Config: $BITTERBOT_CONFIG_DIR"
echo "Workspace: $BITTERBOT_WORKSPACE_DIR"
echo "Token: $BITTERBOT_GATEWAY_TOKEN"
echo ""
echo "Commands:"
echo "  ${COMPOSE_HINT} logs -f bitterbot-gateway"
echo "  ${COMPOSE_HINT} exec bitterbot-gateway node dist/index.js health --token \"$BITTERBOT_GATEWAY_TOKEN\""
