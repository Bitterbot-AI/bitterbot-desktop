#!/usr/bin/env bash
# Install runtime deps into a staging dir, then pack into asar
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(dirname "$DESKTOP_DIR")"
STAGING="/tmp/bitterbot-asar-staging-$$"
ASAR_OUT="$DESKTOP_DIR/release/win-unpacked/resources/app.asar"

echo "=== Cleaning staging ==="
rm -rf "$STAGING"
mkdir -p "$STAGING"

# Copy dist files
cp -r "$DESKTOP_DIR/dist-electron" "$STAGING/dist-electron"
cp -r "$DESKTOP_DIR/dist-renderer" "$STAGING/dist-renderer"

# Copy workspace templates and bundled skills
echo "=== Copying templates and skills ==="
cp -r "$ROOT_DIR/docs/reference/templates" "$STAGING/templates"
cp -r "$ROOT_DIR/skills" "$STAGING/skills"
echo "  Templates: $(ls "$STAGING/templates/" | wc -l) files"
echo "  Skills: $(ls "$STAGING/skills/" | wc -l) entries"

# Copy A2UI canvas assets (needed for artifact rendering)
echo "=== Copying A2UI canvas assets ==="
mkdir -p "$STAGING/a2ui"
cp -r "$ROOT_DIR/src/canvas-host/a2ui/"* "$STAGING/a2ui/"
echo "  A2UI: $(ls "$STAGING/a2ui/" | wc -l) files"

# Extract the list of externalized packages from the bundle
echo "=== Extracting dependency list ==="
DEPS=$(grep -ohP 'from "([a-zA-Z@][^"]*)"' "$DESKTOP_DIR/dist-electron/"*.js \
  | grep -oP '"[^"]+"' | tr -d '"' \
  | grep -v '^node:' \
  | grep -v '^electron$' \
  | sed 's|/.*||' \
  | sort -u)

# For scoped packages, keep the full @scope/pkg
DEPS=$(grep -ohP 'from "(@[^/]+/[^/"]+|[a-zA-Z][^/"]*)"' "$DESKTOP_DIR/dist-electron/"*.js \
  | grep -oP '"[^"]+"' | tr -d '"' \
  | grep -v '^node:' \
  | grep -v '^electron$' \
  | sort -u)

echo "Found $(echo "$DEPS" | wc -l) unique packages"

# Create a minimal package.json with these as dependencies
echo '{ "name": "bitterbot-desktop", "version": "1.0.0", "main": "dist-electron/main.js", "dependencies": {' > "$STAGING/package.json"

FIRST=true
for dep in $DEPS; do
  # Look up version from root package-lock or just use "*"
  VER=$(node -e "try { const p = require('$ROOT_DIR/node_modules/$dep/package.json'); console.log(p.version); } catch { console.log('*'); }" 2>/dev/null || echo "*")
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    echo "," >> "$STAGING/package.json"
  fi
  printf '    "%s": "%s"' "$dep" "$VER" >> "$STAGING/package.json"
done

echo -e '\n  }\n}' >> "$STAGING/package.json"

# Install deps using npm (resolves properly on NTFS)
echo "=== Installing production dependencies ==="
cd "$STAGING"
npm install --production --ignore-scripts 2>&1 | tail -5

# Install Coinbase SDK FIRST (dynamic import, not auto-detected)
echo "=== Installing Coinbase AgentKit (0.2.3) ==="
npm install --no-save @coinbase/agentkit@0.2.3 2>&1 | tail -3 || true
test -d "node_modules/@coinbase/agentkit" && echo "  + @coinbase/agentkit OK" || echo "  ! @coinbase/agentkit FAILED"

# Install sqlite-vec AFTER coinbase (so it doesn't get nuked)
echo "=== Installing sqlite-vec ==="
mkdir -p node_modules/sqlite-vec node_modules/sqlite-vec-windows-x64
npm pack sqlite-vec@0.1.7-alpha.2 2>/dev/null && tar xzf sqlite-vec-*.tgz && cp -r package/* node_modules/sqlite-vec/ && rm -rf package sqlite-vec-*.tgz
npm pack sqlite-vec-windows-x64@0.1.7-alpha.2 2>/dev/null && tar xzf sqlite-vec-windows-x64-*.tgz && cp -r package/* node_modules/sqlite-vec-windows-x64/ && rm -rf package sqlite-vec-windows-x64-*.tgz
test -f "node_modules/sqlite-vec-windows-x64/vec0.dll" && echo "  + sqlite-vec OK (vec0.dll present)" || echo "  ! sqlite-vec FAILED"

# Check size
echo "=== node_modules size ==="
du -sh "$STAGING/node_modules" 2>/dev/null || echo "no node_modules"

# Skip asar — just copy the whole staging dir as an "app" folder
# Electron can load from resources/app/ (unpacked) as well as app.asar
echo "=== Copying to resources/app ==="
APP_DIR="$DESKTOP_DIR/release/win-unpacked/resources/app"
rm -rf "$APP_DIR" 2>/dev/null || true
rm -f "$ASAR_OUT" 2>/dev/null || true
cp -r "$STAGING" "$APP_DIR"

SIZE=$(du -sh "$APP_DIR" | cut -f1)
echo "=== Done! app dir: $SIZE ==="

# Cleanup
cd "$DESKTOP_DIR"
rm -rf "$STAGING"
