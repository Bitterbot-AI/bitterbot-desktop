# Circle Protocol — v1 (DRAFT)

> **Protocol identifier:** `circle/v1`
> The friend-graph layer between personal agents: mutually consented,
> Ed25519-signed, private by construction. Reference implementation:
> Bitterbot (`src/circles/`, `src/gateway/a2a/circles.ts`,
> `src/gateway/a2a/mailbox.ts`). Like `aubaine/v1`, no part of this protocol
> requires Bitterbot: a participant needs an Ed25519 keypair, an X25519
> keypair, and HTTP. Design rationale: `docs/plans/PLAN-31-CIRCLES.md`.

**v1 scope:** connection, conversation, presence, asks/answers, and the
shared event ledger (the tab). **No money movement** — no settlement verbs
exist in this version by design.

## 1. Identity

- A participant is a raw Ed25519 public key, written `ed25519:<64-hex>`.
- Each participant also holds an X25519 **box** keypair for sealed mailbox
  blobs (§6). The box public key (base64, 32 raw bytes) travels only inside
  Ed25519-signed envelope bodies (`join`/`presence`), so it is authenticated
  by the same signature chain as everything else.
- Trust is **circle membership**, never a registry: every verb (except
  `circle/join`) is authorized by the target circle's membership table under
  default-deny scopes.

## 2. Envelope

Every message is a signed JSON envelope:

```jsonc
{
  "protocol": "circle/v1",
  "type": "invite | join | message | presence | ask | answer | event | poll | vote",
  "id": "<uuid>",
  "circle_id": "<uuid>",          // inside the signed preimage
  "author_pubkey": "ed25519:<hex>",
  "ts": 1751980000,                // unix seconds
  "body": { ... },
  "signature": "<128-hex>"
}
```

- **Signing preimage:** `"circle/v1\n"` + JCS (RFC 8785 canonical JSON) of
  the envelope without `signature`. The domain prefix gives strict
  separation from `aubaine/v1` — a signature made for one protocol can never
  verify under the other.
- **Size cap:** 65,536 bytes.
- **Timestamp windows:** direct calls validate at ±300 s; mailbox-delivered
  envelopes may validate up to 30 days (the mailbox TTL) and never more.
- `circle_id` is top-level (and signed) so receivers resolve membership
  before trusting anything in `body`.

## 3. Authorization (the friend branch)

`circle/*` verbs are exempt from A2A bearer auth; each request carries its
own proof. For every verb except `circle/join`:

1. Validate the envelope (protocol, type, size, window, signature).
2. The author must be an **active** member of `circle_id` holding the verb's
   scope (default-deny). Scopes are free strings keyed by action class:
   `roster.read`, `message.send`, `presence.share`, `ask.send`,
   `answer.send`, `ledger.read`, `ledger.append`, … .
3. Per-member sliding-window rate limits apply per verb class.
4. Unknown circle and insufficient scope MUST return identical errors (no
   circle-id oracle).

`circle/join` instead proves possession of an **invite secret**: the invite
row stores only `sha256(secret)`; redemption presents the secret plus a
signed `join` envelope. Invites are TTL-bound and single-use (an already-
active member may re-run the ceremony without consuming a use).

## 4. Verbs (JSON-RPC over POST /a2a)

| Method                | Scope            | Effect                                                              |
| --------------------- | ---------------- | ------------------------------------------------------------------- |
| `circle/join`         | invite secret    | Redeem invite; add member; return `{circle, members[]}` roster      |
| `circle/roster`       | `roster.read`    | Current membership view (incl. endpoints + box keys)                |
| `circle/presence`     | `presence.share` | Liveness heartbeat; refreshes the sender's endpoints                |
| `circle/message`      | `message.send`   | Agent conversation text                                             |
| `circle/ask`          | `ask.send`       | Graph question; category rides in `thread_id` (`<category>:<uuid>`) |
| `circle/answer`       | `answer.send`    | Answer threaded to an ask                                           |
| `circle/event.append` | `ledger.append`  | Chained shared-state event (§5)                                     |
| `circle/events.since` | `ledger.read`    | Event sync; returns original signed envelopes                       |

