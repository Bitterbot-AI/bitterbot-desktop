#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE="${SOAPBOX_PILOT_STATE:-$HOME/.bitterbot-soapbox-pilot}"
SCRIPT="$ROOT/scripts/soapbox-desktop-pilot.ts"
if ! command -v node >/dev/null; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
fi
mkdir -p "$STATE"
chmod 700 "$STATE"
pid=""
if [[ -f "$STATE/launcher.pid" ]]; then pid=$(cat "$STATE/launcher.pid"); fi
running() {
  [[ "$pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/$pid/cmdline" ]] && grep -Fq "$SCRIPT" "/proc/$pid/cmdline"
}
case "${1:-start}" in
  run)
    cd "$ROOT"
    exec node --env-file="$HOME/.bitterbot/.env" --import tsx "$SCRIPT" >>"$STATE/pilot.log" 2>&1
    ;;
  check) running ;;
  start)
    if running; then echo 'Pilot is already running: http://127.0.0.1:19031'; exit 0; fi
    docker info >/dev/null 2>&1 || { echo 'Docker is unavailable; start the isolated container engine first.' >&2; exit 1; }
    cd "$ROOT"
    nohup setsid node --env-file="$HOME/.bitterbot/.env" --import tsx "$SCRIPT" >>"$STATE/pilot.log" 2>&1 < /dev/null &
    echo 'Starting the Soapbox desktop pilot at http://127.0.0.1:19031 (first start can take a few minutes).'
    ;;
  stop)
    if running; then kill -TERM "$pid"; echo 'Pilot shutdown requested; saved jobs and wallet state are retained.'; else echo 'Pilot is stopped.'; fi
    ;;
  status)
    if running; then echo 'Pilot process is running.'; else echo 'Pilot process is stopped.'; fi
    [[ ! -f "$STATE/process.json" ]] || cat "$STATE/process.json"
    ;;
  *) echo 'Usage: soapbox-desktop-pilot.sh start|stop|status' >&2; exit 2 ;;
esac
