#!/usr/bin/env bash
#
# Bitterbot installer (PLAN-56 Phase 3a).
#
#   curl -fsSL https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version 1.5.0 --no-onboard
#
# The script is served from main (always available, whatever state the newest
# release is in) and is also attached to every release for pinned installs.
# It embeds the pinned public key, so it is exactly as trustworthy as main.
#
# What it does, in order (it prints this plan before touching anything):
#   1. Detects your OS/arch (Linux x64/arm64 with glibc >= 2.28, macOS Apple
#      silicon). Refuses to run as root unless --allow-root.
#   2. Without --version, asks the GitHub releases API for the newest release
#      that carries this platform's tarball AND checksums.txt AND its .minisig
#      (a release whose assets are still being built is skipped). Then
#      downloads those three files from releases/download/v<version>/.
#   3. Verifies checksums.txt against the minisign public key PINNED below
#      (with `minisign`, or OpenSSL 3 when minisign is absent), requires the
#      signed trusted comment to name this exact release, then checks the
#      tarball's SHA-256. Without either tool it says so and falls back to
#      SHA-256 over HTTPS (plus `gh attestation verify` when gh is logged in);
#      pass --require-signature to refuse that fallback.
#   4. Unpacks to <dir>/<version>, switches <dir>/current to it, keeps the
#      previous version (for rollback), links ~/.local/bin/bitterbot.
#   5. If an older Bitterbot is running (a git clone started with pnpm, an
#      older release) or set up as a background service, offers to switch it
#      to the new version: `bitterbot gateway switch` stops the old gateway,
#      points the service at the new one, waits until it answers, and puts
#      the old one back if it does not. Asked once (default yes); --yes
#      switches without asking; --no-switch leaves it alone. Your config,
#      memory and keys in ~/.bitterbot are never touched.
#   6. Runs `bitterbot onboard` (skip with --no-onboard): the setup page, or
#      the Control UI link when Bitterbot is already set up.
#
# Everything lives in functions and the only top-level command is the last
# line, so a partially downloaded script runs nothing.
#
# Read it first: curl -fsSL <url> | less

bb_usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  -s, --version X.Y.Z    Install this release instead of the newest complete one
      --dir PATH         Install root (default: ~/.bitterbot/app)
      --allow-root       Allow installing as root (not recommended)
      --no-onboard       Do not run `bitterbot onboard` afterwards
      --no-switch        Leave a running older Bitterbot (git clone, older
                         release) and its background service alone
  -y, --yes              Do not ask for confirmation (also switches a running
                         older Bitterbot to the new version)
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

# curl flags. Production: HTTPS only, redirects too (GitHub serves assets
# through a redirect). Test mode: http/file only, no redirects at all, no
# proxy, so a loopback URL can never be bounced somewhere else.
bb_curl() {
  if [ "$BB_TEST_MODE" = "1" ]; then
    curl -sSL --max-redirs 0 --proto '=http,file' --proto-redir '=http,file' --noproxy '*' "$@"
  else
    curl -sSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 "$@"
  fi
}

# Download $1 to $2, failing on HTTP errors.
bb_fetch() {
  bb_curl -f -o "$2" "$1"
}

