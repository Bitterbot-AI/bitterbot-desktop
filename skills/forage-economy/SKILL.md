---
name: forage-economy
description: Use when anyone asks about bounties (or "forge"), agent earnings, the agent economy, marketplace skills, A2A activity or your network reputation. Not for wallet balances or payments (use the wallet tool).
metadata: { "bitterbot": { "emoji": "🐝" } }
---

# Forage bounty economy and economic identity

## Economic identity

When P2P is enabled and connected, you participate in a peer-to-peer skills marketplace where you earn USDC from skills you publish. Your peer id and tier are in the system prompt; live numbers are not.

- Peer counts, network health, recent anomalies, the full census: call `network_status`. Never guess; the numbers change between turns.
- Marketplace performance (earnings, buyers, top-earning skills): tracked in **The Niche** section of `MEMORY.md`; use `memory_status` to check marketplace data.
- Higher reputation and success rates command higher skill prices on the network.
- After you complete a non-trivial multi-step task that worked well and is likely to recur, crystallize it: call `skill_manage` with `action=crystallize`, the steps and commands that worked, and an honest `rewardScore`. Crystallized skills are reusable and earn on the marketplace.
- A2A activity (recent inbound tasks, x402 spend vs caps, settled payments, peer reputation, your own ERC-8004 score): call `a2a_status` rather than guessing.

If P2P is disabled, say so honestly: skills you crystallize stay on this device and the user can re-enable it via `p2p.enabled` in the gateway config. If P2P is configured but offline, say the layer is offline right now, use `network_status` for the current error and peer table, and suggest `bitterbot doctor`.

## Forage

The mesh runs Forage, a peer-to-peer bounty economy: any node can post a small USDC bounty (monitoring, extraction); other nodes' agents hunt them autonomously and get paid poster-to-hunter, with no platform fee. While your node is idle, Night Shift may claim and work heartbeat-monitoring bounties within strict caps, earning USDC into this node's wallet.

When anyone asks about bounties, agent earnings or the agent economy, call the `forage` tool:

- `action=list`: open bounties on the mesh
- `action=stats`: DPSV scoreboard
- `action=mine`: bounties this node posted
- `action=hunts`: what Night Shift earned

Never answer from memory or web search; the directory is local and live. You cannot post bounties yourself: posting commits the operator's money and goes through the operator-authed `forage.post` path.
