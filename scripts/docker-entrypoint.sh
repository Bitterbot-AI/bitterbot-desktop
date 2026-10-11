#!/bin/sh
# Entrypoint of the Bitterbot image (PLAN-56 Phase 2).
#
# As the image's default user (`node`) it simply runs the command. The
# zero-edit docker-compose.yml starts it as root instead, because Docker
# creates a missing bind-mount folder (./bitterbot-data) owned by root, which
# `node` could not write. Then, and only then, this hands a ROOT-OWNED data
# folder to `node` and drops privileges for the real command. A folder that
# already belongs to someone else (your own ~/.bitterbot) is never chowned.
set -eu
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi
DATA_DIR="${HOME:-/home/node}/.bitterbot"
mkdir -p "${DATA_DIR}"
# The workspace is its own bind mount in the compose file, so Docker may have
# created it (root-owned) inside a data folder the user already owns.
for dir in "${DATA_DIR}" "${DATA_DIR}/workspace"; do
  if [ -d "${dir}" ] && [ "$(stat -c %u "${dir}")" = "0" ]; then
    chown -R node:node "${dir}"
  fi
done
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
