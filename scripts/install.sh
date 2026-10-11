#!/usr/bin/env bash
#
# Bitterbot installer (PLAN-56 Phase 3a).
#
#   curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version 1.5.0 --no-onboard
#
# What it does, in order (it prints this plan before touching anything):
#   1. Detects your OS/arch (Linux x64/arm64, macOS Apple silicon).
#   2. Downloads the release's checksums.txt, checksums.txt.minisig and the
#      tarball for your platform from GitHub Releases.
#   3. Verifies checksums.txt against the minisign public key PINNED below
#      (with `minisign`, or OpenSSL 3 when minisign is absent), requires the
#      signed trusted comment to name this exact release, then checks the
#      tarball's SHA-256. Without either tool it says so and falls back to
#      SHA-256 over HTTPS (plus `gh attestation verify` when gh is logged in);
#      pass --require-signature to refuse that fallback.
#   4. Unpacks to <dir>/<version>, switches <dir>/current to it, keeps the
#      previous version (for rollback), links ~/.local/bin/bitterbot.
#   5. Runs `bitterbot onboard` (skip with --no-onboard).
#
# Everything lives in functions and the only top-level command is the last
# line, so a partially downloaded script runs nothing.
#
# Read it first: curl -fsSL <url> | less

bb_usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  -s, --version X.Y.Z    Install this release instead of the latest
      --dir PATH         Install root (default: ~/.bitterbot/app)
      --no-onboard       Do not run `bitterbot onboard` afterwards
  -y, --yes              Do not ask for confirmation
      --with-browser     Linux: also download Playwright's Chromium (~170 MB)
                         into ~/.bitterbot/browsers for the browser tool
      --require-signature
                         Refuse to install unless the minisign signature can
                         be verified (needs `minisign` or OpenSSL 3)
  -h, --help             Show this help

Servers: Docker is the recommended path (docs/platforms/docker.md).
USAGE
}

bb_say() { printf '%s\n' "$*"; }
bb_warn() { printf 'WARNING: %s\n' "$*" >&2; }
bb_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

bb_need() {
  command -v "$1" >/dev/null 2>&1 || bb_die "this installer needs '$1' on PATH"
}

# Download $1 to $2. Production downloads are HTTPS-only; test mode also
# allows the loopback/file URL it was given.
bb_fetch() {
  local url=$1 dest=$2
  if [ "$BB_TEST_MODE" = "1" ]; then
    curl -fsSL --retry 2 -o "$dest" "$url"
  else
    curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$dest" "$url"
  fi
}

bb_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

bb_filesize() {
  wc -c <"$1" | tr -d ' '
}

bb_hex() {
  od -An -tx1 "$@" | tr -d ' \n'
}

# OpenSSL 3 (not LibreSSL) can check a minisign signature: Ed25519 over the
# BLAKE2b-512 of the file, plus the global signature over the trusted comment.
bb_openssl_can_verify() {
  command -v openssl >/dev/null 2>&1 || return 1
  case "$(openssl version 2>/dev/null)" in
    "OpenSSL 3."*) ;;
    *) return 1 ;;
  esac
  openssl dgst -blake2b512 </dev/null >/dev/null 2>&1 || return 1
  openssl pkeyutl -help 2>&1 | grep -q -- '-rawin' || return 1
}

