#!/bin/bash
# LongMemEval hard-mode driver for the SAGE evaluation.
#
# Runs the FULL longmemeval_s.json (500 questions) in biological mode
# with Opus 4.7 for answer generation and Haiku for per-session
# entity/relationship extraction (so the SAGE graph channel has fuel).
#
# Two arms:
#   - sage-on:  --extraction enabled (default). Graph channel + planner active.
#   - sage-off: --skip-extraction. Heuristic-only retrieval. Baseline.
#
# Each arm streams a single-line `LME {...}` JSON summary per question
# to its own log file. Tail the log to watch progress live.

set -u  # error on undefined vars
cd "$(dirname "$0")/../.."

# Source env from the project's .env (ANTHROPIC_API_KEY, OPENAI_API_KEY).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ] || [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY and OPENAI_API_KEY must both be set."
  exit 1
fi

ARM="${1:-sage-on}"
LIMIT="${2:-0}"   # 0 = all 500 questions
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

LOG_DIR="benchmarks/longmemeval/results"
mkdir -p "$LOG_DIR"

case "$ARM" in
  sage-on)
    EXTRA_FLAGS=""
    LOG="$LOG_DIR/full-hard-sageon-$STAMP.log"
    LIVE="$LOG_DIR/full-hard-sageon-$STAMP.jsonl"
    ;;
  sage-off)
    EXTRA_FLAGS="--skip-extraction"
    LOG="$LOG_DIR/full-hard-sageoff-$STAMP.log"
    LIVE="$LOG_DIR/full-hard-sageoff-$STAMP.jsonl"
    ;;
  *)
    echo "Usage: $0 [sage-on|sage-off] [limit]"
    exit 1
    ;;
esac

LIMIT_FLAG=""
if [ "$LIMIT" != "0" ]; then
  LIMIT_FLAG="--limit $LIMIT"
fi

echo "Arm:    $ARM"
echo "Limit:  ${LIMIT} (0 = all 500)"
echo "Log:    $LOG"
echo "Live:   $LIVE"
echo ""
echo "Monitor live progress with:"
echo "  tail -F $LOG | grep --line-buffered '^LME '"
echo ""

# shellcheck disable=SC2086
node --import tsx benchmarks/longmemeval/runner-biological.ts \
  $EXTRA_FLAGS \
  $LIMIT_FLAG \
  --model anthropic/claude-opus-4-7 \
  --live-output "$LIVE" \
  > "$LOG" 2>&1
