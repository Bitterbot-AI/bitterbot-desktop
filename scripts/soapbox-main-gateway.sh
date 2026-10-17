#!/usr/bin/env bash
# Recovery launcher for a local WSL tarball gateway after an interrupted restart.
set -euo pipefail
cd "$HOME/.bitterbot/app/current"
exec ./bin/bitterbot gateway run --port 19001 --bind loopback >>"$HOME/.bitterbot/compute/main-gateway.log" 2>&1
