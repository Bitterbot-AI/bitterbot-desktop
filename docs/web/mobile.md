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
- **Settings**: rename the phone, choose which notifications you get (and whether replies and
  notices show a preview), light or dark mode, and unpair.

## Before you start: reach the gateway from the phone

The gateway listens on `127.0.0.1` by default, which a phone cannot reach. Pick one:

| Option                        | Install and notifications | How                                                               |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Tailscale Serve (recommended) | Yes (trusted HTTPS)       | `gateway.tailscale.mode: "serve"` and Tailscale on both devices   |
| Your own HTTPS address        | Yes                       | `gateway.tls` or a reverse proxy, then `gateway.mobile.publicUrl` |
| Home network, plain HTTP      | Chat and approvals only   | `gateway.bind: "lan"`                                             |

Notifications, the service worker and non-extractable keys need HTTPS (or `localhost`). Over
plain HTTP the app still pairs and chats, but it warns you that the connection is not encrypted.
Anyone on the network can then read or change the traffic, including the app's own code, and the
phone keeps its key in a form a script on the page could read. Use plain HTTP only on a network
you trust.

A private address in the list is not proof the phone can reach it. The gateway must listen on
that interface, the computer's firewall must allow it, and some Wi-Fi networks keep devices from
seeing each other. Under WSL 2 the gateway sits behind a NAT by default, so its address is not
reachable from the phone without mirrored networking, a port forward, or Tailscale.

See [Tailscale](/gateway/tailscale) and [Remote access](/gateway/remote).

## Pair a phone

1. On your computer, open the Control UI, go to **Devices**, and choose **Pair a phone**.
   From a terminal, run `bitterbot devices pair` instead. From a chat app, send `/pair`
   (owner only; the `device-pair` plugin is on by default, set
   `plugins.entries.device-pair.enabled: false` to turn it off).
2. Scan the QR code with the phone's camera (or choose **Copy link** and open it on the phone).
   The link works once and expires after five minutes.
3. **On iPhone (iOS 16.4 or later, over HTTPS)**, the page asks you to add Bitterbot to your Home
   Screen first: Share, then Add to Home Screen. Open the new icon within five minutes and it
   carries on from step 4. On iOS 16.4 to 17.1 it cannot carry on by itself: the page first asks
   you to **Copy pairing link**, and you paste it into the Home Screen app. iPhone gives a Home Screen app its own storage, separate from Safari,
   and only the Home Screen app can get notifications, so pairing happens there. You can choose
   **Use it in Safari instead** to skip notifications.
4. The phone makes its own key and shows a six-digit code. Your computer shows the code it
   expects. **Approve only if the two match.** In chat, reply `/pair approve <code>`; in a
   terminal, `bitterbot devices approve <code>`.

Then turn on notifications in the app's **Settings**.

If the Home Screen app opens without the pairing (the five minutes ran out, or iOS is older than
17.2, which does not hand Safari's cookies to a new Home Screen app), it offers a box to paste
the link: make a new code, choose **Copy link** and send it to the phone. If the phone loses its
connection while you approve, it picks the result up again when it is back, for two minutes after
the first pick-up; reloading the page while you wait carries on too.

### What pairing protects against

- **No gateway token ever leaves your computer.** The QR code carries a one-time setup code in
  the URL fragment (the part after `#`, which browsers never send to the server), so it does not
  land in logs.
- **The phone's key never leaves the phone.** Over HTTPS it is created in the browser with
  WebCrypto as a non-extractable key and stored in the browser's IndexedDB: Ed25519 where the
  browser supports it (Safari 17 and later, current Chrome and Firefox), ECDSA P-256 otherwise.
  Over plain HTTP the browser offers no WebCrypto, so the key is made in script and can be read
  by a script on the page. Non-extractable is not the same as unusable: code running on the page
  can still use the key while it runs.
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
- It sees the main conversation, which every phone and the computer share, and the conversations
  it started itself. Another phone's conversations, and conversations with other people on your
  chat channels, stay out of its lists, history and live events.
- It can allow an approval once, but never "always allow", and never approve a payment.
- Its connection gets a reduced view of the gateway: no file paths, no other devices' addresses,
  and tool activity without arguments or results.

## Rename, remove, revoke

Every phone is listed under **Devices** in the Control UI and in `bitterbot devices list`.

```bash
bitterbot devices rename <deviceId> "Work phone"
bitterbot devices remove <deviceId>
```

Removing a phone deletes its token and closes its open connection at once, then deletes its push
subscription. Revoking its token (`bitterbot devices revoke --device <id> --role operator`) also
disconnects it and deletes the push subscription. Neither touches the gateway token or any other
device. If the push cleanup fails, the gateway still never pushes to a phone that is no longer
paired. A notification already handed to Apple or Google before the removal may still arrive.

The phone can also unpair itself from its own Settings. When the computer cannot be reached, the
phone says so and stays paired; you can try again, or forget the pairing on the phone only and
remove it under **Devices** later.

## Notifications

The gateway creates a VAPID key pair the first time a phone subscribes and keeps it in
`~/.bitterbot/push/` (with the subscriptions, one per phone). It sends:

- **Approvals**: an action is waiting. Tapping opens that approval.
- **Replies**: the agent finished replying in a conversation you sent from this phone, while the
  app was closed. Tapping opens the conversation.
- **Notices**: owner notices such as a failed scheduled job.

Nothing is sent to a phone that has the app open on screen. Each phone gets at most 30 per hour
(`gateway.mobile.push.maxPerHour`). During your
[`notifications.quietHours`](/gateway/configuration-reference#notifications), replies and notices
are counted instead of sent, and each phone gets one summary when quiet hours end (for example
"2 replies and 1 notice"). The summary is best effort: only the counts are kept, in memory, so a
gateway restart overnight or a failed send drops it. Approvals still go out during quiet hours.

By default a notification says only what happened ("Bitterbot replied", "A shell command needs
your OK"). Turn on **Show previews** to add up to 90 characters of a reply or notice. An approval
never shows the command or any of its details on the lock screen, whatever the setting: they are
loaded over the authenticated connection when you open the app. Payloads are encrypted to the
phone (RFC 8291), so Apple, Google or Mozilla see the encrypted payload and delivery metadata (the
endpoint, size, time, urgency and expiry), not its text.

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
  A phone paired in Safari pairs once more from the Home Screen app; unpair the Safari copy
  afterwards.
- **The Home Screen app opened unpaired**: paste a fresh link (see [Pair a phone](#pair-a-phone)).
- **Notifications toggle is greyed out**: the page is on plain HTTP; use Tailscale Serve.

## Related

- [Control UI](/web/control-ui)
- [devices CLI](/cli/devices)
- [Pairing](/channels/pairing)
- [Tailscale](/gateway/tailscale)
