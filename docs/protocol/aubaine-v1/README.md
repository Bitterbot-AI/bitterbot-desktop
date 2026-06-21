# Aubaine Protocol — aubaine/v1 (DRAFT)

> **Name locked 2026-06-20: "Aubaine"** (French: _a windfall / a great find_). Clear in
> crypto/web3/AI/software; only food/wine "Aubaine" brands exist (different TM classes). Canonical
> home: **`aubaine.ai`** (acquired 2026-06-20). Before public launch: run a formal trademark
> clearance (classes 9/36/42) and grab social handles. See `docs/plans/PLAN-26` §12.5.

Open, vendor-neutral protocol for AI agents (any framework) to **pool consumer demand into
custom/made-to-order group buys and settle onchain**. Reference implementation: Bitterbot. Nothing
here requires Bitterbot, libp2p, or a specific wallet vendor.

## Minimal participant

An Ed25519 keypair + an EIP-3009-capable EVM wallet on Base + HTTP. That's the whole bar.

## Contents

| Path                         | What                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `SPEC.md`                    | The normative specification (read this first).                    |
| `schemas/`                   | JSON Schemas for the Envelope and every message body.             |
| `.well-known/aubaine.json`   | Capability descriptor a node serves at `/.well-known/`.           |
| `tools/gen-test-vectors.mjs` | Deterministic conformance-vector generator (pure `node:crypto`).  |
| `test-vectors/`              | Generated vectors a conformant impl MUST reproduce byte-for-byte. |

## Reproduce the conformance vectors

```
node tools/gen-test-vectors.mjs
```

Deterministic — same bytes every run, no deps. The current committed vectors:

- `sku-canonicalization.json` — `sha256:2e763a4d2bf3dff4…261849`. Two specs that differ only in key
  order, casing, and whitespace hash identically (proves §8 canonicalization / spec-lock).
- `envelope-signing.json` — a signed `intent` Envelope; verify the Ed25519 signature against
  `author_pubkey` over the documented preimage (§3.1).
- `settlement-receipt.json` — a supplier-signed receipt rating a buyer (§4.5, §9).

## The three things that make it scaffolding-agnostic

1. **Transport-independent Envelopes** (§2–3): same signed JSON over HTTP or gossip; anyone verifies
   without our code.
2. **Signer-agnostic settlement** (§7): EIP-3009 on Base USDC; any wallet. The coordinator is never
   the payee (non-custodial).
3. **Portable reputation** (§9): signed, self-verifying settlement receipts; no required trust system.

## Status

DRAFT. Open questions and phasing live in `docs/plans/PLAN-26-SWARM-COMMERCE-C2M-COORDINATION.md`.
Not yet published externally — finalize the name (§12.5) and run a trademark screen first.
