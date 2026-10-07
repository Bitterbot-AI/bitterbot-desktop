---
summary: "Write to your agent by email; it replies on the same thread"
read_when:
  - You want to reach the agent by email
  - Setting up IMAP and SMTP for the agent's mailbox
title: "Email"
---

# Email

Give the agent a mailbox and you can write to it like a person: it reads new
mail, answers on the same thread, and remembers the conversation per sender.
It uses plain IMAP and SMTP, so any provider works (Gmail, Fastmail, iCloud,
Proton Mail Bridge, Outlook.com, a company server) with no cloud console or
tunnel to set up.

Use a mailbox made for the agent, not your own inbox: everything that arrives
there is read by it.

## Setup

1. Create the mailbox and an **app password** for it (Gmail, iCloud and Outlook
   need one when two-step sign-in is on).
2. Add the channel:

   ```json5
   {
     channels: {
       email: {
         address: "agent@example.com",
         password: "app-password", // used for both IMAP and SMTP
         imap: { host: "imap.gmail.com" }, // port 993, TLS
         smtp: { host: "smtp.gmail.com" }, // port 465, TLS
         allowFrom: ["you@example.com"], // who may write to the agent
       },
     },
   }
   ```

3. Restart the gateway. It connects, reads unseen mail, and waits for new mail
   with IMAP IDLE.

Common servers: Fastmail `imap.fastmail.com` / `smtp.fastmail.com`, iCloud
`imap.mail.me.com` / `smtp.mail.me.com` (SMTP on port 587 with
`secure: false`), Outlook.com `outlook.office365.com` / `smtp-mail.outlook.com`
(587, `secure: false`). Give `imap` and `smtp` their own `user` and `password`
when they differ.

## Who the agent answers

The agent only answers mail that passes all of these:

- The sender is in `allowFrom`: an address, `@domain.com` for a whole domain, or
  `*` for anyone. Nobody is allowed until you set it.
- **Your mail server verified the sender.** A From line is easy to forge, so the
  channel reads the `Authentication-Results` header your provider adds (only the
  topmost one: anything lower down could have been written by the sender) and
  requires DMARC to pass for the sender's domain, or a DKIM signature from that
  domain. Set `authservId` to your provider's name in that header (for Gmail,
  `mx.google.com`) to trust only its verdict. Turn the check off with
  `requireAuthenticated: false` only for a server that adds no such header.
- A person wrote it: auto-replies, bounces, mailing lists and bulk mail are
  ignored, and the agent's own replies say `Auto-Submitted: auto-replied` so
  other auto-responders leave them alone.

Every message it looks at is marked read, whether it answers or not, so nothing
is handled twice. Messages over 5 MB are marked read and never downloaded. The
agent sends at most `maxRepliesPerHour` replies to one sender, so a misbehaving
auto-responder cannot start a mail loop.

An exact address in `allowFrom` is treated as the owner, with the owner's tools,
unless `commands.ownerAllowFrom` names someone else. Put only your own addresses
there, or set `commands.ownerAllowFrom`.

## How replies look

The agent sees only the new part of your message: quoted history and your
signature are cut off. Its reply goes back as one email on the same thread
(`Re:` subject, `In-Reply-To` and `References`). When the agent writes to you
on its own (the message tool with channel `email` and your address), it
continues your last thread.

## Settings

| Key                    | Default | Meaning                                       |
| ---------------------- | ------- | --------------------------------------------- |
| `address`              |         | The agent's address; replies come from it     |
| `password`             |         | Shared IMAP and SMTP password                 |
| `imap`, `smtp`         |         | `host`, `port`, `secure`, `user`, `password`  |
| `allowFrom`            | nobody  | Addresses, `@domains`, or `*`                 |
| `requireAuthenticated` | `true`  | Require DMARC or same-domain DKIM to pass     |
| `authservId`           |         | Trust only this server's verdict              |
| `maxRepliesPerHour`    | `20`    | Most replies to one sender per hour           |
| `mailbox`              | `INBOX` | Folder to watch                               |
| `maxBodyChars`         | `20000` | Longest message body the agent reads          |
| `responsePrefix`       |         | Text put before each reply                    |
| `enabled`              | `true`  | Set `false` to stop without removing settings |
