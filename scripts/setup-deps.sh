#!/usr/bin/env bash
# Bitterbot — Install system dependencies
#
# Run: bash scripts/setup-deps.sh
#
# This installs everything Bitterbot needs beyond Node.js and pnpm.
# Safe to re-run — skips already-installed packages.

set -e

echo "🦞 Bitterbot dependency setup"
echo ""

# ── Detect OS ──

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  PKG_MANAGER="apt"
  if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt"
  elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
  elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
  fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
  PKG_MANAGER="brew"
else
  echo "⚠️  Unsupported OS: $OSTYPE"
  echo "   Install manually: chromium, ffmpeg, ripgrep, trash-cli, htop"
  exit 1
fi

echo "   OS: $OSTYPE"
echo "   Package manager: $PKG_MANAGER"
echo ""

# ── Install system packages ──

install_if_missing() {
  local cmd=$1
  local pkg=$2
  local label=${3:-$pkg}

  if command -v "$cmd" &>/dev/null; then
    echo "   ✅ $label (already installed)"
    return
  fi

  echo "   📦 Installing $label..."
  case $PKG_MANAGER in
    apt)    sudo apt-get install -y "$pkg" ;;
    dnf)    sudo dnf install -y "$pkg" ;;
    pacman) sudo pacman -S --noconfirm "$pkg" ;;
    brew)   brew install "$pkg" ;;
  esac
}

echo "── System packages ──"

if [[ "$PKG_MANAGER" == "apt" ]]; then
  sudo apt-get update -qq
fi

install_if_missing "rg"        "ripgrep"    "ripgrep (fast search)"
install_if_missing "trash-put" "trash-cli"  "trash-cli (safe deletion)"
install_if_missing "htop"      "htop"       "htop (monitoring)"
install_if_missing "ffmpeg"    "ffmpeg"     "ffmpeg (media processing)"
install_if_missing "jq"        "jq"         "jq (JSON processing)"
install_if_missing "tmux"      "tmux"       "tmux (terminal multiplexer)"

echo ""

# ── Playwright + Chromium (for browser automation) ──

echo "── Playwright + Chromium ──"

if npx playwright --version &>/dev/null 2>&1; then
  echo "   ✅ Playwright $(npx playwright --version) installed"
else
  echo "   📦 Installing Playwright + Chromium..."
  npx playwright install --with-deps chromium
fi

echo ""

# ── Python + pip (optional, for Skill Seekers integration) ──

echo "── Python (optional) ──"

if command -v python3 &>/dev/null; then
  echo "   ✅ python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
else
  echo "   ⚠️  python3 not found (optional — needed for Skill Seekers integration)"
fi

echo ""

# ── Verify Node.js version ──

echo "── Node.js ──"

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [[ "$NODE_MAJOR" -ge 22 ]]; then
  echo "   ✅ node $NODE_VERSION"
else
  echo "   ⚠️  node $NODE_VERSION (need ≥22)"
  echo "      Install: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi

echo ""
echo "✅ Done! Run 'pnpm install && pnpm build' to build Bitterbot."
