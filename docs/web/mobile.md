---
summary: "The Bitterbot phone app: pair a phone with a QR code, chat, approve and get notifications"
read_when:
  - You want to use your agent from your phone
  - You are pairing, renaming or removing a phone
  - You are setting up notifications on a phone
title: "Phone App"
---

# Phone app

The gateway serves an installable phone app at `/m/`. It is a web app (PWA) built from the
same code as the [Control UI](/web/control-ui), so it looks and behaves like Bitterbot, and it
talks to the same gateway over the same WebSocket. There is nothing to install from an app
store and no server of ours in the middle.

What it does:

- **Chat** with streaming replies, markdown and code blocks, photo and text-file attachments
  (camera included), voice input when speech to text is configured, and a conversation switcher.
- **Approvals**: answer shell commands, messages to new contacts, public posts and browser
  handoffs the agent is holding for you. Payments are approved on the desktop for now.
- **Status**: gateway connection, the agent's mood (its hormone levels), the latest dream
  journal entry, and owner notices.
- **Notifications** (Web Push): approvals waiting, replies that landed while the app was closed,
  and owner notices. Sent straight from your gateway to Apple, Google or Mozilla's push service.
- **Settings**: rename the phone, choose which notifications you get (and whether they show a
  preview), light or dark mode, and unpair.

## Before you start: reach the gateway from the phone

The gateway listens on `127.0.0.1` by default, which a phone cannot reach. Pick one:

| Option                        | Install and notifications | How                                                               |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Tailscale Serve (recommended) | Yes (trusted HTTPS)       | `gateway.tailscale.mode: "serve"` and Tailscale on both devices   |
| Your own HTTPS address        | Yes                       | `gateway.tls` or a reverse proxy, then `gateway.mobile.publicUrl` |
| Home network, plain HTTP      | Chat and approvals only   | `gateway.bind: "lan"`                                             |

Browsers only allow installing a web app, background notifications and non-extractable keys on
HTTPS (or `localhost`). Over plain HTTP the app still pairs and chats, but it warns you that the
connection is not encrypted, and it keeps its key in a form a script on the page could read.
Use plain HTTP only on a network you trust.

See [Tailscale](/gateway/tailscale) and [Remote access](/gateway/remote).

## Pair a phone

1. On your computer, open the Control UI, go to **Devices**, and choose **Pair a phone**.
   From a terminal, run `bitterbot devices pair` instead. From a chat app, send `/pair`
   (owner only; the `device-pair` plugin is on by default, set
   `plugins.entries.device-pair.enabled: false` to turn it off).
2. Scan the QR code with the phone's camera (or open the link). The link works once and expires
   after five minutes.
3. The phone makes its own key and shows a six-digit code. Your computer shows the code it
   expects. **Approve only if the two match.** In chat, reply `/pair approve <code>`; in a
   terminal, `bitterbot devices approve <code>`.
4. The app opens. On iPhone, add it to your Home Screen when it offers (Share, then Add to Home
   Screen); that is also the only way iPhone allows notifications for web apps.

Then turn on notifications in the app's **Settings**.

### What pairing protects against

- **No gateway token ever leaves your computer.** The QR code carries a one-time setup code in
  the URL fragment (the part after `#`, which browsers never send to the server), so it does not
  land in logs.
- **The phone's key never leaves the phone.** It is created in the browser with WebCrypto as a
  non-extractable key and stored in the browser's IndexedDB. Ed25519 where the browser supports
  it (Safari 17 and later, current Chrome and Firefox), ECDSA P-256 otherwise.
- **Every connection proves the key.** The gateway sends a fresh challenge; the phone signs it.
  The phone's token is useless without the key, so a copied token does nothing.
- **A leaked link is caught by the confirmation code.** The code is derived from the setup secret
  and the phone's public key on both sides. Someone else who used your link gets a different
  number, and you decline.

## What a paired phone can do

A phone gets its own token with three scopes:

