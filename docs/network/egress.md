---
title: "What this node connects to"
summary: "Every default outbound connection, what it sends, and the exact switch that turns it off."
read_when:
  - Auditing a Bitterbot node's network behavior
  - Running in a restricted or air-gapped environment
---

# What this node connects to

Every outbound connection a default install makes is listed here with its
purpose, what it carries, and the exact switch that turns it off. The claim
this page makes is deliberately narrow and checkable: **every outbound
connection is documented and switchable.** It does not claim "no telemetry"
— it shows you each dial so you can verify and disable them yourself.

The onboarding wizard's P2P consent prompt is the master gesture: declining
it applies the Local-only preset, which turns off items 2, 3, 5, and 6
below in one step.

## 1. GitHub Releases — orchestrator binary (install time)

- **When:** during `pnpm install` (postinstall), and only if a prebuilt
  release exists for the version in `orchestrator/Cargo.toml`.
- **Where:** `github.com` / `objects.githubusercontent.com`
  (`Bitterbot-AI/bitterbot-desktop` releases).
- **What:** plain HTTPS downloads of `checksums.txt` (+ `.minisig` once
  releases are signed) and the platform binary. Nothing is uploaded.
- **Off switch:** `BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD=1` in the install
  environment, or build locally with
  `cargo build --release --manifest-path orchestrator/Cargo.toml`.

## 2. P2P mesh — bootstrap and gossip (runtime)

- **When:** at gateway start, if you consented to joining the network.
- **Where:** DNS TXT lookup of `_dnsaddr.p2p.bitterbot.ai`, then libp2p
  connections to the discovered relays; hardcoded fallbacks if DNS fails:
  `142.93.113.64:9100` (nyc1), `46.101.181.98:9100` (fra1),
  `139.59.233.83:9100` (sgp1), `metro.proxy.rlwy.net:12838`.
- **What:** libp2p/gossipsub traffic — skill announcements, reputation
  scores, weather/bounty broadcasts, census pings. Your node is identified
  by its Ed25519 peer id.
- **Off switch:** `p2p.enabled: false` (Settings → P2P, or decline the
  wizard's network consent).

## 3. Update check (runtime)

- **When:** at gateway start and every 6 hours.
- **Where:** `git fetch` against your clone's `origin`, and
  `registry.npmjs.org` (package metadata for the update channel).
- **What:** standard git/registry requests; nothing about your node is
  sent beyond what those protocols carry.
- **Off switch:** `update.checkOnStart: false`.

## 4. Model provider APIs (runtime, key-gated)

- **When:** whenever the agent runs a turn, and only toward providers you
  configured keys for (Anthropic, OpenAI, etc.).
- **What:** your conversation content, per the provider you chose. This is
  the product working, not telemetry — but it is the largest egress
  surface, so choose providers deliberately.
- **Off switch:** remove the key. With no remote embedding key, long-term
  memory falls back to a bundled local model — after a one-time ~330MB
  download from `huggingface.co` (`ggml-org/embeddinggemma-300m-qat-q8_0`),
  embeddings never leave the machine. That download has its own kill
  switch: `agents.defaults.memorySearch.local.autoDownload: false`.

## 5. Live model discovery (runtime, key-gated)

- **When:** when listing models, against providers you hold keys for.
- **What:** each configured provider's model-list endpoint.
- **Off switch:** `models.liveDiscovery.enabled: false`.

## 6. Circles mailbox (runtime, only after you join a circle)

- **When:** only once you create or accept a circle invite; never on a
  fresh install.
- **Where:** `https://mailbox.bitterbot.ai` (store-and-forward fallback
  when a peer is offline; the mesh is the primary transport).
- **What:** end-to-end circle envelopes addressed to circle members.
- **Off switch:** `circles.enabled: false`, or simply never join a circle.

## Everything else is opt-in

Web search (Brave/Tavily/Perplexity/xAI), Skill Seekers ingestion
(`skills.skillSeekers.enabled`, default off), channels (WhatsApp, Telegram,
…), the wallet/x402 layer, and agent-to-agent HTTP (`a2a.enabled`, default
off) all require you to configure or enable them explicitly, and each has
a matching flag in Settings.

To verify this page against the code, grep the repo for the hostnames
above — every dial is in source, none are obfuscated.
