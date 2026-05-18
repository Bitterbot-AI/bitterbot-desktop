#!/usr/bin/env bash
# Run the 5-cell ablation matrix across a configurable game list.
#
# Cells (toggle MCP tool exposure):
#   1. baseline-partner-template  — no Bitterbot MCP at all (FUTURE: requires a separate harness; this script currently runs the full config only, with a tagged variant)
#   2. +memory                    — query + log_transition
#   3. +hypothesis                — + hypothesis tools
#   4. +curiosity                 — + novelty scoring
#   5. full                       — all tools
#
# For now we only run the `full` cell — Phase 6c work will add a
# `--cells` flag that switches the MCP server's exposed tools per cell.
set -u
cd "$(dirname "$0")/../../.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${ARC_API_KEY:-}" ] || [ -z "${ANTHROPIC_API_KEY:-}" ] || [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: ARC_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY must all be set."
  exit 1
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUTPUT_DIR="benchmarks/arc-agi-3/results/ablation-$STAMP"
mkdir -p "$OUTPUT_DIR"

GAMES_JSON="${1:-benchmarks/arc-agi-3/games.json}"
if [ ! -f "$GAMES_JSON" ]; then
  echo "Game list not found at $GAMES_JSON — run actions/list-games.ts first."
  exit 1
fi

# Extract first 25 game_ids (the public-25 set).
GAME_IDS=$(node -e "const d = JSON.parse(require('node:fs').readFileSync('$GAMES_JSON','utf8')); const ids = (d.games||d).map(g=>g.game_id).slice(0,25); console.log(ids.join(' '));")

echo "Running ablation across games: $GAME_IDS"
echo "Output: $OUTPUT_DIR"
echo ""

node --import=tsx benchmarks/arc-agi-3/runners/run-ablation.ts \
  --cell full \
  --games "$GAME_IDS" \
  --output-dir "$OUTPUT_DIR/full"