# Newest complete release for platform $2 from a GitHub releases API listing
# in file $1: tag vX.Y.Z, not draft, not prerelease, with the platform
# tarball, checksums.txt and checksums.txt.minisig among its assets. Mirrors
# pickLatestTarballRelease() in src/infra/update-check.ts. Works on compact or
# pretty JSON: only the tag_name/draft/prerelease/browser_download_url
# key-value pairs are read (in a release body they would be escaped).
bb_pick_latest() {
  { grep -oE '"(tag_name|draft|prerelease|browser_download_url)": *("[^"]*"|true|false)' "$1" || true; } |
    awk -v plat="$2" '
      function key(s) { sub(/^"/, "", s); sub(/".*$/, "", s); return s }
      function val(s) { sub(/^"[^"]*": */, "", s); gsub(/"/, "", s); return s }
      function newer(a, b,   x, y, i) {
        if (b == "") return 1
        split(a, x, "."); split(b, y, ".")
        for (i = 1; i <= 3; i++) {
          if (x[i] + 0 > y[i] + 0) return 1
          if (x[i] + 0 < y[i] + 0) return 0
        }
        return 0
      }
      {
        k = key($0); v = val($0)
        if (k == "tag_name") { cur = v; tags[v] = 1 }
        else if ((k == "draft" || k == "prerelease") && v == "true") { bad[cur] = 1 }
        else if (k == "browser_download_url" && match(v, /\/releases\/download\/[^\/]+\/[^\/]+$/)) {
          n = split(substr(v, RSTART), parts, "/")
          has[parts[n - 1] SUBSEP parts[n]] = 1
        }
      }
      END {
        best = ""
        for (t in tags) {
          if (t !~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ || (t in bad)) continue
          ver = substr(t, 2)
          if (!((t SUBSEP "bitterbot-" ver "-" plat ".tar.gz") in has)) continue
          if (!((t SUBSEP "checksums.txt") in has)) continue
          if (!((t SUBSEP "checksums.txt.minisig") in has)) continue
          if (newer(ver, best)) best = ver
        }
        if (best != "") print best
      }'
}

