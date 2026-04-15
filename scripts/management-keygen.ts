#!/usr/bin/env npx tsx
/**
 * Management Node Identity Helper
 *
 * The orchestrator's libp2p Ed25519 keypair IS the management-node identity.
 * This script reads that keypair (at `keys/node.pub`, generated on first
 * orchestrator start) and outputs the base64 pubkey for the genesis trust
 * list, optionally appending it to a trust list file.
 *
 * No new key material is generated — the orchestrator owns its private key.
 *
 * Usage:
 *   npx tsx scripts/management-keygen.ts
 *   npx tsx scripts/management-keygen.ts --key-dir /path/to/keys
 *   npx tsx scripts/management-keygen.ts --trust-list-file ~/.bitterbot/genesis-trust.txt
 *
 * Flags:
 *   --key-dir <path>           Directory containing node.key/node.pub.
 *                              Defaults to ./keys (the orchestrator's default).
 *   --trust-list-file <path>   Append the pubkey to this file (creates if missing).
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function argValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx === args.length - 1) {
    return null;
  }
  return args[idx + 1] ?? null;
}

const keyDir = argValue("--key-dir") ?? "./keys";
const trustListFile = argValue("--trust-list-file");

const pubPath = path.join(keyDir, "node.pub");

if (!fs.existsSync(pubPath)) {
  console.error(`ERROR: No orchestrator pubkey found at ${pubPath}`);
  console.error();
  console.error("The orchestrator generates its keypair on first start. To generate it:");
  console.error("  1. Build the orchestrator:");
  console.error("       cargo build --release --manifest-path orchestrator/Cargo.toml");
  console.error("  2. Run it once to create the keys:");
  console.error(`       ./orchestrator/target/release/bitterbot-orchestrator --key-dir ${keyDir}`);
  console.error('     (Ctrl+C after it prints "Local peer ID: ...")');
  console.error();
  console.error("Then re-run this script.");
  process.exit(1);
}

// The orchestrator stores the pubkey as raw 32 bytes.
const pubBytes = fs.readFileSync(pubPath);
if (pubBytes.length !== 32) {
  console.error(
    `ERROR: ${pubPath} is ${pubBytes.length} bytes; expected 32 (raw Ed25519 public key)`,
  );
  console.error("The file may be corrupt or from a different keypair format.");
  process.exit(1);
}

const pubBase64 = pubBytes.toString("base64");

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Orchestrator Management Identity");
console.log("═══════════════════════════════════════════════════════════════");
console.log();
console.log(`Key directory: ${path.resolve(keyDir)}`);
console.log();
console.log("PUBLIC KEY (add to genesis trust list):");
console.log(`  ${pubBase64}`);
console.log();

if (trustListFile) {
  const dir = path.dirname(trustListFile);
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existing = fs.existsSync(trustListFile) ? fs.readFileSync(trustListFile, "utf-8") : "";
  const lines = existing
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.includes(pubBase64)) {
    console.log(`Public key already in ${trustListFile}`);
  } else {
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(trustListFile, `${separator}${pubBase64}\n`);
    console.log(`Public key appended to ${trustListFile}`);
  }
} else {
  console.log("To add to a trust list file:");
  console.log(`  echo "${pubBase64}" >> ~/.bitterbot/genesis-trust.txt`);
}

console.log();
console.log("Config (bitterbot.json):");
console.log("  p2p:");
console.log('    nodeTier: "management"');
if (trustListFile) {
  console.log(`    genesisTrustListPath: "${trustListFile}"`);
} else {
  console.log('    genesisTrustListPath: "~/.bitterbot/genesis-trust.txt"');
}
console.log("    # OR inline:");
console.log("    genesisTrustList:");
console.log(`      - "${pubBase64}"`);
console.log();
console.log("Notes:");
console.log("  - The orchestrator's private key (node.key) signs management broadcasts.");
console.log("  - Never copy node.key off the machine running the management node.");
console.log("  - To rotate the key, delete both node.key and node.pub and restart the");
console.log("    orchestrator. The new pubkey must be added to the trust list.");
console.log();
