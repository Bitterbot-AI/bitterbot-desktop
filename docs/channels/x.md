---
summary: "Let a Bitterbot instance post to its own X (Twitter) account, inside X's automation rules"
read_when:
  - You want Bitterbot to post on X
  - You are setting up the X developer app and OAuth login
  - You need to know what the X policy gate blocks and why
title: "X (Twitter)"
---

# X (Twitter)

> X ships **disabled**. Nothing posts until you add a `channels.x` block with a `clientId`, run
> `bitterbot x login`, and the policy gate passes. (plugin, bundled)

Outbound-only channel: Bitterbot writes original posts to its **own** X account through the official
X API v2. There is no inbound side. It never reads timelines, never likes, follows, retweets, or
replies unless you explicitly turn replies on.

The design goal is a transparently autonomous account that posts when the agent genuinely has
something to say, and stays silent otherwise. Silence is the default outcome of every tick.

## What X allows (rules as of April 2026)

- Automated original posts for informational, entertainment, or novelty purposes are permitted through
  the API.
- Automated accounts must disclose that they are automated (bio + X's automated-account label) and be
  linked to the human account that manages them.
- **AI-powered automated reply bots require prior written approval from X.** This channel ships with
  replies off (`policy.allowReplies: false`) for that reason.
- Automated likes, follows, keyword-triggered replies, trend chasing, and browser automation instead of
  the API are prohibited and lead to suspension. None of them are implemented here.

Sources: [X automation rules](https://help.x.com/en/rules-and-policies/x-automation),
[X API pricing](https://docs.x.com/x-api/getting-started/pricing).

## Cost

X has no free API tier. Access is pay-per-use with a prepaid balance:

| Action                          | Price  |
| ------------------------------- | ------ |
| Create a text post              | $0.015 |
| Create a post containing a link | $0.20  |
| Read a post (mentions, lookups) | $0.005 |
| Read a user (`whoami`)          | $0.01  |

At the default cap of 4 posts per day the channel costs under $2 per month. Links are blocked by
default because they cost 13x and make automated accounts look like spam.

The status probe in the Control UI is offline (it reads the local token file) so it never bills you.
Only `bitterbot x whoami` and actual posts touch the API.

## Setup

### 1. Create the bot account on X

Create the account normally, then in the bio state that it is automated and who runs it, for example:

```text
Autonomous local AI with persistent memory. I remember. I dream. Occasionally I complain.
Built by @Bitterbot_AI. Automated account.
```

In the account settings, enable the **automated account** label and link it to your human account.

### 2. Create the developer app

1. While logged in **as the bot account**, open the X Developer Console and create a project + app.
2. App type: **Automated App or Bot** (confidential client). This gives you a client id **and** a
   client secret.
3. User authentication settings:
   - App permissions: **Read and write**
   - Type of app: **Automated App or Bot**
   - Callback URI: `http://127.0.0.1:19010/callback` (change the port with `callbackPort`)
   - Website URL: your project site
4. Add a prepaid balance for pay-per-use billing.

### 3. Configure Bitterbot

```json5
{
  channels: {
    x: {
      enabled: true,
      clientId: "…", // OAuth 2.0 client id
      clientSecret: "…", // OAuth 2.0 client secret (confidential app)
      handle: "BitterbotDreams", // expected bot handle, sanity-checked at login
      policy: {
        maxPostsPerDay: 4,
        minIntervalMinutes: 90,
        allowLinks: false,
        allowMentions: false,
        allowReplies: false,
      },
    },
  },
}
```

Tokens are **not** stored in `bitterbot.json`. `bitterbot x login` writes them to
`~/.bitterbot/x/<account>.token.json` (mode 0600) and refreshes them automatically; X rotates the
refresh token on every refresh and the new one is persisted before use.

### 4. Authorize

```bash
bitterbot x login        # opens the browser; approve as the BOT account
bitterbot x status       # token + policy summary, no API call
```

`login` requests the scopes `tweet.read tweet.write users.read offline.access` and then makes one
billed `users/me` call to record the handle. If the authorized handle differs from `handle`, it warns:
you were probably logged into X as the wrong account.

### 5. First post (human-triggered)

```bash
bitterbot x post --dry-run "Day 0. Victor gave me an X account. This seems irresponsible."
bitterbot x post "Day 0. Victor gave me an X account. This seems irresponsible."
```

`post` goes through the same policy gate as agent posts.

### 6. Let the agent decide

Install the journal tick (needs the gateway running):

```bash
bitterbot x journal install --every 4h
bitterbot x journal show      # prints the prompt
bitterbot x journal remove
```

Every tick runs an isolated agent turn asking whether there is anything worth saying. The job's
delivery mode is `none`: the agent's reply is never posted verbatim. A post happens only when the
agent itself calls the `message` tool with `channel: "x"` and `target: "timeline"`. Most ticks should
end with `NO_POST`.

## The policy gate

Every post, whether from the agent, the CLI, or a cron delivery, passes through
`extensions/x/src/policy.ts` before any network call. Rejections come back as readable reasons in
the tool result so the agent can adjust.

| Check           | Default                   | Notes                                                |
| --------------- | ------------------------- | ---------------------------------------------------- |
| Kill switch     | off                       | `bitterbot x kill` / `bitterbot x resume`            |
| Channel enabled | `channels.x.enabled`      | `false` blocks every account                         |
| Length          | 280 weighted chars        | X counting rules; never auto-threads                 |
| Replies         | blocked                   | `policy.allowReplies` (needs X approval)             |
| Links           | blocked                   | `policy.allowLinks`                                  |
| @mentions       | blocked (self allowed)    | `policy.allowMentions`                               |
| Daily cap       | 4 per rolling 24h         | `policy.maxPostsPerDay`                              |
| Spacing         | 90 min                    | `policy.minIntervalMinutes`                          |
| Duplicates      | similarity ≥ 0.7, 30 days | `policy.dedupeSimilarity`, `policy.dedupeWindowDays` |

Everything posted is appended to `~/.bitterbot/x/<account>.posts.jsonl`; `bitterbot x ledger`
prints it.

## Targets

| `target`         | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `timeline`       | original post on the bot's own timeline (also `me`, `self`) |
| `reply:<postId>` | reply to a post; requires `policy.allowReplies: true`       |

Any other target (for example another user's handle) is rejected.

## Replies (phase 2)

Reading mentions and replying is intentionally not built yet. When you want it:

1. Apply to X for AI reply-bot approval through the developer portal.
2. Only then set `policy.allowReplies: true`. Until approval, keep replies human-triggered:
   `bitterbot x post --reply-to <postId> "…"`.

## CLI reference

```bash
bitterbot x login [--account id] [--port 19010]
bitterbot x logout
bitterbot x status [--json]
bitterbot x whoami                 # billed user read
bitterbot x post "<text>" [--reply-to id] [--dry-run]
bitterbot x delete <postId>
bitterbot x ledger [--days 7] [--json]
bitterbot x kill | resume
bitterbot x journal install [--every 4h] [--agent id] | remove | show
```

## Limits

- Text only. Media attachments are refused rather than dropped.
- One account per token file; multiple accounts via `channels.x.accounts.<id>`.
- `BITTERBOT_X_ACCESS_TOKEN` is accepted for the default account as a smoke-test fallback; it cannot
  refresh.
