#!/usr/bin/env bash
# Rebuild the self-contained mailbox bundle from source (node builtins only).
set -euo pipefail
cd "$(dirname "$0")/../.."
npx esbuild scripts/mailbox-host.ts --bundle --platform=node --format=esm \
  --target=node22 --external:node:* \
  --outfile=deploy/mailbox-host/mailbox-host.bundle.mjs
echo "built deploy/mailbox-host/mailbox-host.bundle.mjs"
