#!/usr/bin/env bash
# =============================================================================
# BitterBot Desktop Agent — Local Environment Setup
# Installs the same SOTA stack that the Daytona sandbox image provides.
# Safe to re-run (idempotent). Designed for WSL2 / Ubuntu / Debian.
# =============================================================================
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*"; }

INSTALLED=()
SKIPPED=()
FAILED=()

track_install() { INSTALLED+=("$1"); }
track_skip()    { SKIPPED+=("$1"); }
track_fail()    { FAILED+=("$1"); }

has_cmd() { command -v "$1" &>/dev/null; }

# -----------------------------------------------------------------------------
# Phase 1: System packages (apt)
# -----------------------------------------------------------------------------
install_apt_packages() {
    log "Phase 1: System packages (apt)"

    local packages=(
        # PDF / Document processing
        poppler-utils antiword unrtf catdoc
        # OCR
        tesseract-ocr tesseract-ocr-eng
        # Media
        ffmpeg imagemagick
        # Document conversion
        pandoc
        # Build tools (for pip packages with C extensions)
        build-essential python3-dev
        # Database CLIs
        sqlite3 postgresql-client
        # Core utilities
        tmux git curl wget unzip zip
        jq csvkit xmlstarlet file less tree rsync
        gnupg procps net-tools
    )

    local to_install=()
    for pkg in "${packages[@]}"; do
        if dpkg -s "$pkg" &>/dev/null; then
            track_skip "apt:$pkg"
        else
            to_install+=("$pkg")
        fi
    done

    if [[ ${#to_install[@]} -gt 0 ]]; then
        log "Installing ${#to_install[@]} apt packages..."
        sudo apt-get update -qq
        sudo apt-get install -y --no-install-recommends "${to_install[@]}"
        for pkg in "${to_install[@]}"; do track_install "apt:$pkg"; done
    else
        log "All apt packages already installed."
    fi
}

# -----------------------------------------------------------------------------
# Phase 1b: wkhtmltopdf (patched Qt build)
# -----------------------------------------------------------------------------
install_wkhtmltopdf() {
    if has_cmd wkhtmltopdf; then
        track_skip "wkhtmltopdf"
        return
    fi
    log "Installing wkhtmltopdf..."
    curl -fsSL -o /tmp/wkhtmltox.deb \
        https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.bookworm_amd64.deb
    sudo apt-get install -y --no-install-recommends /tmp/wkhtmltox.deb || {
        warn "wkhtmltopdf install failed (may need different .deb for your distro)"
        track_fail "wkhtmltopdf"
        return
    }
    rm -f /tmp/wkhtmltox.deb
    track_install "wkhtmltopdf"
}

# -----------------------------------------------------------------------------
# Phase 2: Binary CLI tools (ripgrep, fd, ast-grep, uv, yq)
# -----------------------------------------------------------------------------
install_binary_tools() {
    log "Phase 2: Binary CLI tools"

    # ripgrep
    if has_cmd rg; then
        track_skip "ripgrep"
    else
        log "Installing ripgrep..."
        curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz \
            | tar xz --strip-components=1 -C /tmp
        sudo mv /tmp/rg /usr/local/bin/rg
        track_install "ripgrep"
    fi

    # fd-find
    if has_cmd fd || has_cmd fdfind; then
        track_skip "fd-find"
    else
        log "Installing fd-find..."
        curl -fsSL https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-x86_64-unknown-linux-musl.tar.gz \
            | tar xz --strip-components=1 -C /tmp
        sudo mv /tmp/fd /usr/local/bin/fd
        track_install "fd-find"
    fi

    # ast-grep
    if has_cmd sg; then
        track_skip "ast-grep"
    else
        log "Installing ast-grep..."
        curl -fsSL https://github.com/ast-grep/ast-grep/releases/download/0.40.5/app-x86_64-unknown-linux-gnu.zip \
            -o /tmp/sg.zip
        unzip -o /tmp/sg.zip -d /tmp/sg-extract
        local sg_bin
        sg_bin=$(find /tmp/sg-extract -type f -executable | head -1)
        if [[ -n "$sg_bin" ]]; then
            sudo cp "$sg_bin" /usr/local/bin/sg
            sudo chmod +x /usr/local/bin/sg
            track_install "ast-grep"
        else
            warn "ast-grep: could not find executable in archive"
            track_fail "ast-grep"
        fi
        rm -rf /tmp/sg.zip /tmp/sg-extract
    fi

    # uv (Python package manager)
    if has_cmd uv; then
        track_skip "uv"
    else
        log "Installing uv..."
        curl -fsSL https://astral.sh/uv/install.sh | sh
        # Symlink to /usr/local/bin if installed to ~/.local/bin
        if [[ -f "$HOME/.local/bin/uv" ]] && ! has_cmd uv; then
            sudo ln -sf "$HOME/.local/bin/uv" /usr/local/bin/uv
        fi
        track_install "uv"
    fi

    # yq (YAML processor)
    if has_cmd yq; then
        track_skip "yq"
    else
        log "Installing yq..."
        sudo curl -fsSL -o /usr/local/bin/yq \
            https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
        sudo chmod +x /usr/local/bin/yq
        track_install "yq"
    fi
}

# -----------------------------------------------------------------------------
# Phase 3: Node.js + global CLIs
# -----------------------------------------------------------------------------
install_node_tools() {
    log "Phase 3: Node.js tools"

    # Check Node.js version (need 18+)
    if has_cmd node; then
        local node_major
        node_major=$(node -v | sed 's/v//' | cut -d. -f1)
        if [[ "$node_major" -ge 18 ]]; then
            track_skip "node (v$(node -v))"
        else
            warn "Node.js $(node -v) found but v18+ required. Please upgrade manually."
            track_fail "node"
        fi
    else
        warn "Node.js not found. Install Node.js 18+ manually."
        track_fail "node"
    fi

    # pnpm
    if has_cmd pnpm; then
        track_skip "pnpm"
    else
        log "Installing pnpm..."
        if has_cmd corepack; then
            corepack enable && corepack prepare pnpm@latest --activate
        else
            npm install -g pnpm
        fi
        track_install "pnpm"
    fi

    # TypeScript + ts-node
    if has_cmd tsc; then
        track_skip "typescript"
    else
        log "Installing typescript & ts-node..."
        npm install -g typescript ts-node
        track_install "typescript + ts-node"
    fi

    # Wrangler (Cloudflare)
    if has_cmd wrangler; then
        track_skip "wrangler"
    else
        log "Installing wrangler..."
        npm install -g wrangler
        track_install "wrangler"
    fi

    # Bun
    if has_cmd bun; then
        track_skip "bun"
    else
        log "Installing bun..."
        curl -fsSL https://bun.sh/install | bash
        track_install "bun"
    fi

    # GitHub CLI
    if has_cmd gh; then
        track_skip "gh"
    else
        log "Installing GitHub CLI..."
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
            | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
            | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
        sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends gh
        track_install "gh"
    fi
}

# -----------------------------------------------------------------------------
# Phase 4: Python 3.11+ check
# -----------------------------------------------------------------------------
check_python() {
    log "Phase 4: Python version check"

    if has_cmd python3; then
        local py_version
        py_version=$(python3 --version 2>&1 | awk '{print $2}')
        local py_major py_minor
        py_major=$(echo "$py_version" | cut -d. -f1)
        py_minor=$(echo "$py_version" | cut -d. -f2)
        if [[ "$py_major" -ge 3 && "$py_minor" -ge 11 ]]; then
            log "Python $py_version found (3.11+ OK)"
            track_skip "python3 ($py_version)"
        else
            warn "Python $py_version found but 3.11+ recommended."
        fi
    else
        err "Python 3 not found. Install Python 3.11+ first."
        track_fail "python3"
        return 1
    fi
}

# -----------------------------------------------------------------------------
# Phase 5: Python data science stack (matching Dockerfile Layer 5)
# -----------------------------------------------------------------------------
install_python_packages() {
    log "Phase 5: Python data science stack"

    local packages=(
        # Core data science
        numpy "pandas>=2.2,<3.0" scipy matplotlib seaborn scikit-learn
        # Data processing
        polars duckdb pyarrow orjson
        # Notebooks
        jupyterlab
        # HTTP / Web
        requests httpx aiohttp
        # Parsing
        beautifulsoup4 lxml
        # Documents
        PyPDF2 python-docx openpyxl
        # CLI / Utils
        pillow rich tqdm
        # OCR
        pytesseract
    )

    log "Installing ${#packages[@]} Python packages..."
    pip install --no-cache-dir --break-system-packages "${packages[@]}" 2>/dev/null \
        || pip install --no-cache-dir "${packages[@]}"
    track_install "python-data-science-stack"
}

# -----------------------------------------------------------------------------
# Phase 6: Playwright + Chromium
# -----------------------------------------------------------------------------
install_playwright() {
    log "Phase 6: Playwright + Chromium"

    # Install playwright Python package
    pip install --no-cache-dir --break-system-packages playwright 2>/dev/null \
        || pip install --no-cache-dir playwright

    # Install browser dependencies and Chromium
    playwright install-deps 2>/dev/null || sudo "$(which playwright)" install-deps || true
    playwright install chromium

    # Verify
    if python3 -c "from playwright.sync_api import sync_playwright; print('Playwright OK')" 2>/dev/null; then
        track_install "playwright + chromium"
    else
        warn "Playwright installed but verification failed"
        track_fail "playwright"
    fi
}

# -----------------------------------------------------------------------------
# Phase 6b: WSL2 NTFS mount fix
# -----------------------------------------------------------------------------
fix_wsl_ntfs_mount() {
    # Skip if not running under WSL2
    if [[ ! -f /proc/version ]] || ! grep -qi microsoft /proc/version 2>/dev/null; then
        track_skip "wsl2-ntfs (not WSL2)"
        return
    fi

    log "Phase 6b: WSL2 NTFS mount configuration"

    local wsl_conf="/etc/wsl.conf"
    local needs_metadata=false

    if [[ -f "$wsl_conf" ]]; then
        if grep -q "metadata" "$wsl_conf" 2>/dev/null; then
            track_skip "wsl2-ntfs (metadata already configured)"
            return
        fi
    fi

    warn "WSL2 detected: NTFS mounts need metadata for npm/pnpm to work correctly."
    warn "Adding [automount] metadata option to /etc/wsl.conf."
    warn "You must restart WSL after this (run 'wsl --shutdown' from PowerShell)."

    if [[ -f "$wsl_conf" ]] && grep -q "\[automount\]" "$wsl_conf" 2>/dev/null; then
        # [automount] section exists, add options line after it
        sudo sed -i '/\[automount\]/a options = "metadata,umask=22,fmask=11"' "$wsl_conf"
    else
        # Append new section
        printf '\n[automount]\noptions = "metadata,umask=22,fmask=11"\n' | sudo tee -a "$wsl_conf" > /dev/null
    fi
    track_install "wsl2-ntfs (/etc/wsl.conf)"
}

# -----------------------------------------------------------------------------
# Phase 7: Workspace setup
# -----------------------------------------------------------------------------
setup_workspace() {
    log "Phase 7: Workspace directories"

    mkdir -p ~/.bitterbot/workspace/memory

    if [[ ! -f ~/.bitterbot/.env ]]; then
        log "Creating ~/.bitterbot/.env (fill in your API keys)"
        cat > ~/.bitterbot/.env <<'ENVEOF'
# === BitterBot Desktop Agent — API Keys ===
# Fill in the keys you have. Leave blank if unused.

# Model Providers
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Web Search (powers web_search tool)
BRAVE_API_KEY=

# Web Scraping (enhances web_fetch tool)
FIRECRAWL_API_KEY=

# Gateway Auth
VITE_GATEWAY_URL=ws://127.0.0.1:19001
VITE_GATEWAY_TOKEN=paste-your-gateway-token-here
VITE_GATEWAY_CLIENT_NAME=bitterbot-desktop
ENVEOF
        track_install "~/.bitterbot/.env"
    else
        track_skip "~/.bitterbot/.env (already exists)"
    fi
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo ""
    echo "========================================="
    echo " BitterBot Desktop — Environment Setup"
    echo "========================================="
    echo ""

    check_python || exit 1
    install_apt_packages
    install_wkhtmltopdf
    install_binary_tools
    install_node_tools
    install_python_packages
    install_playwright
    fix_wsl_ntfs_mount
    setup_workspace

    echo ""
    echo "========================================="
    echo " Setup Complete"
    echo "========================================="
    echo ""

    if [[ ${#INSTALLED[@]} -gt 0 ]]; then
        log "Installed (${#INSTALLED[@]}):"
        for item in "${INSTALLED[@]}"; do echo "    $item"; done
    fi

    if [[ ${#SKIPPED[@]} -gt 0 ]]; then
        warn "Already installed (${#SKIPPED[@]}):"
        for item in "${SKIPPED[@]}"; do echo "    $item"; done
    fi

    if [[ ${#FAILED[@]} -gt 0 ]]; then
        err "Failed (${#FAILED[@]}):"
        for item in "${FAILED[@]}"; do echo "    $item"; done
    fi

    echo ""
    log "Next steps:"
    echo "  1. Fill in API keys: nano ~/.bitterbot/.env"
    echo "  2. Run onboarding: bitterbot onboard --install-daemon"
    echo "  3. Verify: python3 -c \"import pandas, numpy, scipy, sklearn, duckdb, polars; print('OK')\""
    echo "  4. Verify: rg --version && fd --version && jq --version"
    echo ""
}

main "$@"
