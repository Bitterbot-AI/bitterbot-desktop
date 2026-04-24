---
summary: "Phone-accessible chat UI served by the gateway at /m"
read_when:
  - You want to chat with your local agent from your phone
  - You are pairing a new mobile client
title: "Mobile Chat UI"
---

# Mobile Chat UI

The gateway serves a minimal phone-friendly chat page at `GET /m`. It connects back to the gateway over the same WebSocket the desktop uses, so the agent, memory, skills, and routing are all identical — there's no separate server to run.

Intended use: point your phone at a Tailscale-reachable or LAN-reachable gateway, pair once, chat from the couch.

## Quick start

1. On the desktop, generate a setup code:

   ```text
   /pair
   ```

   The reply includes an "Or open this URL on your phone" line — tap or paste it into your phone browser.

2. The phone opens `https://<host>/m?t=<token>` and handshakes over WebSocket.

3. Send a message. Replies stream back into the chat.

## How the URL is built

`/pair` emits both an iOS setup code and a browser URL of the form:

```
https://<gateway-host>[:<port>]/m?t=<url-encoded-token>
```

- `<host>` resolves from `gateway.tailscale.mode`, `gateway.remote.url`, or `gateway.bind` (in that order), same as the iOS setup code.
- `<token>` is the active gateway token or password. Treat it like a gateway credential.
- An optional `?s=<sessionKey>` pins the conversation to a specific session (defaults to `mobile:default`).

## Auth

- Gateway auth is required, same as every other web surface. The page accepts a token either via the `Authorization: Bearer` header or the `?t=` query parameter.
- In loopback, `isLocalDirectRequest` lets the page load without credentials.
- Non-loopback (Tailscale, tailnet bind, LAN bind) **requires** a token or password.
- Revoke access by rotating `gateway.auth.token` / `gateway.auth.password` and reissuing a setup code.

## What the UI does today

- Sends via `chat.send`, polls `chat.history` for the reply (no streaming in v1).
- Persistent session key via `?s=`; default is `mobile:default`.
- Auto-reconnects on disconnect with a 3s backoff; reconnect tolerant to iOS Safari suspend.
- No attachments, no voice, no skill picker — use the desktop for those.

## Limitations

- No event-stream UI; long agent turns show a "thinking…" indicator and render when the turn completes.
- Credentials live in the URL. For untrusted networks use a Tailscale-reachable host.
- One session per URL. Multi-session UI is deferred to a follow-on.

## Related

- [Control UI](/web/control-ui) — full-featured desktop browser UI.
- [Web (Gateway)](/web) — bind modes and security.
- [Pairing](/channels/pairing) — device and DM pairing.
