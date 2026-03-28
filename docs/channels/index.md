---
summary: "Messaging platforms Bitterbot can connect to"
read_when:
  - You want to choose a chat channel for Bitterbot
  - You need a quick overview of supported messaging platforms
title: "Chat Channels"
---

# Chat Channels

Bitterbot can talk to you on any chat app you already use. Each channel connects via the Gateway.
Text is supported everywhere; media and reactions vary by channel.

## Supported channels

- [WhatsApp](/channels/whatsapp) — Most popular; uses Baileys and requires QR pairing.
- [Telegram](/channels/telegram) — Bot API via grammY; supports groups.
- [Discord](/channels/discord) — Discord Bot API + Gateway; supports servers, channels, and DMs.
- [IRC](/channels/irc) — Classic IRC servers; channels + DMs with pairing/allowlist controls.
- [Slack](/channels/slack) — Bolt SDK; workspace apps.
- [Google Chat](/channels/googlechat) — Google Chat API app via HTTP webhook.
- [Signal](/channels/signal) — signal-cli; privacy-focused.
- [Microsoft Teams](/channels/msteams) — Bot Framework; enterprise support (plugin, installed separately).
- [Twitch](/channels/twitch) — Twitch chat via IRC connection (plugin, installed separately).
- [WebChat](/web/webchat) — Gateway WebChat UI over WebSocket.

## Notes

- Channels can run simultaneously; configure multiple and Bitterbot will route per chat.
- Fastest setup is usually **Telegram** (simple bot token). WhatsApp requires QR pairing and
  stores more state on disk.
- Group behavior varies by channel; see [Groups](/channels/groups).
- DM pairing and allowlists are enforced for safety; see [Security](/gateway/security).
- Telegram internals: [grammY notes](/channels/grammy).
- Troubleshooting: [Channel troubleshooting](/channels/troubleshooting).
- Model providers are documented separately; see [Model Providers](/providers/models).
