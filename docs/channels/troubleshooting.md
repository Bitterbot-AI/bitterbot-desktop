---
summary: "Fast channel level troubleshooting with per channel failure signatures and fixes"
read_when:
  - Channel transport says connected but replies fail
  - You need channel specific checks before deep provider docs
title: "Channel Troubleshooting"
---

# Channel troubleshooting

Use this page when a channel connects but behavior is wrong.

## Command ladder

Run these in order first:

```bash
bitterbot status
bitterbot gateway status
bitterbot logs --follow
bitterbot doctor
bitterbot channels status --probe
```

Healthy baseline:

- `Runtime: running`
- `RPC probe: ok`
- Channel probe shows connected/ready

## WhatsApp

### WhatsApp failure signatures

| Symptom                         | Fastest check                                       | Fix                                                     |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Connected but no DM replies     | `bitterbot pairing list whatsapp`                   | Approve sender or switch DM policy/allowlist.           |
| Group messages ignored          | Check `requireMention` + mention patterns in config | Mention the bot or relax mention policy for that group. |
| Random disconnect/relogin loops | `bitterbot channels status --probe` + logs          | Re-login and verify credentials directory is healthy.   |

Full troubleshooting: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram failure signatures

| Symptom                           | Fastest check                                    | Fix                                                                          |
| --------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `/start` but no usable reply flow | `bitterbot pairing list telegram`                | Approve pairing or change DM policy.                                         |
| Bot online but group stays silent | Verify mention requirement and bot privacy mode  | Disable privacy mode for group visibility or mention bot.                    |
| Send failures with network errors | Inspect logs for Telegram API call failures      | Fix DNS/IPv6/proxy routing to `api.telegram.org`.                            |
| Upgraded and allowlist blocks you | `bitterbot security audit` and config allowlists | Run `bitterbot doctor --fix` or replace `@username` with numeric sender IDs. |

Full troubleshooting: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord failure signatures

| Symptom                         | Fastest check                       | Fix                                                       |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| Bot online but no guild replies | `bitterbot channels status --probe` | Allow guild/channel and verify message content intent.    |
| Group messages ignored          | Check logs for mention gating drops | Mention bot or set guild/channel `requireMention: false`. |
| DM replies missing              | `bitterbot pairing list discord`    | Approve DM pairing or adjust DM policy.                   |

Full troubleshooting: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack failure signatures

| Symptom                                | Fastest check                             | Fix                                               |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| Socket mode connected but no responses | `bitterbot channels status --probe`       | Verify app token + bot token and required scopes. |
| DMs blocked                            | `bitterbot pairing list slack`            | Approve pairing or relax DM policy.               |
| Channel message ignored                | Check `groupPolicy` and channel allowlist | Allow the channel or switch policy to `open`.     |

Full troubleshooting: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## Signal

### Signal failure signatures

| Symptom                         | Fastest check                              | Fix                                                      |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Daemon reachable but bot silent | `bitterbot channels status --probe`        | Verify `signal-cli` daemon URL/account and receive mode. |
| DM blocked                      | `bitterbot pairing list signal`            | Approve sender or adjust DM policy.                      |
| Group replies do not trigger    | Check group allowlist and mention patterns | Add sender/group or loosen gating.                       |

Full troubleshooting: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix failure signatures

| Symptom                             | Fastest check                                | Fix                                             |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| Logged in but ignores room messages | `bitterbot channels status --probe`          | Check `groupPolicy` and room allowlist.         |
| DMs do not process                  | `bitterbot pairing list matrix`              | Approve sender or adjust DM policy.             |
| Encrypted rooms fail                | Verify crypto module and encryption settings | Enable encryption support and rejoin/sync room. |

Full troubleshooting: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
