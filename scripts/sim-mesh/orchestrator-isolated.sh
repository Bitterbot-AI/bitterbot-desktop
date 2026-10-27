#!/usr/bin/env bash
# Isolated-mesh wrapper for local multi-node tests (scripts/sim-mesh/README.md).
#
# The gateway always merges the public relay fleet (and the DNS bootstrap list)
# into the orchestrator's --bootstrap arguments. A test node must never dial
# them: a simulated skill would gossip onto the real mesh. This wrapper keeps
# only loopback bootstraps, forces relay mode off and passes everything else
# through to the real binary. Point `p2p.orchestratorBinary` at it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL="${SIM_MESH_ORCHESTRATOR:-$HERE/../../orchestrator/target/release/bitterbot-orchestrator}"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bootstrap)
      case "$2" in /ip4/127.0.0.1/*) args+=("$1" "$2") ;; esac
      shift 2
      ;;
    --relay-mode) shift 2 ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
exec "$REAL" "${args[@]}" --relay-mode off
