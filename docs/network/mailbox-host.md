# Circles mailbox host (deploy guide)

PLAN-36 Phase 1. The mailbox is Circles' store-and-forward layer: when a peer
is offline or unreachable, a message is left as a sealed blob they drain on
wake. Until now no host served it out of the box (the relay fleet runs only the
Rust orchestrator; a full gateway is a ~20-minute boot), so offline delivery
silently failed. This is a slim, deployable host that serves **only** the
mailbox verbs.

- **Code:** `src/gateway/a2a/mailbox-host.ts` (reuses the tested handler in
  `src/gateway/a2a/mailbox.ts`).
- **Run:** `node --import tsx scripts/mailbox-host.ts`
- **Default URL clients use:** `DEFAULT_CIRCLES_MAILBOX_URL` in
  `src/config/defaults.ts` (`https://mailbox.bitterbot.ai`).

## What it is (and isn't)

- It stores **X25519-sealed ciphertext it cannot read** — a metadata-only relay.
  The honest claim (PLAN-31 §3.2) is "no server that can read your messages or
  own your graph," never "no cloud intermediary."
- It serves `mailbox/post | mailbox/poll | mailbox/ack` at `POST /a2a`, plus
  `GET /` as a health check. Every other method is refused.
- Auth is per-verb Ed25519 proofs (sender proof to post; recipient proof to
  poll/ack) — no bearer token, by design. Blobs are ≤64 KiB, quota 500 per
  recipient with a 50-per-sender sub-quota, 30-day TTL, swept hourly. A box
  at the 500 ceiling evicts the largest sender's oldest blob rather than
  refusing mail (anti-wedge), and the 60/5-min per-sender post window is
  persisted (`mailbox_post_log`) so restarts do not reset it.
- It holds **no** memory engines, agent, or gateway — it boots in milliseconds.

## Deploy

1. **Host + TLS.** Put it behind a TLS reverse proxy (Caddy/nginx/Cloudflare);
   the process itself speaks plain HTTP. Example with Caddy:

   ```
   mailbox.bitterbot.ai {
     reverse_proxy 127.0.0.1:8790
   }
   ```

2. **Run the service** (systemd unit, pm2, or a container). Env:

   | var            | default            | notes                                   |
   | -------------- | ------------------ | --------------------------------------- |
   | `MAILBOX_PORT` | `8790`             | port to listen on                       |
   | `MAILBOX_HOST` | `0.0.0.0`          | bind address (public, behind the proxy) |
   | `MAILBOX_DB`   | `./mailbox.sqlite` | persistent SQLite path                  |

   ```
   MAILBOX_DB=/var/lib/bitterbot/mailbox.sqlite \
   node --import tsx scripts/mailbox-host.ts
   ```

   (For a fleet node without the repo, ship the built bundle instead of tsx.)

3. **Point clients at it.** The client default is already
   `https://mailbox.bitterbot.ai`. Roll any change out via the PLAN-32 config
   push, or set `circles.mailbox.url` per node. A node can opt out with
   `circles.mailbox: { enabled: false }`.

## Verify

```
curl https://mailbox.bitterbot.ai/            # -> {"ok":true,"service":"circles-mailbox"}
```

Then, on two nodes: take the recipient offline, send a circle message, bring it
back — it should drain within one fast-scheduler cycle (~15 s). The
`src/gateway/a2a/mailbox-host.test.ts` HTTP round-trip test exercises
post → poll → ack end to end.

## Scope / limits

- The host closes the **offline / asymmetric-window** gap. It does **not** by
  itself let two NAT'd nodes do the live `circle/join` handshake — that still
  needs the inviter reachable (or the mesh transport, PLAN-35 Track B / the
  per-circle gossip path). The mailbox is the store-and-forward backstop, not
  the whole out-of-box story.
- Metadata exposure: the host sees sender/recipient pubkeys and timing (not
  content). Acceptable for a backstop; documented rather than hidden.
