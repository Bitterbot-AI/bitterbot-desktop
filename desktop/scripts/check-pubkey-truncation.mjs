#!/usr/bin/env node
// Adapted from block/buzz (Apache-2.0) desktop/scripts/check-pubkey-truncation.mjs
//
// Guard: no hand-rolled pubkey display truncation.
//
// A truncated pubkey prefix is forgeable by vanity-grinding: an attacker can
// mine a keypair whose public key shares the displayed prefix with a trusted
// key, making the truncated form indistinguishable. Display truncation must
// therefore have exactly one home — `truncatePubkey` in
// desktop/renderer/src/lib/pubkey.ts — so the policy (length, ellipsis) can
// be audited and changed in one place.
//
// Flags `.slice(0, N)` / `.substring(0, N)` where the receiver identifier
// contains "pubkey" / "Pubkey" / "publicKey" (case-insensitive), anywhere in
// desktop/renderer/src (.ts/.tsx), except the canonical helper itself.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "renderer", "src");
const EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

// The canonical helper is the only file allowed to truncate a pubkey.
const ALLOWED_FILES = new Set(["desktop/renderer/src/lib/pubkey.ts"]);

// Receiver identifier containing pubkey / pub_key / publickey (any case),
// immediately followed by .slice(0, N) or .substring(0, N).
const PUBKEY_SLICE_RE =
  /\b[\w$]*(pubkey|pub_key|publickey)[\w$]*\??\.(slice|substring)\(\s*0\s*,\s*\d+\s*\)/gi;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return SKIP_DIRS.has(entry.name) ? [] : walk(full);
      }
      return EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
    }),
  );
  return files.flat();
}

const repoRoot = path.resolve(__dirname, "..", "..");
const violations = [];
for (const filePath of await walk(SRC_ROOT)) {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  if (ALLOWED_FILES.has(rel)) continue;

  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    PUBKEY_SLICE_RE.lastIndex = 0;
    const matches = line.match(PUBKEY_SLICE_RE);
    if (!matches) return;
    for (const match of matches) {
      violations.push(`${rel}:${index + 1}: ${match}`);
    }
  });
}

if (violations.length > 0) {
  console.error(`pubkey-truncation check failed (${violations.length} violation(s)):`);
  for (const v of violations) console.error(`- ${v}`);
  console.error(
    "Truncated pubkey prefixes are forgeable by vanity-grinding. Use " +
      "truncatePubkey from desktop/renderer/src/lib/pubkey.ts so the display " +
      "truncation policy has one home.",
  );
  process.exit(1);
}
