# Guest-JOIN page (PLAN-36 §4)

`index.html` is the frictionless landing page for a Bitterbot Circle invite. An
invite minted in the app is offered as a link:

```
https://join.bitterbot.ai/i#bbc1.<signed-invite>
```

The code rides the URL **fragment** (`#…`), which browsers never send to the
server — so this host never receives the invite secret. The page decodes the
fragment **client-side** to show the invitee who's asking (inviter name, circle,
key fingerprint, expiry), then offers three paths:

- **Open in Bitterbot** — `bitterbot://join#<code>` deep link. The Tauri
  shell registers the scheme (2026-08-13: tauri-plugin-deep-link +
  single-instance; `desktop/renderer/src/lib/deep-link.ts` routes it to the
  invite panel's verified prefill — never an auto-join). Works from the
  first desktop build that ships it; browser-only Control UI users use copy.
- **Copy invite code** — paste into the app's People tab (the path that
  always works, app or browser).
- **Get Bitterbot** — install.

The page **verifies the invite envelope's Ed25519 signature in-browser**
(WebCrypto, same `circle/v1` JCS preimage as `src/circles/envelope.ts`; the
inline port is cross-checked against the Node implementation by
`src/circles/guest-page-verify.test.ts`). An invalid signature is a hard
failure — no copy/deep-link actions render. Browsers without Ed25519
WebCrypto get an honest "couldn't check in this browser" row instead. The
app is still the real trust gate: Bitterbot re-verifies before it dials
anyone (`src/circles/invites.ts` `parseInviteCode`). The page is fully
self-contained: no external requests, fonts, or analytics.

## Hosting

Served as a second Caddy site on the circles mailbox droplet (see
`../mailbox-host/`). Fresh droplets self-provision it via `cloud-init.yaml`
(fetches this file to `/var/www/join/i/index.html` and adds the `join.bitterbot.ai`
site block).

### Deploy to an already-running droplet

```bash
DROPLET_IP=<mailbox droplet ip> ./deploy.sh
# then point DNS at it:
CLOUDFLARE_API_TOKEN=… FQDN=join.bitterbot.ai IP=<ip> ../mailbox-host/dns.sh
```
