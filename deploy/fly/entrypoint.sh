#!/bin/sh
# Fly mounts volumes owned by root, and the Bitterbot image runs as `node`.
# Hand the data directory to `node` once, then drop to it for the gateway.
set -eu
DATA_DIR="${HOME:-/home/node}/.bitterbot"
mkdir -p "${DATA_DIR}"
if [ "$(stat -c %u "${DATA_DIR}")" != "1000" ]; then
  chown -R node:node "${DATA_DIR}"
fi
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