# Verify minisign signature $2 over file $1 with public key $3 using OpenSSL.
# Prints the trusted comment on success; returns non-zero on any mismatch.
bb_openssl_minisign_verify() {
  local file=$1 sig=$2 pub=$3 work=$4
  local sig_b64 tc_line gsig_b64 alg
  printf '%s' "$pub" | openssl base64 -d -A >"$work/pk.bin" 2>/dev/null || return 1
  [ "$(bb_filesize "$work/pk.bin")" = "42" ] || return 1
  [ "$(head -c 2 "$work/pk.bin")" = "Ed" ] || return 1
  sig_b64=$(sed -n '2p' "$sig")
  tc_line=$(sed -n '3p' "$sig")
  gsig_b64=$(sed -n '4p' "$sig")
  case $tc_line in
    "trusted comment: "*) ;;
    *) return 1 ;;
  esac
  printf '%s' "$sig_b64" | openssl base64 -d -A >"$work/sig.bin" 2>/dev/null || return 1
  [ "$(bb_filesize "$work/sig.bin")" = "74" ] || return 1
  alg=$(head -c 2 "$work/sig.bin")
  # Key id in the signature must be the pinned key's id.
  [ "$(bb_hex -j2 -N8 "$work/sig.bin")" = "$(bb_hex -j2 -N8 "$work/pk.bin")" ] || return 1
  tail -c 64 "$work/sig.bin" >"$work/ed.sig"
  # Raw Ed25519 key -> SPKI DER (fixed 12-byte prefix), octal escapes for POSIX printf.
  {
    printf '\060\052\060\005\006\003\053\145\160\003\041\000'
    tail -c 32 "$work/pk.bin"
  } >"$work/pk.der"
  case $alg in
    ED) openssl dgst -blake2b512 -binary "$file" >"$work/msg.bin" || return 1 ;;
    Ed) cp "$file" "$work/msg.bin" ;;
    *) return 1 ;;
  esac
  openssl pkeyutl -verify -pubin -inkey "$work/pk.der" -keyform DER -rawin \
    -in "$work/msg.bin" -sigfile "$work/ed.sig" >/dev/null 2>&1 || return 1
  printf '%s' "$gsig_b64" | openssl base64 -d -A >"$work/global.sig" 2>/dev/null || return 1
  [ "$(bb_filesize "$work/global.sig")" = "64" ] || return 1
  {
    cat "$work/ed.sig"
    printf '%s' "${tc_line#trusted comment: }"
  } >"$work/global.msg"
  openssl pkeyutl -verify -pubin -inkey "$work/pk.der" -keyform DER -rawin \
    -in "$work/global.msg" -sigfile "$work/global.sig" >/dev/null 2>&1 || return 1
  printf '%s\n' "${tc_line#trusted comment: }"
}

bb_detect_platform() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case $arch in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
  esac
  case $os in
    Linux)
      if ldd --version 2>&1 | grep -qi musl; then
        bb_die "musl-based Linux (e.g. Alpine) is not supported by the release tarball. Use Docker: https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/docker.md"
      fi
      os=linux
      ;;
    Darwin)
      os=darwin
      # An x64 shell under Rosetta on Apple silicon still gets the native build.
      if [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
        arch=arm64
      fi
      ;;
    *) os=unsupported ;;
  esac
  case "$os-$arch" in
    linux-x64 | linux-arm64 | darwin-arm64) printf '%s-%s\n' "$os" "$arch" ;;
    *)
      bb_die "no release tarball for $(uname -s) $(uname -m). Use Docker instead (Intel Macs and Windows: Docker Desktop): https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/docker.md"
      ;;
  esac
}

bb_confirm() {
  if [ "$BB_YES" = "1" ]; then
    return 0
  fi
  if ! { : </dev/tty; } 2>/dev/null; then
    bb_die "no terminal to confirm on; re-run with --yes to proceed non-interactively"
  fi
  local answer
  printf 'Proceed? [y/N] ' >/dev/tty
  read -r answer </dev/tty || answer=""
  case $answer in
    y | Y | yes | YES) ;;
    *) bb_die "aborted" ;;
  esac
}

