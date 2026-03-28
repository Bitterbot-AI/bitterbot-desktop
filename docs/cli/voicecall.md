---
summary: "CLI reference for `bitterbot voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `bitterbot voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
bitterbot voicecall status --call-id <id>
bitterbot voicecall call --to "+15555550123" --message "Hello" --mode notify
bitterbot voicecall continue --call-id <id> --message "Any questions?"
bitterbot voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
bitterbot voicecall expose --mode serve
bitterbot voicecall expose --mode funnel
bitterbot voicecall unexpose
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