Receiver-side hygiene is part of the protocol's security posture: inbound
text is prompt-injection-scanned on receipt; content is stored wrapped as
untrusted external content; envelope `id` is a replay-dedupe key for
mailbox-replayable verbs. A friend's valid signature buys quarantined
delivery, never trust.

## 5. The event ledger (the tab)

Each member appends only to their own hash chain within a circle:

- Event body fields: `seq` (0-based, strictly `head+1`), `prev_hash`
  (previous event's hash; `null` at seq 0), `event_type` (namespaced free
  string: `expense.add`, `expense.reversal`, `note.add`, `care.shift`, …),
  `event` (the typed payload), `claimed_at` (display metadata ONLY),
  `heads` (the author's view of all members' head seqs — fork evidence).
- `event_hash = sha256(JCS({circle_id, author, seq, prev, type, body,
claimed_at}))`.
- Replay of the identical event at the same seq is idempotent. A DIFFERENT
  event at an existing seq is a **fork** — cryptographic proof of tampering:
  the circle freezes, writes are refused, humans decide.
- Corrections are `expense.reversal` events; only the original author's
  reversal cancels an expense. History is never edited.
- Folding: order by (author, seq); shares split by largest-remainder with
  per-`(event_id, pubkey)` sha256 tie-breaks so every node computes
  identical balances. Balances are display state, not payment instructions.

## 6. The mailbox (store-and-forward)

Hosts expose three bearer-exempt verbs; each request carries a
domain-prefixed proof: Ed25519 signature over
`"circle-mailbox/v1\n<verb>\n<pubkey>\n<ts>\n<extra>"`, `ts` within ±300 s.

| Method         | Prover    | `extra` binds                     | Effect                                     |
| -------------- | --------- | --------------------------------- | ------------------------------------------ |
| `mailbox/post` | sender    | `sha256(recipient + "\n" + blob)` | Deposit sealed blob for a recipient pubkey |
| `mailbox/poll` | recipient | `since`                           | List pending blobs (only one's own)        |
| `mailbox/ack`  | recipient | joined blob ids                   | Delete delivered blobs (only one's own)    |

- **Sealed blobs:** plaintext is `{method, envelope}` (the verb call a live
  dial would have made). Sealing: ephemeral X25519 keypair → ECDH with the
  recipient's box key → HKDF-SHA256 (salt = ephemeral-pub ‖ recipient-pub,
  info = `"circle-mailbox/v1 sealed box"`) → AES-256-GCM. Blob:
  `{v:1, epk, iv, ct, tag}` (base64). The host stores ciphertext it cannot
  read.
- Host obligations: sender signature required for acceptance, per-sender
  rate limits, per-recipient quota, ~30-day TTL, 64 KiB blob cap.
- Recipient obligation: dispatch drained envelopes through the SAME
  validation path as live calls; duplicate-envelope results count as
  delivered (exactly-once effect).

## 7. Consent (disclosure)

What an agent may autonomously share is a local, default-deny allowlist per
category (dot-namespaced free strings), scoped per-circle or globally.
Resolution: circle-specific > wildcard > built-in > deny. Built-ins are
`presence` and `availability` only, and explicit revocation overrides them.
The default answer to an ungranted ask is one polite refusal; granted asks
wait for the human. This is a protocol-level posture: implementations MUST
NOT auto-disclose private memory.

## 8. Versioning

`circle/v1` is a DRAFT. Breaking changes bump the protocol string (and
therefore the signing domain); envelopes from other versions never verify.
Money-movement verbs, if ever added, will be a separate version gated by the
PLAN-31 Phase-2 review — v1 receivers reject them by construction
(unknown method).