main() {
  set -euo pipefail

  local REPO="Bitterbot-AI/bitterbot-desktop"
  # Pinned minisign public key (base64 payload of the .pub file's second
  # line). Same key and key id (310E141334FF6D4) as ORCHESTRATOR_MINISIGN_PUBKEY
  # in scripts/orchestrator-signature.mjs; a unit test keeps them equal. It is
  # NEVER read from the environment outside test mode (see below).
  local PINNED_PUBKEY="RWTU9k8zQeEQA5GbldCYMA7kgR3nwoLbtjhw5FWMGiwu+h72OMk2Ne04"
  local base_url="https://github.com/${REPO}/releases"
  local pubkey=$PINNED_PUBKEY

  local version="" install_dir="${HOME}/.bitterbot/app" onboard=1 with_browser=0
  local require_signature=0
  BB_YES=0
  BB_TEST_MODE=0
  while [ $# -gt 0 ]; do
    case $1 in
      -s | --version)
        [ $# -ge 2 ] || bb_die "$1 needs a value"
        version=${2#v}
        shift 2
        ;;
      --dir)
        [ $# -ge 2 ] || bb_die "$1 needs a value"
        install_dir=$2
        shift 2
        ;;
      --no-onboard)
        onboard=0
        shift
        ;;
      -y | --yes)
        BB_YES=1
        shift
        ;;
      --with-browser)
        with_browser=1
        shift
        ;;
      --require-signature)
        require_signature=1
        shift
        ;;
      -h | --help)
        bb_usage
        return 0
        ;;
      *) bb_die "unknown option: $1 (see --help)" ;;
    esac
  done
  if [ -n "$version" ] && ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    bb_die "--version must look like 1.5.0 (got '$version')"
  fi

  # Test mode (CI only). The base-URL and public-key overrides exist so CI
  # can install a tarball it just built and signed with a throwaway key. They
  # are refused unless BITTERBOT_INSTALL_TEST_MODE=1 is ALSO set, and even
  # then only for a loopback http:// or file:// base URL, so no environment
  # can make this script accept a key other than the pinned one for anything
  # downloaded from the internet.
  if [ -n "${BITTERBOT_INSTALL_BASE_URL:-}" ] || [ -n "${BITTERBOT_INSTALL_TEST_PUBKEY:-}" ]; then
    if [ "${BITTERBOT_INSTALL_TEST_MODE:-}" != "1" ]; then
      bb_die "BITTERBOT_INSTALL_BASE_URL / BITTERBOT_INSTALL_TEST_PUBKEY are test-only and need BITTERBOT_INSTALL_TEST_MODE=1; refusing (production installs always use the pinned key and GitHub Releases)"
    fi
    case ${BITTERBOT_INSTALL_BASE_URL:-} in
      http://127.0.0.1:* | http://localhost:* | file:///*) ;;
      *) bb_die "test mode only accepts a loopback http:// or file:// BITTERBOT_INSTALL_BASE_URL" ;;
    esac
    BB_TEST_MODE=1
    base_url=${BITTERBOT_INSTALL_BASE_URL%/}
    if [ -n "${BITTERBOT_INSTALL_TEST_PUBKEY:-}" ]; then
      pubkey=$BITTERBOT_INSTALL_TEST_PUBKEY
    fi
    bb_warn "TEST MODE: installing from $base_url with a test signing key. This is not a production install."
  fi

  bb_need curl
  bb_need tar
  bb_need uname
  bb_need od
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    bb_die "this installer needs sha256sum or shasum"
  fi

  local platform
  platform=$(bb_detect_platform)

  local download_base
  if [ -n "$version" ]; then
    download_base="$base_url/download/v$version"
  else
    download_base="$base_url/latest/download"
  fi

  # Decide (and announce) the verification level before downloading.
  local sig_tool="none"
  if command -v minisign >/dev/null 2>&1; then
    sig_tool="minisign"
  elif bb_openssl_can_verify; then
    sig_tool="openssl"
  fi
  # Test mode can force a tier so CI exercises each verification path.
  if [ "$BB_TEST_MODE" = "1" ] && [ -n "${BITTERBOT_INSTALL_TEST_VERIFIER:-}" ]; then
    case $BITTERBOT_INSTALL_TEST_VERIFIER in
      minisign | openssl | none) sig_tool=$BITTERBOT_INSTALL_TEST_VERIFIER ;;
      *) bb_die "BITTERBOT_INSTALL_TEST_VERIFIER must be minisign, openssl or none" ;;
    esac
  fi
  local gh_ok=0
  if [ "$BB_TEST_MODE" != "1" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh_ok=1
  fi
  if [ "$sig_tool" = "none" ] && [ "$require_signature" = "1" ]; then
    bb_die "--require-signature: neither minisign nor OpenSSL 3 is available to verify the signature. Install minisign (brew install minisign / apt install minisign) and re-run."
  fi

  local link_dir="${HOME}/.local/bin"
  bb_say "Bitterbot installer"
  bb_say ""
  bb_say "  Release:   ${version:-latest} for $platform"
  bb_say "  From:      $download_base/"
  bb_say "  Install:   $install_dir/<version> (current -> the new version; the previous one is kept)"
  bb_say "  Command:   $link_dir/bitterbot"
  case $sig_tool in
    minisign) bb_say "  Verify:    minisign signature (pinned key) + SHA-256" ;;
    openssl) bb_say "  Verify:    minisign signature checked with OpenSSL 3 (pinned key) + SHA-256" ;;
    none) bb_say "  Verify:    SHA-256 over HTTPS only (install minisign for signature verification)" ;;
  esac
  if [ "$gh_ok" = "1" ]; then
    bb_say "             + GitHub build-provenance attestation (gh attestation verify)"
  fi
  if [ "$with_browser" = "1" ]; then
    bb_say "  Browser:   Playwright Chromium into ~/.bitterbot/browsers (Linux only)"
  fi
  if [ "$onboard" = "1" ]; then
    bb_say "  Then:      bitterbot onboard"
  fi
  bb_say "  Data:      your config and memory stay in ~/.bitterbot (never touched here)"
  bb_say ""
  bb_confirm

  local tmp
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/bitterbot-install.XXXXXX")
  # shellcheck disable=SC2064 # expand $tmp now: it is a local of main()
  trap "rm -rf '$tmp'" EXIT

  bb_say "Downloading checksums.txt and its signature..."
  bb_fetch "$download_base/checksums.txt" "$tmp/checksums.txt" ||
    bb_die "could not download $download_base/checksums.txt (is the release fully published? try again in a few minutes, or pin an older one with --version)"
  bb_fetch "$download_base/checksums.txt.minisig" "$tmp/checksums.txt.minisig" ||
    bb_die "could not download checksums.txt.minisig: every release is signed, so a missing signature is treated as tampering. Refusing."

  # Which version: the pinned one, or the one the checksums file lists for
  # this platform (exactly one entry).
  local tar_re matches
  tar_re="^[0-9a-f]{64}  bitterbot-[0-9]+\\.[0-9]+\\.[0-9]+-${platform}\\.tar\\.gz$"
  matches=$(grep -E "$tar_re" "$tmp/checksums.txt" || true)
  if [ -z "$version" ]; then
    [ "$(printf '%s\n' "$matches" | grep -c .)" = "1" ] ||
      bb_die "checksums.txt does not list exactly one tarball for $platform"
    version=$(printf '%s\n' "$matches" | sed -E "s/^.*  bitterbot-([0-9.]+)-${platform}\\.tar\\.gz$/\\1/")
  fi
  local asset="bitterbot-${version}-${platform}.tar.gz"
  local expected_sha
  expected_sha=$(awk -v f="$asset" '$2 == f {print $1}' "$tmp/checksums.txt")
  [ -n "$expected_sha" ] || bb_die "checksums.txt has no entry for $asset"

  # Signature over checksums.txt, bound to this release by the trusted comment.
  local expected_comment="v${version} checksums" trusted="" level=""
  case $sig_tool in
    minisign)
      minisign -V -P "$pubkey" -m "$tmp/checksums.txt" -x "$tmp/checksums.txt.minisig" >/dev/null ||
        bb_die "checksums.txt signature is INVALID for the pinned key. Refusing to install."
      # minisign has verified the global signature over this line.
      trusted=$(sed -n 's/^trusted comment: //p' "$tmp/checksums.txt.minisig" | head -n 1)
      level="minisign signature (pinned key)"
      ;;
    openssl)
      mkdir "$tmp/ossl"
      trusted=$(bb_openssl_minisign_verify "$tmp/checksums.txt" "$tmp/checksums.txt.minisig" "$pubkey" "$tmp/ossl") ||
        bb_die "checksums.txt signature is INVALID for the pinned key (checked with OpenSSL). Refusing to install."
      level="minisign signature checked with OpenSSL (pinned key)"
      ;;
    none)
      level="SHA-256 only (checksums.txt fetched over HTTPS); signature NOT verified"
      ;;
  esac
  if [ "$sig_tool" != "none" ] && [ "$trusted" != "$expected_comment" ]; then
    bb_die "signature is for '$trusted', not '$expected_comment' (a signature replayed from another release?). Refusing."
  fi

  bb_say "Downloading $asset..."
  bb_fetch "$download_base/$asset" "$tmp/$asset" || bb_die "could not download $asset"
  local actual_sha
  actual_sha=$(bb_sha256 "$tmp/$asset")
  [ "$actual_sha" = "$expected_sha" ] ||
    bb_die "$asset SHA-256 mismatch (expected $expected_sha, got $actual_sha). Refusing."

  if [ "$gh_ok" = "1" ]; then
    gh attestation verify "$tmp/$asset" --repo "$REPO" >/dev/null ||
      bb_die "gh attestation verify FAILED for $asset. Refusing."
    level="$level + GitHub build-provenance attestation"
  fi

  # Unpack next to the install root (same filesystem: the moves are renames).
  mkdir -p "$install_dir"
  local stage top="bitterbot-${version}-${platform}"
  stage=$(mktemp -d "$install_dir/.staging.XXXXXX")
  tar -xzf "$tmp/$asset" -C "$stage" || bb_die "could not unpack $asset"
  [ -x "$stage/$top/bin/bitterbot" ] || bb_die "$asset does not contain $top/bin/bitterbot"
  if ! grep -q "\"version\": \"$version\"" "$stage/$top/manifest.json" ||
    ! grep -q "\"platform\": \"$platform\"" "$stage/$top/manifest.json"; then
    bb_die "$asset manifest.json does not describe $version for $platform"
  fi

  local previous=""
  if [ -L "$install_dir/current" ]; then
    previous=$(readlink "$install_dir/current")
  fi
  local replaced=""
  if [ -e "$install_dir/$version" ]; then
    replaced="$install_dir/.replaced.$version.$$"
    mv "$install_dir/$version" "$replaced"
  fi
  mv "$stage/$top" "$install_dir/$version"
  rmdir "$stage"

  # Switch `current` (atomic rename on GNU coreutils; ln -sfn elsewhere).
  ln -sfn "$version" "$install_dir/current.new"
  if mv --version 2>/dev/null | grep -q GNU; then
    mv -fT "$install_dir/current.new" "$install_dir/current"
  else
    rm -f "$install_dir/current.new"
    ln -sfn "$version" "$install_dir/current"
  fi
  if [ -n "$previous" ] && [ "$previous" != "$version" ] && [ -d "$install_dir/$previous" ]; then
    ln -sfn "$previous" "$install_dir/previous"
  fi
  if [ -n "$replaced" ]; then
    rm -rf "$replaced"
  fi

  # Keep current + previous; older X.Y.Z directories are removed.
  local keep_prev="" entry
  if [ -L "$install_dir/previous" ]; then
    keep_prev=$(readlink "$install_dir/previous")
  fi
  for entry in "$install_dir"/*; do
    if [ ! -d "$entry" ] || [ -L "$entry" ]; then
      continue
    fi
    entry=${entry##*/}
    printf '%s' "$entry" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || continue
    if [ "$entry" != "$version" ] && [ "$entry" != "$keep_prev" ]; then
      bb_say "Removing old version $entry"
      rm -rf "${install_dir:?}/$entry"
    fi
  done

  # ~/.local/bin/bitterbot -> <dir>/current/bin/bitterbot
  local target="$install_dir/current/bin/bitterbot" bin_cmd
  mkdir -p "$link_dir"
  if [ -e "$link_dir/bitterbot" ] && [ ! -L "$link_dir/bitterbot" ]; then
    bb_warn "$link_dir/bitterbot exists and is not a symlink; left it alone. Run $target directly or remove that file and re-run."
    bin_cmd=$target
  else
    ln -sfn "$target" "$link_dir/bitterbot"
    bin_cmd="$link_dir/bitterbot"
  fi

  if [ "$with_browser" = "1" ]; then
    if [ "$platform" = "darwin-arm64" ]; then
      bb_say "--with-browser: skipped on macOS (the browser tool uses an installed Chrome, Brave or Edge)."
    else
      bb_say "Downloading Playwright Chromium into ~/.bitterbot/browsers..."
      mkdir -p "$HOME/.bitterbot/browsers"
      PLAYWRIGHT_BROWSERS_PATH="$HOME/.bitterbot/browsers" \
        "$install_dir/current/runtime/node/bin/node" \
        "$install_dir/current/node_modules/playwright-core/cli.js" install chromium ||
        bb_warn "Chromium download failed; the browser tool can still use a system Chrome. Retry later with --with-browser."
    fi
  fi

  bb_say ""
  bb_say "Installed Bitterbot $version ($platform) in $install_dir/$version"
  bb_say "Verified: $level"
  if [ "$sig_tool" = "none" ]; then
    bb_say "  To check the signature yourself: minisign -Vm checksums.txt -P $PINNED_PUBKEY"
    bb_say "  (from $download_base/), then: sha256sum -c --ignore-missing checksums.txt"
  fi
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    bb_say "Previous version $previous kept at $install_dir/$previous"
  fi
  case ":$PATH:" in
    *":$link_dir:"*) ;;
    *)
      bb_say ""
      bb_say "$link_dir is not on your PATH. Add this line to your shell profile (~/.bashrc, ~/.zshrc):"
      bb_say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac

  if [ "$onboard" = "1" ]; then
    if { : </dev/tty; } 2>/dev/null; then
      bb_say ""
      bb_say "Starting setup: bitterbot onboard"
      "$bin_cmd" onboard </dev/tty || bb_warn "onboarding did not finish; run '$bin_cmd onboard' to resume."
    else
      bb_say "No terminal for setup; run: $bin_cmd onboard"
    fi
  else
    bb_say "Next: $bin_cmd onboard"
  fi
}

main "$@"
