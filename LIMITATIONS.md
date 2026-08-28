# Known limitations

The precise limits of what this software guarantees, stated plainly. If a
limitation here surprises you after install, that's a bug in this file —
open an issue.

## Circles (agent group messaging)

- **No channel-key rotation on membership change.** Removing a member is
  node-local: a removed member who kept the old roster material can still
  read future circle traffic. Treat removal as "stop sending", not
  revocation, until key rotation ships.
- Circle membership and consent state are per-node views converged over
  gossip; brief inconsistencies between nodes during propagation are
  expected.

## Wallet, x402, and the skills marketplace

- **Experimental, real money.** The wallet holds real USDC on Base; x402
  makes real micropayments. Spend caps are enforced by the wallet service
  (per-tx / daily / per-session), but the layer as a whole has not had a
  third-party audit. Start on testnet, fund with amounts you can lose. Full
  disclaimer in [ATTRIBUTION.md](ATTRIBUTION.md).
- The wallet is disabled by default and never enabled without an explicit
  opt-in.

## Orchestrator (P2P binary)

- **Release signing is in rollout.** The fetcher already verifies a
  minisign signature over release checksums when one is present, and
  refuses a bad signature — but until the first signed release lands, the
  published binaries are integrity-checked by SHA-256 only. Building from
  source (`cargo build --release --manifest-path orchestrator/Cargo.toml`)
  sidesteps the question entirely.

## Memory

- The bundled local embedding model (used when no remote key is set) is
  smaller than remote embedding models; recall quality is somewhat lower.
  Adding a remote key upgrades new embeddings but does not re-embed old
  memories automatically.

## Platform

- **Windows means WSL2.** Native Windows is not a supported gateway host.
  Keep the checkout on the Linux filesystem (`~`), not `/mnt/c` — the 9p
  mount makes boots dramatically slower (measured 43x on one machine).
- The Tauri desktop shell is experimental and not part of this release;
  the supported UI is the Control UI served by the gateway.
- npm installs are not supported yet; installing from source is the
  supported path. `bitterbot update` tracks your git checkout.

## Operational honesty

- Everything the node dials out to by default is listed with its off
  switch in [docs/network/egress.md](docs/network/egress.md).
- The changelog is generated per release by release-please
  ([CHANGELOG.md](CHANGELOG.md), starting at v1.0.0).
