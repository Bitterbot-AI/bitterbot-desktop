---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - Pairing a new node
  - Reviewing Bitterbot security posture
title: "Pairing"
---

# Pairing

“Pairing” is Bitterbot’s explicit **owner approval** step.
It is used in two places:

1. **DM pairing** (who is allowed to talk to the bot)
2. **Node pairing** (which devices/nodes are allowed to join the gateway network)

Security context: [Security](/gateway/security)

## 1) DM pairing (inbound chat access)

When a channel is configured with DM policy `pairing`, unknown senders get a short code and their message is **not processed** until you approve.

Default DM policies are documented in: [Security](/gateway/security)

Pairing codes:

- 8 characters, uppercase, no ambiguous chars (`0O1I`).
- **Expire after 1 hour**. The bot only sends the pairing message when a new request is created (roughly once per hour per sender).
- Pending DM pairing requests are capped at **3 per channel** by default; additional requests are ignored until one expires or is approved.

### Approve a sender

```bash
bitterbot pairing list telegram
bitterbot pairing approve telegram <CODE>
```

Supported channels: `telegram`, `whatsapp`, `signal`, `discord`, `slack`, `twitch`.

### Where the state lives

Stored under `~/.bitterbot/credentials/`:

- Pending requests: `<channel>-pairing.json`
- Approved allowlist store: `<channel>-allowFrom.json`

Treat these as sensitive (they gate access to your assistant).

## 2) Node device pairing (headless nodes)

Nodes connect to the Gateway as **devices** with `role: node`. The Gateway
creates a device pairing request that must be approved.

### Pair a phone from a chat app

With the `device-pair` plugin enabled, you can pair a phone from any chat channel:

1. `/pair` replies with a one-time link (five minutes, single use). It never contains the
   gateway token.
2. Open it on the phone. The [phone app](/web/mobile) makes its own key and shows a six-digit
   code.
3. `/pair approve <code>` approves it when the code matches (`/pair pending` lists requests,
   `/pair reject <code>` declines).

### Approve a node device

```bash
bitterbot devices list
bitterbot devices approve <requestId>
bitterbot devices reject <requestId>
```

### Node pairing state storage

Stored under `~/.bitterbot/devices/`:

- `pending.json` (short-lived; pending requests expire)
- `paired.json` (paired devices + tokens)

### Notes

- The Control UI pairs the same way. On a fresh remote gateway, bootstrap pairing
  can approve the first browser automatically; see
  [first run from the browser](/platforms/docker#start-in-one-command).
- The legacy `node.pair.*` API (CLI: `bitterbot nodes pending/approve`) is a
  separate gateway-owned pairing store. WS nodes still require device pairing.
- Phones pair with one-time setup codes from the Control UI (**Pair a phone**),
  `bitterbot devices pair` or `/pair`; see the [phone app](/web/mobile). A phone's token is
  scoped to chat, approvals and notifications.

## Related docs

- Security model + prompt injection: [Security](/gateway/security)
- Updating safely: run `bitterbot doctor`; for containers see
  [Updating](/platforms/docker#updating)
- Channel configs:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
