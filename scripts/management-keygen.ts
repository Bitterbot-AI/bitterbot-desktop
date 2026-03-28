#!/usr/bin/env npx tsx
/**
 * Management Node Key Generator
 *
 * Generates an Ed25519 keypair for management node authorization.
 * Outputs the private key (for BITTERBOT_MANAGEMENT_KEY env var)
 * and the public key (for the genesis trust list).
 *
 * Usage:
 *   npx tsx scripts/management-keygen.ts
 *   npx tsx scripts/management-keygen.ts --trust-list-file ~/.bitterbot/genesis-trust.txt
 */
import crypto from "node:crypto";
import fs from "node:fs";

const args = process.argv.slice(2);
const trustListFileIdx = args.indexOf("--trust-list-file");
const trustListFile = trustListFileIdx >= 0 ? args[trustListFileIdx + 1] : null;

// Generate Ed25519 keypair
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

// Extract raw 32-byte seed from PKCS8 DER
const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
const seed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));
const seedBase64 = seed.toString("base64");

// Extract raw 32-byte public key from SPKI DER
const spkiDer = publicKey.export({ format: "der", type: "spki" });
const rawPub = Buffer.from(spkiDer.subarray(12));
const pubBase64 = rawPub.toString("base64");

// Verify round-trip
const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
const testPk = crypto.createPrivateKey({
  key: Buffer.concat([pkcs8Prefix, seed]),
  format: "der",
  type: "pkcs8",
});
const testPub = crypto.createPublicKey(testPk);
const testSpki = testPub.export({ format: "der", type: "spki" });
const testRawPub = Buffer.from(testSpki.subarray(12));
if (testRawPub.toString("base64") !== pubBase64) {
  console.error("ERROR: Round-trip verification failed!");
  process.exit(1);
}

// Sign a test message to verify the key works
const testSig = crypto.sign(null, Buffer.from("keygen-test"), testPk);
const valid = crypto.verify(null, Buffer.from("keygen-test"), testPub, testSig);
if (!valid) {
  console.error("ERROR: Signature verification failed!");
  process.exit(1);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Management Node Ed25519 Keypair Generated");
console.log("═══════════════════════════════════════════════════════════════");
console.log();
console.log("PRIVATE KEY (set as env var — NEVER commit or share):");
console.log(`  export BITTERBOT_MANAGEMENT_KEY="${seedBase64}"`);
console.log();
console.log("PUBLIC KEY (add to genesis trust list):");
console.log(`  ${pubBase64}`);
console.log();

if (trustListFile) {
  // Append to the trust list file
  const dir = trustListFile.substring(0, trustListFile.lastIndexOf("/"));
  if (dir) fs.mkdirSync(dir, { recursive: true });

  const existing = fs.existsSync(trustListFile)
    ? fs.readFileSync(trustListFile, "utf-8")
    : "";
  const lines = existing.split("\n").map((l) => l.trim()).filter(Boolean);

  if (lines.includes(pubBase64)) {
    console.log(`Public key already in ${trustListFile}`);
  } else {
    fs.appendFileSync(trustListFile, `${pubBase64}\n`);
    console.log(`Public key appended to ${trustListFile}`);
  }
} else {
  console.log("To add to a trust list file:");
  console.log(`  echo "${pubBase64}" >> ~/.bitterbot/genesis-trust.txt`);
}

console.log();
console.log("Config (bitterbot.yaml):");
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
