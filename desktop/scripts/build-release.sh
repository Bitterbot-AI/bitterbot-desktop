#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$DESKTOP_DIR")"

echo "=== Step 1: Build gateway backend ==="
cd "$ROOT_DIR"
pnpm build

echo "=== Step 2: Install desktop deps ==="
cd "$DESKTOP_DIR"
pnpm install

echo "=== Step 3: Generate icons ==="
npx tsx scripts/generate-icons.ts

echo "=== Step 4: Build renderer (Vite) ==="
npx vite build

echo "=== Step 5: Build Electron main process ==="
npx vite build --config vite.electron.config.ts

echo "=== Step 6: Build preload script (CJS) ==="
npx esbuild electron/preload.ts --bundle --platform=node --target=node22 \
  --outfile=dist-electron/preload.js --external:electron --format=cjs

echo ""
echo "=== Build complete! ==="
echo ""
echo "Next: run electron-builder from PowerShell (not WSL):"
echo "  cd D:\\Bitterbot\\bitterbot-desktop\\desktop"
echo "  npx electron-builder --config electron-builder.yml --win"
echo ""
echo "Or for macOS (on a Mac):"
echo "  npx electron-builder --config electron-builder.yml --mac"
echo ""
echo "Artifacts will be in: $DESKTOP_DIR/release/"
