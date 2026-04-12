#!/usr/bin/env node
/**
 * Preinstall check: fail loudly and actionably before `pnpm install`
 * gets halfway into a broken tree.
 *
 * What it checks:
 *   - Node.js ≥ 22 (hard fail — lots of modern syntax/APIs used throughout)
 *   - Running under pnpm (warn only — npm/yarn can still build, but the
 *     workspace hooks expect pnpm and the docs say pnpm)
 *   - On Linux: presence of build tools + libssl headers that native
 *     deps (better-sqlite3, @lydell/node-pty, @whiskeysockets/baileys,
 *     sharp) need to compile. Warn only — native deps may have prebuilt
 *     binaries that land without a local compile.
 *
 * Exits non-zero only on hard-fail conditions. Everything else is a
 * clearly formatted warning so the user knows what to fix if/when
 * later steps blow up.
 *
 * Skip in CI or controlled environments with BITTERBOT_SKIP_PREINSTALL_CHECK=1.
 */

import { existsSync } from "node:fs";
import os from "node:os";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function log(msg) {
  process.stdout.write(`${CYAN}[preinstall-check]${RESET} ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`${YELLOW}[preinstall-check WARN]${RESET} ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`${RED}[preinstall-check FAIL]${RESET} ${msg}\n`);
}

if (process.env.BITTERBOT_SKIP_PREINSTALL_CHECK) {
  log("skipped via BITTERBOT_SKIP_PREINSTALL_CHECK");
  process.exit(0);
}

let hardFailures = 0;
let warnings = 0;

// ── Node version ──
const MIN_MAJOR = 22;
const actual = process.versions.node;
const [major] = actual.split(".").map((n) => Number.parseInt(n, 10));
if (Number.isNaN(major) || major < MIN_MAJOR) {
  fail(
    `Node.js ${actual} detected. This repo requires Node ≥ ${MIN_MAJOR}.\n` +
      `  Install via nvm: nvm install ${MIN_MAJOR} && nvm use ${MIN_MAJOR}\n` +
      `  Or fnm:          fnm install ${MIN_MAJOR} && fnm use ${MIN_MAJOR}\n` +
      `  Or volta:        volta install node@${MIN_MAJOR}`,
  );
  hardFailures++;
} else {
  log(`Node ${actual} ✓`);
}

// ── Package manager ──
// When this script runs via `pnpm install` preinstall, npm_config_user_agent
// starts with `pnpm/`. Other managers will have a different prefix.
const ua = process.env.npm_config_user_agent ?? "";
const isPnpm = ua.startsWith("pnpm/");
const isNpm = ua.startsWith("npm/");
const isYarn = ua.startsWith("yarn/");
if (isPnpm) {
  log(`pnpm ${ua.split(" ")[0].replace("pnpm/", "")} ✓`);
} else if (isNpm || isYarn) {
  warn(
    `Running under ${isNpm ? "npm" : "yarn"} instead of pnpm. ` +
      `This repo is designed for pnpm workspaces — some scripts may misbehave. ` +
      `Install pnpm via https://pnpm.io/installation and re-run with \`pnpm install\`.`,
  );
  warnings++;
}
// If ua is empty (e.g. direct `node scripts/...`), stay quiet. That's
// either a developer poking at the script or a weird install surface
// we can't meaningfully diagnose.

// ── Linux system deps (warning only) ──
if (process.platform === "linux") {
  const checks = [
    { name: "pkg-config", path: ["/usr/bin/pkg-config", "/usr/local/bin/pkg-config"] },
    {
      name: "libssl-dev headers",
      path: [
        "/usr/include/openssl/ssl.h",
        "/usr/local/include/openssl/ssl.h",
        "/usr/include/x86_64-linux-gnu/openssl/ssl.h",
        "/usr/include/aarch64-linux-gnu/openssl/ssl.h",
      ],
    },
  ];
  const missing = checks.filter((c) => !c.path.some((p) => existsSync(p)));
  if (missing.length > 0) {
    warn(
      `Linux system deps not detected: ${missing.map((m) => m.name).join(", ")}\n` +
        `  Native modules may fall back to prebuilt binaries where available. ` +
        `If you hit a build error later, run:\n` +
        `    bash scripts/setup-deps.sh\n` +
        `  which installs the full dep set (pkg-config, libssl-dev, ffmpeg, chromium deps, ripgrep, etc.)`,
    );
    warnings++;
  } else {
    log("Linux system deps present ✓");
  }
}

// ── Summary ──
if (hardFailures > 0) {
  process.stderr.write(
    `${DIM}[preinstall-check] ${hardFailures} blocking issue(s), aborting install.${RESET}\n`,
  );
  process.exit(1);
}
if (warnings > 0) {
  log(`${warnings} warning(s) — install will continue; review the notes above.`);
} else {
  log(`all checks passed on ${process.platform}/${process.arch} (${os.hostname()})`);
}
process.exit(0);