| Scope                    | Allows                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `operator.chat`          | Chat in the main conversation and the ones the phone started, voice transcription, and read-only status (mood, dream journal) |
| `operator.approvals`     | List and answer held actions, once at a time (payments and compute funding: deny only)                                        |
| `operator.notifications` | Its own push subscription                                                                                                     |

It cannot change settings, read logs or memory directly, run nodes, install skills, or pair,
rename or remove other devices.

**A phone is not the owner.** Until the phone can prove it is you with a passkey (a later
release), its messages run as a non-owner:

- Owner-only tools (shell commands, configuration, gateway control) are not available to its turns.
- Only `/new`, `/reset`, `/stop`, `/status`, `/help` and `/commands` work from it; every other
  command (`/config`, `/pair`, `/approve` and so on) is refused.
- It sees only the main conversation and the conversations it started. Conversations with other
  people on your chat channels stay on the computer, and so do their live events.
- It can allow an approval once, but never "always allow", and never approve a payment.
- Its connection gets a reduced view of the gateway: no file paths, no other devices' addresses,
  and tool activity without arguments or results.

## Rename, remove, revoke

Every phone is listed under **Devices** in the Control UI and in `bitterbot devices list`.

```bash
bitterbot devices rename <deviceId> "Work phone"
bitterbot devices remove <deviceId>
```

Removing a phone deletes its token and its push subscription and closes its open connection at
once. Revoking its token (`bitterbot devices revoke --device <id> --role operator`) also
disconnects it and deletes the push subscription. Neither touches the gateway token or any other
device. The phone can also unpair itself from its own Settings.

## Notifications

The gateway creates a VAPID key pair the first time a phone subscribes and keeps it in
`~/.bitterbot/push/` (with the subscriptions, one per phone). It sends:

- **Approvals**: an action is waiting. Tapping opens that approval.
- **Replies**: the agent finished replying in a conversation you sent from this phone, while the
  app was closed. Tapping opens the conversation.
- **Notices**: owner notices such as a failed scheduled job.

Nothing is sent to a phone that has the app open on screen. Each phone gets at most 30 per hour
(`gateway.mobile.push.maxPerHour`), and replies and notices wait out your
[`notifications.quietHours`](/gateway/configuration-reference#notifications). A notification
carries a title and a preview of at most 90 characters; turn **Show previews** off and it says
only that something happened. Approval details are always loaded over the authenticated
connection when you open the app, never from the notification. Push services see encrypted
payloads and timing only.

Pairing requests are rate limited per client and per setup code. Behind Tailscale Serve every
request reaches the gateway from loopback, so the limiter tells phones apart by their tailnet
identity; without one, the per-code limit keeps one noisy client from blocking everyone.

Requirements: HTTPS, notification permission, and on iPhone iOS 16.4 or later with the app added
to the Home Screen.

## Configuration

```json5
{
  gateway: {
    mobile: {
      enabled: true, // serve /m/ and allow phone pairing
      publicUrl: "https://box.tailnet.ts.net", // optional: the address pairing QR codes use
      push: {
        enabled: true,
        maxPerHour: 30,
        subject: "mailto:you@example.com", // optional VAPID contact
      },
    },
  },
}
```

## Troubleshooting

- **The QR dialog says the gateway only listens on this computer**: set up one of the options in
  [Before you start](#before-you-start-reach-the-gateway-from-the-phone).
- **The phone says the code expired**: make a new one; codes last five minutes and work once.
- **"This phone was unpaired"**: it was removed or its token revoked. Pair again.
- **No notification toggle on iPhone**: open the app from the Home Screen icon, not from Safari.
- **Notifications toggle is greyed out**: the page is on plain HTTP; use Tailscale Serve.

## Related

- [Control UI](/web/control-ui)
- [devices CLI](/cli/devices)
- [Pairing](/channels/pairing)
- [Tailscale](/gateway/tailscale)
