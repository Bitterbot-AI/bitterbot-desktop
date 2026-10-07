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
- **What:** libp2p/gossipsub traffic: skill announcements, reputation
  scores, weather/bounty broadcasts, census pings. Also:
  - knowledge queries on `bitterbot/queries/v1`: the text of your agent's
    top curiosity target (a description derived from its memory), at most
    once per consolidation cycle;
  - experience telemetry on `bitterbot/telemetry/v1`: scores only, once per
    dream cycle;
  - skill publications in answer to other nodes' queries, limited to skill
    crystals marked shared or public.

  Your node is identified by its Ed25519 peer id.

- **Curiosity research (default on when web search is configured):** on a
  schedule (`memory.curiosity.research`, every 4 h, at most 6 questions a
  day) the agent rewrites one of its open questions as a generic topic
  phrase, checks the phrase for names, addresses and fragments of the
  original (anything that fails is never sent; your name and every person,
  organization and project in the knowledge graph are checked on the raw
  phrase, and public subjects the model declares, such as a technology
  name, may pass unless `research.strictEgress` is true), sends it to your configured
  web search provider, and fetches up to 3 of the result pages with the same
  SSRF guard as `web_fetch`. Every search and fetch is a row in
  `research_egress_log`; the question, the phrase, the sources and the
  answer are on the Curiosity page, where you can pause it. The agent's own
  model writes the phrase (the party that already holds the note); a
  genuinely local model is used instead when `memory.dream.modelTiers.localModel`
  names one. Sensitive topics (health, finances, legal, intimate) are never
  researched.

- **Inbound:** the orchestrator also accepts libp2p connections on TCP 9100
  on all interfaces (change with `p2p.listenAddrs`).
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
- **Where:** first a direct HTTPS dial to each circle member's A2A URL, then
  `https://mailbox.bitterbot.ai` (store-and-forward fallback when a peer is
  offline). The mesh dial (`circles.p2pDial`) and the circle gossip topic
  (`circles.meshTopic`) are both off by default.
- **What:** end-to-end circle envelopes addressed to circle members.
- **Off switch:** `circles.enabled: false`, or simply never join a circle.

## 7. Live model pricing (runtime)

- **When:** a few seconds after gateway start if the newest snapshot is older
  than a day, then once every 24 hours.
- **Where:** `openrouter.ai` (`GET /api/v1/models`), or the URL in
  `usage.pricing.openRouterUrl`.
- **What:** a plain, unauthenticated HTTPS GET of OpenRouter's public model
  list. Nothing about this node is sent; the response's per-token prices are
  stored under `~/.bitterbot/model-pricing/` and used only to price models
  that the built-in catalog does not know (see
  `docs/concepts/usage-tracking.md`).
- **Off switch:** `usage.pricing.liveRefresh: false` in `bitterbot.json`.
  With it off, unknown models are marked "unpriced" instead of guessed.

## 8. Shopping on stores (runtime, on by default)

- **When:** only when the agent uses the `shop` tool, for a store you asked about.
- **Where:** the store's own domain (its `/.well-known/ucp` file, then the
  shopping endpoint it names, on the store's host or a `myshopify.com` host).
- **What:** catalog searches and cart contents, plus the URL of a public agent
  profile on `cdn.jsdelivr.net` (tracking the repository's `main` branch) that
  the store fetches to identify the agent. No card or account details.
- **Off switch:** `shop.enabled: false`.

## Everything else is opt-in

Web search (Brave/Tavily/Perplexity/xAI/Serply with your key; Parallel Search MCP at
`search.parallel.ai` keyless and anonymous, so each query reaches Parallel with
only a Bitterbot User-Agent), Skill Seekers ingestion
(`skills.skillSeekers.enabled`, default off), channels (WhatsApp, Telegram,
…), the wallet/x402 layer, and agent-to-agent HTTP (`a2a.enabled`, default
off) all require you to configure or enable them explicitly, and each has
a matching flag in Settings.

To verify this page against the code, grep the repo for the hostnames
above — every dial is in source, none are obfuscated.
