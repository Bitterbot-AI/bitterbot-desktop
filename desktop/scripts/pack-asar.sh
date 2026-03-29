#!/usr/bin/env bash
# Pack dist-electron + dist-renderer + required node_modules into app.asar
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(dirname "$DESKTOP_DIR")"
STAGING="$DESKTOP_DIR/.asar-staging"
ASAR_OUT="$DESKTOP_DIR/release/win-unpacked/resources/app.asar"

echo "=== Preparing asar staging directory ==="
rm -rf "$STAGING"
mkdir -p "$STAGING"

# Copy dist files
cp -r "$DESKTOP_DIR/dist-electron" "$STAGING/dist-electron"
cp -r "$DESKTOP_DIR/dist-renderer" "$STAGING/dist-renderer"

# Copy package.json (electron-builder needs it)
cp "$DESKTOP_DIR/package.json" "$STAGING/package.json"

# Extract externalized dependencies from the gateway bundle
echo "=== Identifying required node_modules ==="
DEPS=$(grep -oP '^import .* from "([^"]+)"' "$DESKTOP_DIR/dist-electron/server.impl-"*.js \
  | grep -oP '"[^"]+"' | tr -d '"' \
  | grep -v '^node:' \
  | sed 's|/.*||' \
  | sed 's|^@[^/]*/[^/]*|&|; t; s|^[^@][^/]*|&|' \
  | sort -u)

# Also check other dist-electron files for imports
for f in "$DESKTOP_DIR/dist-electron/"*.js; do
  MORE=$(grep -oP '^import .* from "([^"]+)"' "$f" 2>/dev/null \
    | grep -oP '"[^"]+"' | tr -d '"' \
    | grep -v '^node:' \
    | sed 's|/.*||' \
    | sed 's|^@[^/]*/[^/]*|&|; t; s|^[^@][^/]*|&|' \
    | sort -u) || true
  DEPS=$(echo -e "$DEPS\n$MORE" | sort -u)
done

echo "Required packages:"
echo "$DEPS"

# Copy each dependency from root node_modules
mkdir -p "$STAGING/node_modules"
for dep in $DEPS; do
  # Handle scoped packages (@scope/pkg)
  if [[ "$dep" == @* ]]; then
    SCOPE=$(echo "$dep" | cut -d'/' -f1)
    PKG=$(echo "$dep" | cut -d'/' -f2)
    SRC="$ROOT_DIR/node_modules/$SCOPE/$PKG"
    if [ -d "$SRC" ]; then
      mkdir -p "$STAGING/node_modules/$SCOPE"
      cp -rL "$SRC" "$STAGING/node_modules/$SCOPE/$PKG" 2>/dev/null || true
      echo "  + $dep"
    else
      # Try desktop node_modules
      SRC="$DESKTOP_DIR/node_modules/$SCOPE/$PKG"
      if [ -d "$SRC" ]; then
        mkdir -p "$STAGING/node_modules/$SCOPE"
        cp -rL "$SRC" "$STAGING/node_modules/$SCOPE/$PKG" 2>/dev/null || true
        echo "  + $dep (desktop)"
      else
        echo "  ! $dep NOT FOUND"
      fi
    fi
  else
    SRC="$ROOT_DIR/node_modules/$dep"
    if [ -d "$SRC" ]; then
      cp -rL "$SRC" "$STAGING/node_modules/$dep" 2>/dev/null || true
      echo "  + $dep"
    else
      SRC="$DESKTOP_DIR/node_modules/$dep"
      if [ -d "$SRC" ]; then
        cp -rL "$SRC" "$STAGING/node_modules/$dep" 2>/dev/null || true
        echo "  + $dep (desktop)"
      else
        echo "  ! $dep NOT FOUND"
      fi
    fi
  fi
done

echo ""
echo "=== Packing asar ==="
mkdir -p "$(dirname "$ASAR_OUT")"
npx asar pack "$STAGING" "$ASAR_OUT"

SIZE=$(du -sh "$ASAR_OUT" | cut -f1)
echo "=== Done! asar size: $SIZE ==="

# Cleanup
rm -rf "$STAGING"
