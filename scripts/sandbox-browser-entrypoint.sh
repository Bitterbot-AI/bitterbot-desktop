#!/usr/bin/env bash
# Entry point of the sandboxed browser image (Dockerfile.sandbox-browser).
#
# Chromium listens for DevTools on loopback inside the container; socat
# exposes it on BITTERBOT_BROWSER_CDP_PORT so the gateway can reach it
# through the port Docker maps to the host's 127.0.0.1. With a display
# (not headless) it runs on Xvfb, and noVNC can show it.
set -euo pipefail

CDP_PORT="${BITTERBOT_BROWSER_CDP_PORT:-9222}"
VNC_PORT="${BITTERBOT_BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${BITTERBOT_BROWSER_NOVNC_PORT:-6080}"
HEADLESS="${BITTERBOT_BROWSER_HEADLESS:-1}"
# Chromium's own sandbox needs user namespaces an unprivileged container does
# not have; the container is the isolation boundary here. Set to 0 when the
# container runs with a seccomp profile that allows Chromium's sandbox.
NO_SANDBOX="${BITTERBOT_BROWSER_NO_SANDBOX:-1}"
ENABLE_NOVNC="${BITTERBOT_BROWSER_ENABLE_NOVNC:-0}"
# Chromium's own DevTools port, inside the container only.
INNER_CDP_PORT=$((CDP_PORT + 1))
PROFILE_DIR="${HOME}/.bitterbot-browser"
mkdir -p "${PROFILE_DIR}"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "${pid}" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

chromium_args=(
  --remote-debugging-address=127.0.0.1
  "--remote-debugging-port=${INNER_CDP_PORT}"
  "--user-data-dir=${PROFILE_DIR}"
  --no-first-run
  --no-default-browser-check
  --disable-dev-shm-usage
  --disable-background-networking
  --disable-features=Translate,MediaRouter
  --password-store=basic
  --window-size=1280,800
)

if [[ "${NO_SANDBOX}" == "1" ]]; then
  chromium_args+=(--no-sandbox)
fi

if [[ "${HEADLESS}" == "1" ]]; then
  chromium_args+=(--headless=new)
else
  export DISPLAY=:99
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
  pids+=($!)
  for _ in $(seq 1 50); do
    [[ -e /tmp/.X11-unix/X99 ]] && break
    sleep 0.1
  done
  if [[ "${ENABLE_NOVNC}" == "1" ]]; then
    x11vnc -display :99 -forever -shared -nopw -localhost -rfbport "${VNC_PORT}" -quiet &
    pids+=($!)
    websockify --web /usr/share/novnc "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
    pids+=($!)
  fi
fi

chromium "${chromium_args[@]}" about:blank &
chromium_pid=$!
pids+=("${chromium_pid}")

# Wait for DevTools before exposing it, so the gateway never sees a refused port.
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:${INNER_CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

socat "TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${INNER_CDP_PORT}" &
pids+=($!)

wait "${chromium_pid}"