# glibc version as "MAJOR.MINOR" (empty when unknown).
bb_glibc_version() {
  local v
  v=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
  v=${v##* }
  if [ -z "$v" ]; then
    v=$( (ldd --version 2>&1 || true) | head -n 1)
    v=${v##* }
  fi
  if [[ $v =~ ^[0-9]+\.[0-9]+ ]]; then
    printf '%s\n' "${BASH_REMATCH[0]}"
  fi
}

# Is version directory $1 in use? Prints a pid and returns 0 when a process
# started by its launcher is alive (pid markers in $1/.pids) or, on Linux,
# when any process we can see has its executable or cwd inside it.
bb_version_in_use() {
  local dir=$1 f pid p l t
  if [ -d "$dir/.pids" ]; then
    for f in "$dir/.pids"/*; do
      [ -e "$f" ] || continue
      pid=${f##*/}
      case $pid in
        '' | *[!0-9]*) continue ;;
      esac
      if kill -0 "$pid" 2>/dev/null; then
        printf '%s\n' "$pid"
        return 0
      fi
      rm -f "$f"
    done
  fi
  if [ -d /proc/self ]; then
    for p in /proc/[0-9]*; do
      for l in exe cwd; do
        t=$(readlink "$p/$l" 2>/dev/null) || continue
        case $t in
          "$dir" | "$dir"/*)
            printf '%s\n' "${p#/proc/}"
            return 0
            ;;
        esac
      done
    done
  fi
  return 1
}

# Check every file listed in $1/manifest.json against its sha256.
bb_verify_manifest() {
  local dir=$1 list
  list=$(mktemp "${TMPDIR:-/tmp}/bitterbot-manifest.XXXXXX")
  awk '
    /^ *"path": "/ { p = $0; sub(/^ *"path": "/, "", p); sub(/",?$/, "", p); next }
    /^ *"sha256": "[0-9a-f]+"/ { h = $0; sub(/^ *"sha256": "/, "", h); sub(/",?$/, "", h); if (p != "") print h "  " p; p = ""; next }
  ' "$dir/manifest.json" >"$list"
  local rc=0
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum --status -c "$list") || rc=1
  else
    (cd "$dir" && shasum -a 256 --status -c "$list") || rc=1
  fi
  rm -f "$list"
  return $rc
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
      # `ldd --version` exits non-zero on musl, so read its output, not its status.
      case "$(ldd --version 2>&1 || true)" in
        *musl*)
          bb_die "musl-based Linux (e.g. Alpine) is not supported by the release tarball. Use Docker: https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/docker.md"
          ;;
      esac
      local glibc
      glibc=$(bb_glibc_version)
      if [ -n "$glibc" ]; then
        local gmaj=${glibc%%.*} gmin=${glibc#*.}
        if [ "$gmaj" -lt 2 ] || { [ "$gmaj" -eq 2 ] && [ "$gmin" -lt 28 ]; }; then
          bb_die "glibc $glibc is too old: the bundled Node 22 needs glibc 2.28 or newer (Debian 10, Ubuntu 18.10, RHEL 8 or later). Use Docker: https://github.com/Bitterbot-AI/bitterbot-desktop/blob/main/docs/platforms/docker.md"
        fi
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

# Offer to switch a running (or service-installed) older Bitterbot to the
# version just installed, through `bitterbot gateway switch` (exit codes in
# src/cli/daemon-cli/switch.ts). Sets BB_SWITCH_STATE to none, switched,
# declined, pending (no terminal to ask on), blocked or failed.
bb_switch_gateway() {
  local bin=$1 version=$2 summary rc=0 answer
  BB_SWITCH_STATE=none
  summary=$("$bin" gateway switch --check 2>&1) || rc=$?
  case $rc in
    0) return 0 ;;
    10) ;;
    2)
      bb_say ""
      bb_say "$summary"
      BB_SWITCH_STATE=blocked
      return 0
      ;;
    *)
      bb_warn "could not check for a running older Bitterbot (exit $rc). To switch later: $bin gateway switch"
      BB_SWITCH_STATE=pending
      return 0
      ;;
  esac
  bb_say ""
  bb_say "$summary"
  if [ "$BB_YES" != "1" ]; then
    if ! { : </dev/tty; } 2>/dev/null; then
      bb_say "To switch to $version, run: $bin gateway switch"
      BB_SWITCH_STATE=pending
      return 0
    fi
    printf 'Switch to %s now? [Y/n] ' "$version" >/dev/tty
    read -r answer </dev/tty || answer=""
    case $answer in
      n | N | no | NO | No)
        bb_say "Left it as it is. To switch later: $bin gateway switch"
        BB_SWITCH_STATE=declined
        return 0
        ;;
    esac
  fi
  rc=0
  "$bin" gateway switch --yes || rc=$?
  if [ "$rc" = "0" ]; then
    BB_SWITCH_STATE=switched
  else
    BB_SWITCH_STATE=failed
    bb_warn "the switch to $version did not complete (exit $rc); see above. Retry with: $bin gateway switch"
  fi
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
  local require_signature=0 allow_root=0 switch=1
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
      --no-switch)
        switch=0
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
      --allow-root)
        allow_root=1
        shift
        ;;
      -h | --help)
        bb_usage
        return 0
        ;;
      *) bb_die "unknown option: $1 (see --help)" ;;
    esac
  done
  # Whole-string match (a grep would accept "1.5.0<newline>anything").
  if [ -n "$version" ] && ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    bb_die "--version must look like 1.5.0 (got '$version')"
  fi
  case $install_dir in
    /*) ;;
    *) install_dir="$PWD/$install_dir" ;;
  esac
  if [ "$(id -u)" = "0" ] && [ "$allow_root" != "1" ]; then
    bb_die "refusing to install as root: Bitterbot runs as your user and keeps its data in ~/.bitterbot. Re-run as your normal user (no sudo), or pass --allow-root if you really mean it."
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
    local test_url=${BITTERBOT_INSTALL_BASE_URL:-}
    case $test_url in
      *@*) bb_die "test mode refuses a BITTERBOT_INSTALL_BASE_URL with '@' (userinfo)" ;;
    esac
    if ! [[ $test_url =~ ^http://(127\.0\.0\.1|localhost):[0-9]+(/|$) ]] &&
      ! [[ $test_url =~ ^file:/// ]]; then
      bb_die "test mode only accepts a loopback http://127.0.0.1:<port> / http://localhost:<port> or file:/// BITTERBOT_INSTALL_BASE_URL"
    fi
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

  # The releases API (test mode: a JSON file next to the fake releases).
  local api_url="https://api.github.com/repos/${REPO}/releases?per_page=30"
  if [ "$BB_TEST_MODE" = "1" ]; then
    api_url="$base_url/api/releases.json"
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
  bb_say "  Release:   ${version:-newest complete release} for $platform"
  bb_say "  From:      $base_url/download/v${version:-<version>}/"
  bb_say "  Install:   $install_dir/<version> (current -> the new version; the previous one is kept)"
  bb_say "  Command:   $link_dir/bitterbot"
  case $sig_tool in
    minisign) bb_say "  Verify:    minisign signature (pinned key) + SHA-256" ;;
    openssl) bb_say "  Verify:    minisign signature checked with OpenSSL 3 (pinned key) + SHA-256" ;;
    none) bb_say "  Verify:    SHA-256 over HTTPS only (install minisign for signature verification)" ;;
  esac
  local link_now=""
  if [ -L "$link_dir/bitterbot" ]; then
    link_now=$(readlink "$link_dir/bitterbot")
    case $link_now in
      "$install_dir"/*) link_now="" ;;
    esac
  fi
  if [ -n "$link_now" ]; then
    bb_say "             (replaces the existing link to $link_now)"
  fi
  if [ "$gh_ok" = "1" ]; then
    bb_say "             + GitHub build-provenance attestation (gh attestation verify)"
  fi
  if [ "$with_browser" = "1" ]; then
    bb_say "  Browser:   Playwright Chromium into ~/.bitterbot/browsers (Linux only)"
  fi
  if [ "$switch" = "0" ]; then
    bb_say "  Switch:    a running older Bitterbot is left alone (--no-switch)"
  elif [ "$BB_YES" = "1" ]; then
    bb_say "  Switch:    a running older Bitterbot (git clone or older release) is switched to the new version"
  else
    bb_say "  Switch:    if an older Bitterbot is running, you are asked whether to switch it to the new version"
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

  if [ -z "$version" ]; then
    bb_say "Looking up the newest complete release..."
    local code
    code=$(bb_curl -o "$tmp/releases.json" -w '%{http_code}' -H 'Accept: application/vnd.github+json' "$api_url") ||
      bb_die "could not reach the GitHub releases API ($api_url). Check your connection, or pin a release with --version X.Y.Z."
    case $code in
      200 | 000) ;;
      403 | 429) bb_die "the GitHub releases API refused the request (HTTP $code; unauthenticated requests are limited to 60 per hour per IP). Wait a while, or pin a release with --version X.Y.Z." ;;
      *) bb_die "the GitHub releases API answered HTTP $code. Try again later, or pin a release with --version X.Y.Z." ;;
    esac
    version=$(bb_pick_latest "$tmp/releases.json" "$platform")
    [ -n "$version" ] ||
      bb_die "no published release carries a signed tarball for $platform yet. Use Docker, or try again after the next release."
    bb_say "Newest complete release: $version"
  fi
  local download_base="$base_url/download/v$version"

  bb_say "Downloading checksums.txt and its signature..."
  bb_fetch "$download_base/checksums.txt" "$tmp/checksums.txt" ||
    bb_die "could not download $download_base/checksums.txt (does release v$version have tarballs? each release's tarballs are attached after a maintainer approves the signing step)"
  bb_fetch "$download_base/checksums.txt.minisig" "$tmp/checksums.txt.minisig" ||
    bb_die "could not download checksums.txt.minisig: every release is signed, so a missing signature is treated as tampering. Refusing."

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
      level="none"
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
    if [ "$level" = "none" ]; then
      level="GitHub build-provenance attestation + SHA-256 (no minisign signature)"
    else
      level="$level + GitHub build-provenance attestation"
    fi
  fi

  # Unpack next to the install root (same filesystem: the moves are renames).
  mkdir -p "$install_dir"
  install_dir=$(cd "$install_dir" && pwd -P)
  local stage top="bitterbot-${version}-${platform}"
  stage=$(mktemp -d "$install_dir/.staging.XXXXXX")
  # shellcheck disable=SC2064 # expand now: both are locals of main()
  trap "rm -rf '$tmp' '$stage'" EXIT
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
  local replaced="" reuse=0 busy
  if [ -e "$install_dir/$version" ] &&
    cmp -s "$stage/$top/manifest.json" "$install_dir/$version/manifest.json"; then
    # The same build is already unpacked (a gateway may be running from it).
    # Keep it in place if every file still matches the manifest; repair it
    # otherwise.
    if bb_verify_manifest "$install_dir/$version"; then
      bb_say "$version is already installed and intact; keeping it in place"
      reuse=1
      rm -rf "$stage"
    else
      bb_warn "$version is installed but some files differ from its manifest; repairing"
    fi
  fi
  if [ "$reuse" != "1" ]; then
    if [ -e "$install_dir/$version" ]; then
      if busy=$(bb_version_in_use "$install_dir/$version"); then
        bb_die "$install_dir/$version must be replaced but is in use by a running Bitterbot (pid $busy). Stop it (bitterbot gateway stop) and re-run."
      fi
      replaced="$install_dir/.replaced.$version.$$"
      mv "$install_dir/$version" "$replaced"
    fi
    mv "$stage/$top" "$install_dir/$version"
    rmdir "$stage"
  fi

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
      if busy=$(bb_version_in_use "$install_dir/$entry"); then
        bb_say "Keeping old version $entry: in use by pid $busy"
        continue
      fi
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
    # A link pointing outside the install root was announced in the plan
    # above, so it is replaced only after the confirmation (or --yes).
    if [ -n "$link_now" ]; then
      bb_warn "replacing $link_dir/bitterbot (it pointed to $link_now)"
    fi
    ln -sfn "$target" "$link_dir/bitterbot"
    bin_cmd="$link_dir/bitterbot"
  fi
  local first_on_path
  first_on_path=$(command -v bitterbot 2>/dev/null || true)
  if [ -n "$first_on_path" ] && [ "$first_on_path" != "$link_dir/bitterbot" ] &&
    [ "$first_on_path" != "$bin_cmd" ]; then
    bb_warn "another bitterbot comes first on your PATH: $first_on_path. Remove it or put $link_dir earlier in PATH."
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
  if [ "$level" = "none" ]; then
    bb_say "Checked against checksums.txt from the same server (no signature)"
  else
    bb_say "Verified: $level"
  fi
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

  BB_SWITCH_STATE=none
  if [ "$switch" = "1" ]; then
    bb_switch_gateway "$bin_cmd" "$version"
  fi

  case $BB_SWITCH_STATE in
    failed)
      # The switch reported what happened (and put the old one back).
      return 1
      ;;
    declined | pending | blocked)
      bb_say "Next: $bin_cmd gateway switch, then $bin_cmd onboard"
      return 0
      ;;
  esac
  if [ "$onboard" = "1" ]; then
    if { : </dev/tty; } 2>/dev/null; then
      bb_say ""
      bb_say "Starting setup: bitterbot onboard (opens a setup page in your browser, or the Control UI when you are already set up)"
      "$bin_cmd" onboard --from-installer </dev/tty || bb_warn "onboarding did not finish; run '$bin_cmd onboard' to resume."
    else
      bb_say "No terminal for setup; run: $bin_cmd onboard (it prints a setup link)"
    fi
  else
    bb_say "Next: $bin_cmd onboard (opens a setup page in your browser)"
  fi
}

main "$@"
