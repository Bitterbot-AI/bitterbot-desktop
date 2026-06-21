#!/usr/bin/env node
// Deterministic conformance test-vector generator for aubaine/v1.
// Pure node:crypto (Ed25519 + SHA-256), no external deps. Run:
//   node docs/protocol/aubaine-v1/tools/gen-test-vectors.mjs
// It (re)writes ../test-vectors/*.json byte-for-byte. A conformant implementation
// MUST reproduce these exactly. See SPEC.md §3.1, §8, §10.

import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL = "aubaine/v1";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-vectors");

// ---- JCS (RFC 8785) minimal canonicalizer: sorted keys, no whitespace. ----
// Sufficient for these vectors (string/number/bool/null/object/array, finite ints/decimals).
function jcs(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(jcs).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).toSorted();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(value[k])).join(",") + "}";
  }
  throw new Error("unsupported JCS value: " + typeof value);
}

// ---- Deterministic Ed25519 key from a fixed seed (PKCS8 DER prefix + 32-byte seed). ----
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function keyFromSeedLabel(label) {
  const seed = createHash("sha256")
    .update("aubaine/v1 test seed: " + label)
    .digest(); // 32 bytes
  const priv = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" }); // 44 bytes, last 32 = raw pubkey
  const pubRaw = spki.subarray(spki.length - 32);
  return { priv, pubHex: pubRaw.toString("hex") };
}

function signEnvelope(envWithoutSig, priv) {
  const preimage = Buffer.from(PROTOCOL + "\n" + jcs(envWithoutSig), "utf8");
  return edSign(null, preimage, priv).toString("hex");
}

// ---- §8 SKU canonicalization ----
function normalizeSpec(v) {
  if (typeof v === "string") return v.trim().toLowerCase();
  if (Array.isArray(v)) return v.map(normalizeSpec);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) {
      const nv = normalizeSpec(v[k]);
      if (nv === null || nv === "") continue; // drop null/empty
      out[k] = nv;
    }
    return out;
  }
  return v;
}
function skuCanonical(spec) {
  return (
    "sha256:" +
    createHash("sha256")
      .update(jcs(normalizeSpec(spec)), "utf8")
      .digest("hex")
  );
}

mkdirSync(OUT, { recursive: true });
const write = (name, obj) => writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2) + "\n");

// === Vector 1: SKU canonicalization ===
const spec = {
  category: "keycap-set",
  profile: "Cherry",
  material: "  PBT  ",
  colorway: "Nautilus",
  version: 1,
  legends: "Doubleshot",
  empty_field: "",
};
const expectedSku = skuCanonical(spec);
write("sku-canonicalization.json", {
  protocol: PROTOCOL,
  note: "normalize = recursively trim+lowercase strings, drop null/empty; then JCS; then SHA-256; prefix 'sha256:'. SPEC.md §8.",
  cases: [
    {
      structured_spec: spec,
      normalized: normalizeSpec(spec),
      jcs_of_normalized: jcs(normalizeSpec(spec)),
      sku_canonical: expectedSku,
    },
    {
      note: "Same spec, keys reordered + different casing/whitespace -> identical hash (proves canonicalization).",
      structured_spec: {
        version: 1,
        colorway: "NAUTILUS",
        category: "Keycap-Set",
        legends: "doubleshot",
        profile: "cherry",
        material: "pbt",
      },
      sku_canonical: skuCanonical({
        version: 1,
        colorway: "NAUTILUS",
        category: "Keycap-Set",
        legends: "doubleshot",
        profile: "cherry",
        material: "pbt",
      }),
    },
  ],
});

// === Vector 2: Envelope signing (intent) ===
const buyer = keyFromSeedLabel("buyer-A");
const intentEnvNoSig = {
  protocol: PROTOCOL,
  type: "intent",
  id: "11111111-1111-4111-8111-111111111111",
  author_pubkey: "ed25519:" + buyer.pubHex,
  ts: 1718900000,
  body: {
    sku_canonical: expectedSku,
    sku_description: "Cherry-profile PBT keycap set, 'Nautilus' colorway v1, doubleshot legends",
    max_price_usdc: 65,
    qty: 1,
    lead_time_max_days: 140,
    expires_at: 1721492000,
    mandate: {
      max_total_usdc: 65,
      settlement: "eip3009",
      buyer_wallet: "0xabc0000000000000000000000000000000000abc",
      chain: "base",
      token: "usdc",
    },
  },
};
const intentSig = signEnvelope(intentEnvNoSig, buyer.priv);
write("envelope-signing.json", {
  protocol: PROTOCOL,
  note: "preimage = utf8('aubaine/v1' + '\\n' + JCS(envelope-without-signature)); Ed25519 sign; signature = lowerhex(64-byte sig). SPEC.md §3.1.",
  test_private_key_seed: "sha256('aubaine/v1 test seed: buyer-A') as Ed25519 seed",
  preimage_utf8: PROTOCOL + "\n" + jcs(intentEnvNoSig),
  envelope: { ...intentEnvNoSig, signature: intentSig },
});

// === Vector 3: SettlementReceipt signing (supplier rates buyer) ===
const supplier = keyFromSeedLabel("supplier-X");
const receiptEnvNoSig = {
  protocol: PROTOCOL,
  type: "settlement_receipt",
  id: "22222222-2222-4222-8222-222222222222",
  author_pubkey: "ed25519:" + supplier.pubHex,
  ts: 1718900500,
  body: {
    syndicate_id: "synd-0001",
    counterparty_pubkey: "ed25519:" + buyer.pubHex,
    role: "buyer",
    amount_usdc: 38,
    outcome: "settled",
    tx_hash: "0x" + "ab".repeat(32),
    ts: 1718900500,
  },
};
const receiptSig = signEnvelope(receiptEnvNoSig, supplier.priv);
write("settlement-receipt.json", {
  protocol: PROTOCOL,
  note: "A receipt is itself a signed Envelope (§4.5). Anyone verifies it against author_pubkey without trusting the issuer.",
  envelope: { ...receiptEnvNoSig, signature: receiptSig },
});

console.log("wrote test vectors to", OUT);
console.log("sku_canonical:", expectedSku);
console.log("intent signature:", intentSig);
console.log("receipt signature:", receiptSig);
