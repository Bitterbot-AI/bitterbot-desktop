# Known limitations

The places where this software does less than it appears to, stated plainly.
If a limitation here surprises you after install, that's a bug in this file:
open an issue.

## Circles (agent group messaging)

- **Removing a member does not fully cut them off.** Removal is node-local.
  Your node rotates its own sender key when you remove someone, so they can no
  longer read what you send. They can still read what other members send until
  each of those members applies the removal too, and nothing forces them to.
  Treat removal as "stop sending", not revocation.
- Circle membership and consent state are per-node views converged over
  gossip; brief inconsistencies between nodes during propagation are
  expected.

## Wallet, x402, and the skills marketplace

- **Experimental, real money.** The wallet holds real USDC on Base; x402
  makes real micropayments. The layer as a whole has not had a third-party
  audit. Start on testnet, fund with amounts you can lose. Full disclaimer in
  [ATTRIBUTION.md](ATTRIBUTION.md).
- **Approval covers money, public posts and first contact, not everything.** Every wallet send and x402
  payment waits for your approval unless a spend grant you signed covers it
  (`review.spend`, see [Action review](docs/tools/action-review.md)); spend
  caps still apply underneath. A paid task for another agent is held the
  same way when its price comes back. Only owner senders get the tools that
  move money. Payouts already owed to others (royalties, bounties) are not
  held: they are limited, recorded and reported to you.
  The first message the agent addresses to someone it has never dealt with
  also waits for you (`review.contact`); later messages to that recipient,
  shell commands and file writes do not go through this review.
- The wallet is disabled by default and never enabled without an explicit
  opt-in.
- **The marketplace is early.** It is off by default, few nodes have it
  enabled, and it has not carried meaningful paid volume. Bounties are off by
  default.
- **Spend caps have gaps.** The per-session spend cap is kept in memory and
  resets when the gateway restarts (the daily wallet limit does not). Card
  purchases (Link, Privacy.com) count toward the session cap and their own
  per-purchase cap, not the wallet's daily limit.
- **Card purchases.** Link and Privacy.com cards are typed only into a browser
  tab on the approved merchant's registrable domain, which on shared hosting
  domains also matches other tenants. With `review.spend: "allow"`, Privacy cards
  are created without asking. A Privacy card left unused is closed after about a
  day, checked at most hourly while the gateway is in use. Card-data scrubbing is
  pattern-based and can miss an unlabeled security code.
- **Selling over x402.** Unsigned payment proofs are rejected by default.
  `a2a.payment.allowUnsignedProofs: true` accepts them for old clients, but then
  anyone who sees a payment to your wallet on-chain can redeem it first.

## Memory and identity

- **Your prompts go where your model is.** Memory lives on your disk. With a
  cloud model provider, each prompt (including the memories recalled into it)
  is sent to that provider. Only a local model keeps it on the machine.
- **Memory governance is not active.** The code for sensitivity tagging,
  per-memory TTL and access control exists, but nothing calls it: every
  memory is treated the same. What does work: the Memory tab (and the
  `memory.*` RPCs) let you view, edit, forget and export individual memories,
  retire settled facts and remove learned preferences, and a forget or
  retire you make is not undone by re-extraction, dream promotion or the
  agent's own pins. Memories indexed from files and transcripts are still
  read-only there, and forgetting a memory does not yet remove the facts,
  graph links or dream insights derived from it.
- **Changing the embedding provider, model or API key rebuilds the index.**
  Memories that come from files are re-embedded. Extracted facts, dream
  insights and notes are carried over as stored, not re-embedded with the new
  model.
- The bundled local embedding model (used when no remote key is set) is
  smaller than remote embedding models; recall quality is somewhat lower.
- **The Genome guard covers tool calls.** The agent's tools cannot leave
  `GENOME.md` changed. A process the agent left running in the background
  that writes the file after its tool call returned is not caught. An edit
  you save in an external editor while a tool call is in flight is rolled
  back with it (your version is kept under `~/.bitterbot/genome-guard/`);
  save through the Control UI, or while the agent is idle.
- Several dream modes are off until a node has enough data to feed them, and
  the internal exploration mode is opt-in. Curiosity research (the agent
  looking up its own questions on the web) is on by default when a web search
  provider is configured; it never asks first, and the Curiosity page is where
  you see what it did and pause it. Only a topic phrase leaves the node, never
  the question, but a search provider still sees that phrase. See the table in
  the [README](README.md#the-dream-engine).

## Execution and isolation

- **The sandbox is off by default.** Tools run on the host with your user's
  permissions unless you turn on `agents.defaults.sandbox`. The code
  interpreter's Python runs as the host `python3`.
- **Owner-only tools are a filter, not a boundary.** The browser, code,
  wallet and gateway tools are withheld from senders who are not owners, but
  `exec` is not: a sender you allow who can make the agent run shell commands
  on the host can reach whatever your user account can. Sandbox senders you
  do not fully trust.
- The browser tool drives a real Chromium profile that all agents on the node
  share.
- `agents.defaults.compaction.mode: "safeguard"` and
  `agents.defaults.contextPruning` are accepted by the config and have no
  effect.

## Automations

- **A failed scheduled job does not tell you.** The failure is recorded in the
  job's run history and the log (and sent to the webhook if you set one), but
  nothing is sent to your chat.
- Scheduled jobs and dream cycles only run while the gateway is running. A
  one-shot job whose time passed in the meantime runs late, after the next
  start, if it is at most 7 days late; older ones stay unrun. A one-shot that
  was interrupted mid-run by a restart is not run again.

## Orchestrator (P2P binary)

- **Signature verification is off until the public key is pinned.**
  Orchestrator releases (since `orchestrator-v0.2.3`) are signed: every
  release carries `checksums.txt.minisig`, and the binaries carry GitHub
  build-provenance attestations (`gh attestation verify`). The postinstall
  fetcher verifies the minisign signature and refuses a bad, missing or
  replayed one, but only once the public key is pinned in
  `scripts/orchestrator-signature.mjs` (or, until the repo pins one, set in
  `BITTERBOT_ORCHESTRATOR_MINISIGN_PUBKEY`). Until then it says so in one
  warning (`signature not verified (no pinned key)`) and the published
  binaries are integrity-checked by SHA-256 only. Building from source
  (`cargo build --release --manifest-path orchestrator/Cargo.toml`)
  sidesteps the question entirely.

## Platform

- **Windows means WSL2.** Native Windows is not a supported gateway host.
  Keep the checkout on the Linux filesystem (`~`), not `/mnt/c`: the 9p
  mount makes boots dramatically slower (measured 43x on one machine).
- The Tauri desktop shell is experimental and not part of this release;
  the supported UI is the Control UI served by the gateway.
- npm installs are not supported yet; installing from source is the
  supported path. `bitterbot update` tracks your git checkout.

## Operational honesty

- Everything the node dials out to or publishes by default, and what it
  listens on, is listed with its off switch in
  [docs/network/egress.md](docs/network/egress.md).
- The changelog is generated per release by release-please
  ([CHANGELOG.md](CHANGELOG.md), starting at v1.0.0).
