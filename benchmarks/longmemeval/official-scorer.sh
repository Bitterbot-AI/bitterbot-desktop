#!/usr/bin/env bash
# Score a hypothesis file with the reference LongMemEval scripts, unmodified.
#
# Fetches evaluate_qa.py and print_qa_metrics.py at the pinned commit into a
# scratch dir, installs their four dependencies into a local venv, and runs
# them. Needs OPENAI_API_KEY in the environment (the reference script reads it
# itself). Output: <hyp>.eval-results-gpt-4o next to the hypothesis file.
#
#   bash benchmarks/longmemeval/official-scorer.sh <hypothesis.jsonl> [reference.json]
set -euo pipefail

HYP="${1:?usage: official-scorer.sh <hypothesis.jsonl> [reference.json]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${2:-$HERE/data/longmemeval_s.json}"
COMMIT="9e0b455f4ef0e2ab8f2e582289761153549043fc"
TOOLS="$HERE/.work-official-scorer"
VENV="$TOOLS/venv"
RAW="https://raw.githubusercontent.com/xiaowu0162/LongMemEval/$COMMIT/src/evaluation"

mkdir -p "$TOOLS"
for f in evaluate_qa.py print_qa_metrics.py; do
  if [ ! -f "$TOOLS/$f" ]; then
    echo "fetching $f @ ${COMMIT:0:8}"
    curl -fsSL "$RAW/$f" -o "$TOOLS/$f"
  fi
done
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet openai numpy backoff tqdm
fi
: "${OPENAI_API_KEY:?OPENAI_API_KEY must be set for the reference judge}"

HYP_ABS="$(cd "$(dirname "$HYP")" && pwd)/$(basename "$HYP")"
REF_ABS="$(cd "$(dirname "$REF")" && pwd)/$(basename "$REF")"
cd "$TOOLS"
"$VENV/bin/python" -I evaluate_qa.py gpt-4o "$HYP_ABS" "$REF_ABS" | tail -n 12
"$VENV/bin/python" -I print_qa_metrics.py "$HYP_ABS.eval-results-gpt-4o" "$REF_ABS" || true
