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
  `memory.*` RPCs, and `bitterbot memory forget|edit|export|import`) let you
  view, edit, forget, export and import memories, retire settled facts and
  remove learned preferences, and a forget or retire you make is not undone
  by re-extraction, dream promotion or the agent's own pins. Forgetting or
  editing a memory cascades (with a preview first): facts left without
  evidence are retired (yours are kept and listed), graph links left without
  evidence are closed, and dream insights drawn from it are flagged.
  Deleting a conversation does the same for what was learned only from it;
  when automatic housekeeping (subagent cleanup, the doctor probe) deletes
  one, facts are retired at the agent's strength, not yours. Memories
  indexed from files are still read-only there (change the file). A memory
  indexed from a conversation can be forgotten, but the transcript line
  itself is not redacted, and the forget matches its exact text (normalised
  for case and punctuation), so the same words cut into a different chunk
  as the transcript grows, or overlapping a neighbouring chunk, can be
  indexed again. A short forgotten passage (under 40 characters or 5
  distinct words) is matched in its own transcript only. `MEMORY.md` and
  scratch notes that repeat a forgotten memory are not rewritten. The export
  (JSON, version 2) carries memories, facts with history, preferences, the
  knowledge graph, dream insights, curiosity findings, open questions,
  suppressions, the audit log, `MEMORY.md` and `GENOME.md`, never embeddings;
  credential-shaped values are redacted by pattern, so a secret in an
  unusual shape can still be in it. An import restores memories, facts and
  preferences only, at the extraction tier and within the ledger's free
  capacity: facts that were yours in the export come back below your tier
  until you pin them, unless you import with `--keep-owner-tier` and confirm
  the exact grants (by the hash a dry run reports). Imported identity and
  directive preferences come back as ordinary ones, at the extraction
  confidence.
- **Corrections are captured in direct owner chats only.** A correction you
  state in chat is pinned at your authority before the next turn, with a
  "Memory updated" line in the reply, but only in a first-party direct chat
  with the owner, and only when the message has a corrective shape (the list
  is in `docs/memory/controls.md`). Group chats, guests and scheduled runs
  are left to the slower dream-time extractor. A fact's project scope is the
  agent's workspace folder name; there is no project model yet, a correction
  is global unless you name that project (a deliberate deviation from the
  plan's "default to the current project"), and person-scoped facts are not
  yet routed per person. When the agent tries to replace or retire a fact
  you or it pinned, the change is held and you are told, but there is no
  one-tap confirm or revert yet: restate the value, or answer the "which is
  current?" question, to settle it.
- **A correction propagates by text match, after the fact.** When a fact
  changes, older memories, the matching learned preference, graph links,
  unused prepared answers, open tasks and dream insights that state the old
  value are updated or flagged, and the next `MEMORY.md` rewrite is told the
  new value. The match is on the old value's exact wording next to a word
  from the key (a paraphrase, or a mention without that word, is missed),
  graph links follow only for keys on a short fixed list of relations, the
  work per change is capped (200 memories, 20 graph links, 200 briefs and
  tasks), memories indexed after the change are not checked against it, and
  corrections made before this release are not propagated retroactively.
  Superseded memories are ranked lower and tagged in the owner's search, not
  hidden.
- **`session.memory = "off"` gates the learners, not the agent.** It stops
  transcript indexing, the session extractor and the correction capture. It
  does not stop `memory_pin`, `working_memory_note`, the pre-compaction
  memory flush or compaction summaries, the transcript is still written to
  disk, and switching back on (or a reindex) indexes those conversations.
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
- `agents.defaults.compaction.mode: "safeguard"`,
  `agents.defaults.contextPruning`, `agents.defaults.runtime.engine` (and
  `agents.list[].runtime.engine`), `update.uiRestart` and `memory.backend` are
  deprecated and have no effect. The gateway warns about each one it finds at
  load, `bitterbot doctor` lists them, and `doctor --fix` removes them (not in
  a config that uses `$include`: remove those by hand). They will be removed in
  the next release.
- `memory.curiosity.autoResearch.enabled` is a live key, not an alias: `true`
  turns on the dream engine's Skill Seekers research step (it also needs
  `skills.skillSeekers.enabled`), separate from curiosity research
  (`memory.curiosity.research.enabled`). Setting it to `false` also turns
  curiosity research off unless `research.enabled` is explicitly `true`.

## Automations

- **A failed scheduled job does not tell you.** The failure is recorded in the
  job's run history and the log (and sent to the webhook if you set one), but
  nothing is sent to your chat.
- Scheduled jobs and dream cycles only run while the gateway is running. A
  one-shot job whose time passed in the meantime runs late, after the next
  start, if it is at most 7 days late; older ones stay unrun. A one-shot that
  was interrupted mid-run by a restart is not run again.

## Orchestrator (P2P binary)

