---
summary: "Spending and public posts wait for your approval; the gateway carries out what you approve"
read_when:
  - The agent says an action is waiting for approval
  - Deciding what the agent may spend or post without asking
  - Reviewing what the agent did on your behalf
title: "Action Review"
---

# Action review

Some of what the agent can do should not happen without you. Action review holds those actions, asks you, and carries out the ones you approve. The decision and the result are recorded in one place.

## What is reviewed

| Class       | Tool calls                                                                                                       | Default |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ------- |
| `spend`     | `wallet` sending USDC (`send_usdc`, `send_to_peer`) or paying for a resource (`pay_for_resource`)                | ask     |
| `publish`   | `message` posting to the X channel                                                                               | ask     |
| `contact`   | `message` sending to a named recipient the agent has never dealt with                                            | first   |
| `spend`     | `purchase` with `rail: "privacy"`, `action: "request"` (creates a Privacy.com card; no standing grant covers it) | ask     |
| `connector` | Connector (MCP) tools that change something                                                                      | ask     |

Link purchases (`purchase` with the Link rail) are approved in the Link app, not here. A message aimed at `webchat` is sent back to the agent rather than queued: webchat is the Control UI conversation, not a way to reach anyone.

Everything else runs as before. File writes are not reviewed. Shell commands keep their own rules (exec approvals and the sandbox) and are answered from this queue; see [Shell commands](#shell-commands).

### Messages to someone new

When the agent addresses a message to a named recipient (`send`, `reply`, an attachment, a poll, a sticker or a `broadcast` through the `message` tool), the first one to a recipient it has never dealt with waits for you. After you approve it and it is delivered, that recipient is remembered and later messages go straight through.

The agent already knows a recipient when any of these is true:

- they have a session with the agent (they wrote to it, or it wrote to them),
- they are one of your own addresses (`commands.ownerAllowFrom`) or on a channel's `allowFrom` list (the `*` wildcard does not count),
- they were approved through pairing,
- you approved a message to them before.

Never held: a reply in the conversation the agent is already in (no recipient named), reactions, edits, reads and other actions that do not put new content in front of someone, dry runs, and routine heartbeat and cron delivery, which do not go through the `message` tool. A broadcast is held if any one of its recipients is new.

Addresses are compared loosely (`+1 555 010 0100`, `whatsapp:+15550100100` and `15550100100@s.whatsapp.net` are one person). A display name the agent cannot match to an id counts as new: you are asked once, and the approval is remembered under that name.

A standing spend grant that covers the payee and the amount counts as a decision already made: the spend passes without asking and the grant records the usage.

### Paid tasks for other agents

A task sent to another agent with `a2a_client` may come back with a price. Because the price is only known at that point, the hold happens there: the task is not paid for, a request appears in the queue ("Pay 0.30 USDC to 0x... for a task from the agent at ..."), and approving it runs the task again and pays. A standing grant that covers the seller and the amount pays without asking.

### What is not held

Payouts of money already owed to other people (skill royalties, bounty rewards) go out without waiting for you. They pass through the same spend gate as everything else: the per-transaction and daily limits apply, each one is recorded, and you get a notice when a batch goes out or when one is waiting because it is above your per-transaction limit.

The `wallet` and `a2a_client` tools cannot be invoked over the gateway's HTTP `POST /tools/invoke` endpoint. Calls made that way skip the review stage, so they are denied there.

## What happens

1. The agent calls the tool. The call is held before the tool runs; the agent is told the request id and that it must not retry or route around it.
2. You are asked in two places: a card above the chat in the Control UI, and a line in the session's next turn with the id. The Activity tab in the side panel lists everything waiting and everything decided.
3. You decide. In the Control UI, approving a spend asks twice. In chat, reply `/approve <id> allow` or `/approve <id> deny` (the same command exec approvals use; review ids start with `rv-`).
4. If you approve, the gateway performs exactly the stored call itself, with your authority, and records the result. The agent is told the outcome at its next turn. If you deny, the agent is told not to retry.
5. A request nobody decides on expires after 24 hours.

The gateway performs the approved call rather than asking the agent to repeat it: a woken turn is not an owner turn, so it would not have the wallet tool, and what runs should be exactly what you saw.

Asking the same thing again does not create a second request: the agent retrying returns the request that is already waiting.

## Configuration

```json5
{
  review: {
    spend: "ask", // or "allow": only the wallet's numeric caps apply
    publish: "ask", // or "allow": posts go straight out
    contact: "first", // "ask": every named recipient; "allow": none
    connector: "ask", // or "allow": connector writes run unreviewed
    ttlHours: 24, // how long a request waits before it expires (max 720)
  },
}
```

## The payment record

Every outbound payment the spend gate allowed or refused is kept, with the amount, the payee, which route asked for it, the reason it was allowed ("passed review", "approved by the owner", "standing grant ...", "payout of an amount already owed") and what happened. The Activity tab lists them under **Payments**; `bitterbot gateway call review.spends` returns them.

## Where things live

- Requests and decisions: `~/.bitterbot/review.sqlite`, separate from the memory database.
- Gateway methods: `review.list`, `review.get`, `review.resolve`, `review.spends`; events `review.requested`, `review.resolved`. All need `operator.approvals`.

## Connectors

A connector tool that changes something (anything an MCP server does not declare read-only) waits here with the connector, the tool and its arguments. Read-only tools run. See [Connectors](/tools/connectors) for trusting one connector, and `review.connector: "allow"` to turn this off.

## Shell commands

Commands that need approval under [exec approvals](/tools/exec-approvals) show up in the same queue. The exec tool still does the asking and the waiting; the queue is one more place to answer, and the place the answer is recorded.

- The card shows the command, the directory and the host, with **Allow once**, **Always allow** (adds it to the allowlist) and **Deny**.
- `/approve <id> allow-once|allow-always|deny` in chat keeps working, and an answer given there or from another client is recorded in Activity the same way.
- If nobody answers before the exec approval times out, the request closes itself.

Which commands need approval is still decided by the exec approval settings, not by `review.*`.

## Browser handoffs

The same queue carries one request that is not an approval: the agent asking you to take over the browser for a login, a CAPTCHA or a payment confirmation. It shows as a card with **Take over** and **Not now**, and it is recorded in Activity as a `handoff` with how it ended. Taking control of the browser is what accepts it. See [When the agent asks you to take over](/tools/browser#when-the-agent-asks-you-to-take-over).

## Limits today

- Messages are held on first contact only by default; set `review.contact: "ask"` to hold every message to a named recipient. Other publish surfaces besides X are not held.
- The first-contact check knows who the agent has a session with today. With the default `session.dmScope: "main"`, direct messages share one session that remembers only the most recent correspondent, so an older contact with no allow-list entry can be asked about again, once.
- The approved call is run from the gateway's own config, not from inside the original run, so tools that depend on run context are not supported yet (the wallet and X post do not).
- Approval requests are delivered to the Control UI and the session; there is no separate push to a phone.
