#!/bin/bash
# Download LongMemEval datasets from HuggingFace
set -e

DIR="$(cd "$(dirname "$0")" && pwd)/data"
mkdir -p "$DIR"

echo "📥 Downloading LongMemEval datasets..."

if [ ! -f "$DIR/longmemeval_oracle.json" ]; then
  echo "   → longmemeval_oracle.json"
  wget -q "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json" \
    -O "$DIR/longmemeval_oracle.json"
else
  echo "   ✓ longmemeval_oracle.json (exists)"
fi

if [ ! -f "$DIR/longmemeval_s.json" ]; then
  echo "   → longmemeval_s_cleaned.json → longmemeval_s.json"
  wget -q "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json" \
    -O "$DIR/longmemeval_s.json"
else
  echo "   ✓ longmemeval_s.json (exists)"
fi

echo "✅ Done. Data in $DIR"
ls -lh "$DIR"