- **Signed releases, verified on download.** Orchestrator releases (since
  `orchestrator-v0.2.3`) carry `checksums.txt.minisig` and GitHub
  build-provenance attestations (`gh attestation verify`). The postinstall
  fetcher checks the minisign signature against the key pinned in
  `scripts/orchestrator-signature.mjs` and refuses to install when the
  signature is missing, invalid, or from another release. Releases before
  0.2.3 are unsigned and are not fetched by current versions. Building from
  source (`cargo build --release --manifest-path orchestrator/Cargo.toml`)
  does not involve the signature at all.

## Installer (release tarballs)

- **Signature check depends on your machine.** `install.sh` verifies the
  release's minisign signature only when `minisign` or OpenSSL 3 is present.
  Stock macOS has neither (its `openssl` is LibreSSL), so there it checks
  SHA-256 from `checksums.txt` fetched over HTTPS, says so, and runs
  `gh attestation verify` only if `gh` is installed and logged in. Install
  minisign or pass `--require-signature` to refuse that fallback.
- **Platforms.** Tarballs exist for Linux x64/arm64 with glibc 2.28 or newer
  (the bundled Node 22's floor) and Apple-silicon macOS, from release 1.5.0
  on. Intel Macs, musl Linux and older glibc use Docker. Windows installs
  inside WSL2 (`install.ps1` runs `install.sh` in the default WSL2
  distribution) or uses Docker Desktop.
- **Tarballs lag the release.** Each release's tarballs are signed only after
  a maintainer approves the signing step (one approval per release). Until
  then the installer keeps installing the previous complete release, and a
  pinned `--version` of the new one fails.
- **Updates and rollback.** `bitterbot update` (or the Control UI) updates an
  installer-based install in place on the stable channel only (no beta for
  tarballs). It always checks the minisign signature (no SHA-256 only
  fallback), takes a snapshot first, and rolls back automatically when the new
  version does not confirm a healthy start (5 to 30 minutes, up to 90 when it
  migrates memory databases on its first start; at once when the relaunched
  process exits). Limits:
  - The snapshot covers the config file, `.env`, the memory databases in
    `~/.bitterbot/memory`, GENOME.md/MEMORY.md of the default agent and the
    P2P keys. Other state (sessions, tasks, usage ledger, a memory store
    configured outside `~/.bitterbot/memory`) is not snapshotted. Only the
    newest three snapshots are kept; each takes about as much disk as your
    memory databases, so three of them take about three times that.
  - An automatic rollback restores a changed config file and `.env`; a manual
    `--rollback` keeps both (`--restore-config` restores the config; `.env`
    only by hand from the snapshot). Memory databases are kept unless the
    failed version migrated them past what the old version knows (automatic
    rollback) or you pass `--restore-data` (manual). Restoring a database
    loses everything written since the update, and happens only once no
    gateway is running (gateway lock free, gateway port silent); otherwise
    the version switches and the databases stay as they are.
    Replaced files go to `~/.bitterbot/update-displaced/` and stay until you
    delete them.
  - Only one version back: `previous` is the version you updated from.
  - A gateway that is not the installed service and not reachable over RPC
    (for example a custom supervisor) is not restarted; restart it yourself.
    Under a supervisor this updater does not know, the automatic rollback
    switches `current` back but cannot start the old version.
  - Updating to a version older than the in-place updater (`--tag`) is refused:
    it cannot run the activation check. Use `install.sh --version` for that.
- **Size.** A tarball is about 390 MB to download and 1.5 GB unpacked (the
  Claude Agent SDK's bundled binary alone is about 230 MB). GPU builds of
  llama.cpp are left out, so local embeddings run on the CPU in an
  installer-based install; a source install or Docker keeps them.
- **Not OS-signed.** The binaries in the tarball are not Apple-notarized or
  Authenticode-signed; integrity comes from minisign, SHA-256 and GitHub
  build-provenance attestations.

## Platform

- **Windows means WSL2.** Native Windows is not a supported gateway host.
  `install.ps1` only finds WSL2 and runs the Linux installer inside it; it does
  not install WSL2 for you, install natively, or register a Scheduled Task.
  Keep the checkout on the Linux filesystem (`~`), not `/mnt/c`: the 9p
  mount makes boots dramatically slower (measured 43x on one machine).
- The Tauri desktop shell is experimental and not part of this release;
  the supported UI is the Control UI served by the gateway.
- npm installs are not supported yet. Supported paths: Docker, the
  installer (release tarballs, from 1.5.0), and a source checkout, where
  `bitterbot update` tracks your git checkout.

## Operational honesty

- Everything the node dials out to or publishes by default, and what it
  listens on, is listed with its off switch in
  [docs/network/egress.md](docs/network/egress.md).
- The changelog is generated per release by release-please
  ([CHANGELOG.md](CHANGELOG.md), starting at v1.0.0).
